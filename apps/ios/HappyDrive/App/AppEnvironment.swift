import Foundation
import os
import SwiftUI
import HappyDriveCore

/// アプリ全体で共有するサービス群
@Observable
@MainActor
final class AppEnvironment {
    let config: AppConfig
    let api: HappyDriveAPI
    let queue: OfflineQueue
    let deliveryCache: DeliveryCache
    let network = NetworkMonitor()
    let location: LocationService
    let push = PushService()
    let session: SessionStore
    let router = AppRouter()
    let locationSharing: LocationSharingController

    /// 送信待ちの操作（配送・業務イベント）
    private(set) var pendingMutations: [PendingMutation] = []
    /// 4xx で送信できず破棄された操作（利用者に知らせる）
    var droppedMutations: [DroppedMutation] = []

    init(config: AppConfig = .load()) {
        self.config = config
        let tokenStore = KeychainTokenStore()
        let keyProvider = KeychainKeyProvider()
        let location = LocationService()
        self.location = location

        let sealer = AESGCMSealer(keyProvider: keyProvider)
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("HappyDrive", isDirectory: true)
        let sessionBox = SessionEventBox()
        let client = APIClient(
            baseURL: config.apiBaseURL,
            transport: URLSessionTransport(),
            tokenStore: tokenStore,
            userAgent: "HappyDrive-iOS/\(config.appVersion)",
            onSessionEvent: { event in sessionBox.forward(event) }
        )
        let api = HappyDriveAPI(client: client)
        self.api = api
        self.queue = OfflineQueue(
            storage: FileOfflineQueueStorage(url: support.appendingPathComponent("pending-mutations.bin"), sealer: sealer),
            sender: APIMutationSender(api: api),
            attachments: FileAttachmentStore(directory: support.appendingPathComponent("pending-evidence", isDirectory: true), sealer: sealer)
        )
        self.deliveryCache = DeliveryCache(url: support.appendingPathComponent("delivery-today.bin"), sealer: sealer)
        self.session = SessionStore(api: api)
        self.locationSharing = LocationSharingController(api: api, location: location)

        sessionBox.handler = { [weak session = self.session] event in
            if event == .expired { session?.handleSessionExpired() }
        }
        network.onReconnect = { [weak self] in
            self?.syncPending()
        }
        push.onOpen = { [weak self] link in
            self?.router.open(link)
        }
        push.registerToken = { [api, config] token in
            do {
                try await api.registerDevice(apnsToken: token, environment: config.apnsEnvironment)
            } catch {
                HDLog.error(HDLog.app, "registerDevice", error)
            }
        }
    }

    func start() {
        network.start()
        push.configure()
        Task {
            await queue.addObserver { [weak self] items in
                Task { @MainActor in self?.pendingMutations = items }
            }
        }
    }

    // MARK: オフラインキュー

    /// 保留中の操作を再送（接続回復・アプリ復帰時）
    func syncPending() {
        guard session.isSignedIn else { return }
        Task {
            let report = await queue.replay()
            if !report.dropped.isEmpty {
                droppedMutations.append(contentsOf: report.dropped)
                await queue.clearDropped()
            }
            if !report.sent.isEmpty {
                HDLog.sync.info("synced \(report.sent.count, privacy: .public) pending mutations")
            }
        }
    }

    func pendingCount(entityKey: String) -> Int {
        pendingMutations.filter { $0.entityKey == entityKey }.count
    }

    /// ログアウト：端末登録の解除 → サーバーのリフレッシュトークン失効 → 端末の一時データ消去
    func signOut() async {
        if let token = push.lastToken {
            try? await api.unregisterDevice(apnsToken: token)
        }
        await api.logout()
        await clearLocalData()
        session.markSignedOut()
    }

    /// 退会完了後（サーバー側でトークンは失効済み）
    func finishAccountDeletion() async {
        api.client.tokenStore.clearTokens()
        await clearLocalData()
        session.markSignedOut()
    }

    /// 端末の一時データを消去（送信待ちの操作・配送キャッシュ・位置共有）
    func clearLocalData() async {
        locationSharing.stop()
        await queue.removeAll()
        deliveryCache.clear()
        droppedMutations.removeAll()
        pendingMutations.removeAll()
        UserDefaults.standard.removeObject(forKey: SessionStore.onboardingDeferredKey)
    }
}

/// APIClient（非メインスレッド）からのセッション通知をメインスレッドへ渡す
final class SessionEventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _handler: (@MainActor (SessionEvent) -> Void)?

    var handler: (@MainActor (SessionEvent) -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _handler }
        set { lock.lock(); _handler = newValue; lock.unlock() }
    }

    func forward(_ event: SessionEvent) {
        let h = handler
        Task { @MainActor in h?(event) }
    }
}
