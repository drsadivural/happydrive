import Foundation
import Network
import Observation
import os
import UIKit
import UserNotifications
import HappyDriveCore

/// ログ。個人情報（氏名・住所・電話・トークン・位置）は出力しない。ID 等も .private で記録する。
enum HDLog {
    static let app = Logger(subsystem: "jp.happydrive.driver", category: "app")
    static let api = Logger(subsystem: "jp.happydrive.driver", category: "api")
    static let sync = Logger(subsystem: "jp.happydrive.driver", category: "sync")
    static let location = Logger(subsystem: "jp.happydrive.driver", category: "location")

    static func error(_ logger: Logger, _ context: String, _ error: Error) {
        if let api = error as? APIError {
            logger.error("\(context, privacy: .public) failed status=\(api.status ?? -1, privacy: .public) code=\(api.code ?? "-", privacy: .public) requestId=\(api.requestId ?? "-", privacy: .private)")
        } else {
            logger.error("\(context, privacy: .public) failed: \(String(describing: type(of: error)), privacy: .public)")
        }
    }
}

/// 通信状態の監視（圏外バナーとオフラインキューの再送に使用）
@Observable
@MainActor
final class NetworkMonitor {
    private(set) var isOnline = true
    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private let queue = DispatchQueue(label: "jp.happydrive.network-monitor")
    @ObservationIgnored var onReconnect: (@MainActor () -> Void)?
    @ObservationIgnored private var started = false

    func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in
                self?.update(online: online)
            }
        }
        monitor.start(queue: queue)
    }

    private func update(online: Bool) {
        let wasOffline = !isOnline
        isOnline = online
        if online && wasOffline {
            onReconnect?()
        }
    }
}

/// プッシュ通知（許可は文脈に応じて要求し、APNs トークンを /me/devices に登録）
@MainActor
final class PushService: NSObject, UNUserNotificationCenterDelegate {
    var onOpen: ((DeepLink) -> Void)?
    var registerToken: ((String) async -> Void)?
    private(set) var lastToken: String?

    func configure() {
        UNUserNotificationCenter.current().delegate = self
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// 案件の受諾後など、通知が役立つ場面で呼ぶ
    @discardableResult
    func requestAuthorizationIfNeeded() async -> Bool {
        let status = await authorizationStatus()
        switch status {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
            return true
        case .notDetermined:
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])) ?? false
            if granted { UIApplication.shared.registerForRemoteNotifications() }
            return granted
        default:
            return false
        }
    }

    /// 起動時：既に許可済みなら再登録（トークン更新に追従）
    func refreshRegistrationIfAuthorized() async {
        let status = await authorizationStatus()
        if status == .authorized || status == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        lastToken = hex
        Task { await registerToken?(hex) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let entityType = info["entityType"] as? String
        let entityId = info["entityId"] as? String
        let type = info["type"] as? String
        await MainActor.run {
            if let link = DeepLink.from(entityType: entityType, entityId: entityId, type: type) {
                self.onOpen?(link)
            } else {
                self.onOpen?(.notifications)
            }
        }
    }
}

/// 設定アプリを開く
@MainActor
enum SystemSettings {
    static func open() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }

    static func call(_ phone: String) {
        let digits = phone.filter { $0.isNumber || $0 == "+" }
        if let url = URL(string: "tel:\(digits)") {
            UIApplication.shared.open(url)
        }
    }
}
