import Foundation
import SwiftUI
import UIKit
import HappyDriveCore

/// ログイン状態と利用者情報
@Observable
@MainActor
final class SessionStore {
    enum Phase: Equatable {
        case launching
        case signedOut
        case signedIn
    }

    static let onboardingDeferredKey = "hd.onboardingDeferred"

    private(set) var phase: Phase = .launching
    private(set) var user: User?
    /// 起動時に通信できず利用者情報を取得できていない
    private(set) var userLoadError: String?
    /// ログイン切れで戻った場合の案内
    var sessionExpiredNotice: String?
    /// 登録を後回しにして閲覧中（受諾時に理由を表示する）
    /// （@Observable の追跡対象は保存用プロパティ。didSet の代わりに setter で永続化する）
    var onboardingDeferred: Bool {
        get { onboardingDeferredStorage }
        set {
            onboardingDeferredStorage = newValue
            UserDefaults.standard.set(newValue, forKey: Self.onboardingDeferredKey)
        }
    }
    private var onboardingDeferredStorage: Bool

    @ObservationIgnored private let api: HappyDriveAPI

    init(api: HappyDriveAPI) {
        self.api = api
        self.onboardingDeferredStorage = UserDefaults.standard.bool(forKey: Self.onboardingDeferredKey)
    }

    var isSignedIn: Bool { phase == .signedIn }

    var onboardingStep: OnboardingStep? {
        user.map { OnboardingFlow.nextStep(for: $0) }
    }

    /// 起動時は登録画面を出さずにメイン画面を開く（登録・本人確認はマイページ／受諾時に案内）
    var needsOnboardingScreen: Bool { false }

    /// 端末アカウントへのサインイン中のエラー（再試行ボタンを表示）
    private(set) var signInError: String?
    private(set) var isSigningIn = false

    var acceptBlocker: String? {
        guard let user else { return "利用者情報を読み込めていません。通信状態を確認してください。" }
        return OnboardingFlow.acceptBlocker(for: user)
    }

    func bootstrap() async {
        guard api.client.isLoggedIn else {
            phase = .signedOut
            return
        }
        phase = .signedIn
        await refreshUser()
    }

    /// 電話番号確認なしで、この端末のアカウントにサインイン（初回はアカウントを自動作成）
    func signInWithDevice() async {
        guard !isSigningIn else { return }
        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }
        do {
            let secret = try DeviceCredential.loadOrCreate()
            let result = try await api.deviceLogin(secret: secret, deviceName: Self.deviceName)
            signedIn(result)
        } catch {
            signInError = error.hdUserMessage
            HDLog.error(HDLog.app, "deviceLogin", error)
            phase = .signedOut
        }
    }

    func refreshUser() async {
        do {
            user = try await api.me()
            userLoadError = nil
        } catch let error as APIError where error == .sessionExpired {
            handleSessionExpired()
        } catch {
            userLoadError = error.hdUserMessage
            HDLog.error(HDLog.app, "me", error)
        }
    }

    func signedIn(_ result: AuthResult) {
        user = result.user
        userLoadError = nil
        sessionExpiredNotice = nil
        if result.isNewUser { onboardingDeferred = false }
        phase = .signedIn
    }

    /// サーバーが返した最新の利用者情報で更新（プロフィール保存後など）
    func update(_ user: User) {
        self.user = user
    }

    /// 顧客・供給者のセッション切れでは本人の電話番号による再認証を要求する。
    func handleSessionExpired() {
        guard phase == .signedIn else { return }
        user = nil
        sessionExpiredNotice = "ログインの有効期限が切れました。もう一度ログインしてください。"
        phase = .signedOut
    }

    func markSignedOut() {
        user = nil
        onboardingDeferred = false
        phase = .signedOut
    }

    static var deviceName: String {
        UIDevice.current.model
    }
}
