import Foundation

/// 業務画面の次の操作
public enum WorkflowAction: Hashable, Sendable {
    case waitForApproval            // reserved（発注者承認待ち）
    case startTravel                // accepted → traveling
    case checkIn                    // traveling → checked_in（位置必須）
    case startWork                  // checked_in → working
    case completeStep(index: Int)   // working 中の未完了手順
    case submitReport               // すべての手順完了 → submitted
    case resubmit                   // needs_revision → 再提出
    case awaitReview                // submitted
    case rate                       // 検収後・未評価
    case done
    case none
}

public struct AssignmentProgress: Sendable, Hashable {
    public var completedSteps: Int
    public var totalSteps: Int
    public var nextAction: WorkflowAction

    public var fractionComplete: Double {
        totalSteps == 0 ? 0 : Double(completedSteps) / Double(totalSteps)
    }

    /// "進行状況 3 / 5"
    public var label: String { "進行状況 \(completedSteps) / \(totalSteps)" }

    public init(assignment: Assignment) {
        let steps = assignment.steps ?? []
        completedSteps = steps.filter(\.completed).count
        totalSteps = steps.count
        switch assignment.state {
        case .reserved: nextAction = .waitForApproval
        case .accepted: nextAction = .startTravel
        case .traveling: nextAction = .checkIn
        case .checked_in: nextAction = .startWork
        case .working:
            if let next = steps.sorted(by: { $0.index < $1.index }).first(where: { !$0.completed }) {
                nextAction = .completeStep(index: next.index)
            } else {
                nextAction = .submitReport
            }
        case .needs_revision: nextAction = .resubmit
        case .submitted, .disputed: nextAction = .awaitReview
        case .approved, .payable, .paid:
            nextAction = assignment.myRatingSubmitted == true ? .done : .rate
        case .cancelled, .declined, .expired, .no_show, .refunded: nextAction = .done
        case .unknown: nextAction = .none
        }
    }

    public var primaryButtonTitle: String? {
        switch nextAction {
        case .startTravel: return "移動を開始する"
        case .checkIn: return "現地でチェックイン"
        case .startWork: return "業務を開始する"
        case .completeStep: return "この手順を完了にする"
        case .submitReport: return "完了報告へ進む"
        case .resubmit: return "修正して再提出する"
        case .rate: return "発注者を評価する"
        default: return nil
        }
    }
}

/// 報告に必要な写真枚数の不足（0 なら送信可能）
public enum ReportRequirements {
    public static func missingPhotoCount(minPhotoCount: Int?, attached: Int, alreadyUploaded: Int = 0) -> Int {
        max(0, (minPhotoCount ?? 0) - attached - alreadyUploaded)
    }

    public static func missingStepPhotos(steps: [AssignmentStep], photosByStep: [Int: Int]) -> [Int] {
        steps.filter { ($0.requiresPhoto ?? false) && (photosByStep[$0.index] ?? 0) == 0 && !$0.completed }.map(\.index)
    }
}

/// 受諾 409/403 の扱い
public enum AcceptFailureResolution: Equatable, Sendable {
    /// 満員 → 空き待ちを提案
    case offerWaitlist(message: String)
    /// 条件が変わった → 再読込して再確認
    case reloadTerms(message: String)
    /// 資格等を満たさない → 理由を表示
    case notEligible(message: String, reasons: [String])
    /// すでに受諾済み（同じキーの再送等）→ 割当を開く
    case alreadyAccepted(message: String, assignmentId: String?)
    /// 登録未完了
    case onboardingIncomplete(message: String)
    case other(message: String)

    public init(error: APIError) {
        let message = error.userMessage
        switch error.code {
        case "capacity_full", "job_full", "filled":
            self = .offerWaitlist(message: message)
        case "terms_changed":
            self = .reloadTerms(message: message)
        case "not_eligible", "skill_required", "schedule_conflict":
            let reasons = error.details?["reasons"]?.stringArray
                ?? error.details?["ineligibleReasons"]?.stringArray
                ?? []
            self = .notEligible(message: message, reasons: reasons)
        case "already_accepted", "duplicate_assignment":
            self = .alreadyAccepted(message: message, assignmentId: error.details?["assignmentId"]?.stringValue)
        case "onboarding_incomplete", "verification_required", "not_verified":
            self = .onboardingIncomplete(message: message)
        default:
            self = .other(message: message)
        }
    }
}

/// 位置関係の計算
public enum Geo {
    /// 2 点間の距離（メートル、haversine）
    public static func distanceMeters(_ a: GeoPoint, _ b: GeoPoint) -> Double {
        let r = 6_371_000.0
        let dLat = (b.latitude - a.latitude) * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let lat1 = a.latitude * .pi / 180, lat2 = b.latitude * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * asin(min(1, sqrt(h)))
    }
}

/// チェックイン可否の事前判定（最終判定はサーバー）
public enum CheckInEvaluation: Equatable, Sendable {
    case ok(distanceMeters: Double)
    case tooFar(distanceMeters: Double, radiusMeters: Int)
    case tooEarly(opensAt: Date)
    case locationUnavailable
    case jobLocationUnknown

    public static func evaluate(current: GeoPoint?, accuracyMeters: Double?, job: AssignmentJobSummary, now: Date) -> CheckInEvaluation {
        let opensAt = job.startsAt.addingTimeInterval(-30 * 60)
        if now < opensAt { return .tooEarly(opensAt: opensAt) }
        guard let current else { return .locationUnavailable }
        guard let target = job.location else { return .jobLocationUnknown }
        let d = Geo.distanceMeters(current, target)
        let radius = job.checkInRadiusMeters ?? 200
        // 端末の測位誤差分は許容してサーバーに判断を委ねる
        if d - (accuracyMeters ?? 0) > Double(radius) {
            return .tooFar(distanceMeters: d, radiusMeters: radius)
        }
        return .ok(distanceMeters: d)
    }

    public var message: String {
        switch self {
        case .ok(let d): return "現地から約\(HDFormat.meters(d))です。チェックインできます。"
        case .tooFar(let d, let r): return "現地まで約\(HDFormat.meters(d))あります。\(r)m以内に近づいてからチェックインしてください。"
        case .tooEarly(let t): return "チェックインは開始30分前（\(HDFormat.time(t))）から可能です。"
        case .locationUnavailable: return "現在地を取得できません。位置情報の利用を許可してください。"
        case .jobLocationUnknown: return "集合場所の位置が未登録です。サーバーで判定します。"
        }
    }
}

/// 通知タップ・プッシュからの遷移先
public enum DeepLink: Hashable, Sendable {
    case assignment(String)
    case assignmentChat(String)
    case job(String)
    case stop(String)
    case earnings
    case notifications
    case verification
    case supportTickets

    /// entityType/entityId（通知一覧・プッシュの userInfo 共通）から遷移先を決める
    public static func from(entityType: String?, entityId: String?, type: String? = nil) -> DeepLink? {
        let t = (entityType ?? "").lowercased()
        switch t {
        case "assignment":
            guard let id = entityId else { return .notifications }
            if let type, type.contains("message") { return .assignmentChat(id) }
            return .assignment(id)
        case "message":
            if let id = entityId { return .assignmentChat(id) }
            return .notifications
        case "job":
            return entityId.map { .job($0) } ?? .notifications
        case "stop", "delivery_stop":
            return entityId.map { .stop($0) } ?? .notifications
        case "earning", "payout", "ledger":
            return .earnings
        case "user", "verification":
            return .verification
        case "support_ticket", "ticket", "appeal":
            return .supportTickets
        default:
            if let type {
                if type.hasPrefix("payout") || type.hasPrefix("earning") { return .earnings }
                if type.hasPrefix("verification") { return .verification }
            }
            return nil
        }
    }

    /// APNs userInfo（{"entityType": "...", "entityId": "...", "type": "..."}）
    public static func from(userInfo: [AnyHashable: Any]) -> DeepLink? {
        from(entityType: userInfo["entityType"] as? String, entityId: userInfo["entityId"] as? String, type: userInfo["type"] as? String)
    }
}
