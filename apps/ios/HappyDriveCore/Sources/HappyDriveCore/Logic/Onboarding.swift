import Foundation

/// 登録手順の進行（UI に依存しない判定）
public enum OnboardingStep: Hashable, Sendable {
    case terms
    case profile
    case vehicle
    case bankAccount
    case identityDocument
    case verificationPending
    case verificationRejected(note: String?)
    case complete

    public var title: String {
        switch self {
        case .terms: return "利用規約への同意"
        case .profile: return "本人情報"
        case .vehicle: return "車両情報"
        case .bankAccount: return "振込先口座"
        case .identityDocument: return "本人確認書類"
        case .verificationPending: return "審査中"
        case .verificationRejected: return "再提出が必要です"
        case .complete: return "登録完了"
        }
    }

    /// 進捗表示用の番号（1〜5）。審査段階は 5。
    public var number: Int {
        switch self {
        case .terms: return 1
        case .profile: return 2
        case .vehicle: return 3
        case .bankAccount: return 4
        default: return 5
        }
    }

    public static let totalInputSteps = 5
}

public enum OnboardingFlow {
    /// 次に表示すべき手順。onboardingSteps があればそれを優先し、なければ各項目の有無から推定する。
    public static func nextStep(for user: User) -> OnboardingStep {
        let s = user.onboardingSteps
        let termsDone = s?.terms ?? (user.termsAccepted ?? false)
        if !termsDone { return .terms }
        let profileDone = s?.profile ?? (user.profile?.legalName?.isEmpty == false)
        if !profileDone { return .profile }
        let vehicleDone = s?.vehicle ?? (user.vehicle != nil)
        if !vehicleDone { return .vehicle }
        let bankDone = s?.bankAccount ?? (user.bankAccount?.accountNumberLast4 != nil)
        if !bankDone { return .bankAccount }
        switch user.verificationStatus {
        case .verified: return .complete
        case .pending: return .verificationPending
        case .rejected: return .verificationRejected(note: user.verificationNote)
        case .unsubmitted, .unknown:
            if s?.verification == true { return .verificationPending }
            return .identityDocument
        }
    }

    /// 入力が必要な手順（審査待ち・完了は含めない）の一覧と完了状況
    public static func checklist(for user: User) -> [(step: OnboardingStep, done: Bool)] {
        let s = user.onboardingSteps
        return [
            (.terms, s?.terms ?? (user.termsAccepted ?? false)),
            (.profile, s?.profile ?? (user.profile?.legalName?.isEmpty == false)),
            (.vehicle, s?.vehicle ?? (user.vehicle != nil)),
            (.bankAccount, s?.bankAccount ?? (user.bankAccount?.accountNumberLast4 != nil)),
            (.identityDocument, user.verificationStatus == .verified || user.verificationStatus == .pending || s?.verification == true),
        ]
    }

    /// 案件を受諾できない理由（受諾できる場合は nil）
    public static func acceptBlocker(for user: User) -> String? {
        if user.suspended == true {
            return "アカウントが一時停止中のため受諾できません。サポートへお問い合わせください。"
        }
        switch nextStep(for: user) {
        case .complete:
            return nil
        case .verificationPending:
            return "本人確認の審査中です。承認されると受諾できるようになります。"
        case .verificationRejected:
            return "本人確認書類の再提出が必要です。マイページから提出してください。"
        case .terms, .profile, .vehicle, .bankAccount, .identityDocument:
            return "登録が完了していないため受諾できません。残りの登録手続きを完了してください。"
        }
    }
}

/// 確認コード再送信までの残り時間
public struct OTPResendCountdown: Sendable, Hashable {
    public var sentAt: Date
    public var resendAfterSeconds: Int
    public var expiresAt: Date

    public init(sentAt: Date, result: OTPRequestResult) {
        self.sentAt = sentAt
        self.resendAfterSeconds = result.resendAfterSeconds
        self.expiresAt = result.expiresAt
    }

    public func remainingSeconds(now: Date) -> Int {
        let elapsed = now.timeIntervalSince(sentAt)
        return max(0, Int((Double(resendAfterSeconds) - elapsed).rounded(.up)))
    }

    public func canResend(now: Date) -> Bool { remainingSeconds(now: now) == 0 }

    public func isExpired(now: Date) -> Bool { now >= expiresAt }
}
