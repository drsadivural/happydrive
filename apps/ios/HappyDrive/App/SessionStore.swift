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

    /// 登録画面を全画面で出すべきか（規約同意は必須。その他は後回し可）
    var needsOnboardingScreen: Bool {
        guard let step = onboardingStep else { return false }
        switch step {
        case .complete: return false
        case .terms: return true
        default: return !onboardingDeferred
        }
    }

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

    func handleSessionExpired() {
        guard phase == .signedIn else { return }
        user = nil
        sessionExpiredNotice = APIError.sessionExpired.userMessage
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
