import Foundation

public enum JobCategory: String, UnknownCaseRepresentable, CaseIterable {
    case elderly_watch, life_support, shopping_assist, corporate_task, community_info, delivery_related, personal_care, healthcare
    case unknown
    public static var unknownCase: JobCategory { .unknown }
    /// 検索画面のカテゴリ（要資格で公開不可のカテゴリは出さない）
    public static var searchable: [JobCategory] {
        [.life_support, .elderly_watch, .shopping_assist, .corporate_task, .community_info, .delivery_related]
    }
}

public enum ContractType: String, UnknownCaseRepresentable, CaseIterable {
    case employment, contractor, other_legal_review
    case unknown
    public static var unknownCase: ContractType { .unknown }
}

public enum JobStatus: String, UnknownCaseRepresentable, CaseIterable {
    case draft, pending_review, published, filled, expired, cancelled, rejected, completed
    case unknown
    public static var unknownCase: JobStatus { .unknown }
}

public struct CancellationPolicy: Codable, Sendable, Hashable {
    public var freeCancelHoursBefore: Int
    public var lateCancelCompensationPercent: Int
    public var text: String
}

public struct JobStep: Codable, Sendable, Hashable {
    public var title: String
    public var description: String?
    public var requiresPhoto: Bool?
}

/// 契約: Job（JobPublic + 利用者別の付加情報）
public struct Job: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var organizationId: String
    public var organizationName: String
    public var organizationVerified: Bool?
    public var organizationAddress: String?
    public var organizationContact: String?
    public var title: String
    public var category: JobCategory
    public var contractType: ContractType
    public var status: JobStatus
    public var startsAt: Date
    public var endsAt: Date
    public var amountYen: Int
    public var expensesReimbursedYen: Int?
    public var workerBorneCostsNote: String?
    public var capacity: Int
    public var remainingCapacity: Int
    public var areaLabel: String
    public var approximateLocation: GeoPoint?
    public var distanceKm: Double?
    public var description: String
    public var requiredSkills: [String]
    public var requiredSkillNames: [String]?
    public var cancellationPolicy: CancellationPolicy
    public var steps: [JobStep]
    public var minPhotoCount: Int?
    public var requiresOrgApproval: Bool?
    public var meetingPointNote: String?
    public var safetyNotes: String?
    public var contactName: String?
    public var paymentTermsText: String?
    public var employmentTermsText: String?
    public var durationMinutes: Int?
    public var publishedAt: Date?
    public var termsHash: String?
    // 利用者別
    public var matchReasons: [String]?
    public var matchScore: Double?
    public var eligible: Bool?
    public var ineligibleReasons: [String]?
    public var isFavorite: Bool?
    public var waitlisted: Bool?
    public var myAssignmentId: String?

    /// 所要時間（分）。durationMinutes が無ければ開始/終了から算出。
    public var effectiveDurationMinutes: Int {
        if let d = durationMinutes { return d }
        return max(0, Int(endsAt.timeIntervalSince(startsAt) / 60))
    }

    public var isFull: Bool { remainingCapacity <= 0 }
}

public struct JobSearchPage: Codable, Sendable, Hashable {
    public var items: [Job]
    public var nextCursor: String?
}

public enum JobSort: String, Codable, Sendable, CaseIterable {
    case recommended, distance, starts_at, amount
}

/// GET /jobs のクエリ
public struct JobSearchQuery: Sendable, Hashable {
    public var latitude: Double?
    public var longitude: Double?
    public var radiusKm: Double?
    public var areaQuery: String?
    public var q: String?
    public var category: JobCategory?
    public var date: CalendarDateString?
    public var startAfterHour: Int?
    public var minAmountYen: Int?
    public var eligibleOnly: Bool?
    public var favoritesOnly: Bool?
    public var sort: JobSort?
    public var cursor: String?
    public var limit: Int?

    public init() {}

    public var queryItems: [QueryItem] {
        var items: [QueryItem] = []
        func add(_ name: String, _ value: String?) {
            if let value, !value.isEmpty { items.append(QueryItem(name, value)) }
        }
        if let latitude, let longitude {
            add("latitude", Self.coordinateString(latitude))
            add("longitude", Self.coordinateString(longitude))
        }
        if let radiusKm { add("radiusKm", Self.decimalString(min(max(radiusKm, 0.5), 100))) }
        // 位置がない場合のみ手動エリア検索を使う
        if latitude == nil || longitude == nil {
            add("areaQuery", areaQuery?.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        add("q", q?.trimmingCharacters(in: .whitespacesAndNewlines))
        add("category", category?.rawValue)
        add("date", date)
        if let startAfterHour { add("startAfterHour", String(min(max(startAfterHour, 0), 23))) }
        if let minAmountYen, minAmountYen > 0 { add("minAmountYen", String(minAmountYen)) }
        if eligibleOnly == true { add("eligibleOnly", "true") }
        if favoritesOnly == true { add("favoritesOnly", "true") }
        add("sort", sort?.rawValue)
        add("cursor", cursor)
        if let limit { add("limit", String(min(max(limit, 1), 50))) }
        return items
    }

    /// 募集段階では粗い位置で十分なため小数3桁（約100m）に丸める。
    static func coordinateString(_ v: Double) -> String {
        String(format: "%.3f", v)
    }

    static func decimalString(_ v: Double) -> String {
        if v == v.rounded() { return String(Int(v)) }
        return String(format: "%.1f", v)
    }
}

public struct AcceptJobBody: Codable, Sendable, Hashable {
    public var termsHash: String?
    public init(termsHash: String?) { self.termsHash = termsHash }
}

public enum AssignmentState: String, UnknownCaseRepresentable, CaseIterable {
    case reserved, accepted, traveling, checked_in, working, submitted, needs_revision, approved, payable, paid, cancelled, declined, expired, no_show, disputed, refunded
    case unknown
    public static var unknownCase: AssignmentState { .unknown }

    /// 位置共有を許可する状態（契約: traveling/checked_in/working のみ）
    public var allowsLocationSharing: Bool {
        self == .traveling || self == .checked_in || self == .working
    }

    /// 進行中（業務画面を開くべき）状態
    public var isActive: Bool {
        switch self {
        case .accepted, .traveling, .checked_in, .working, .needs_revision: return true
        default: return false
        }
    }

    public var isFinished: Bool {
        switch self {
        case .approved, .payable, .paid, .cancelled, .declined, .expired, .no_show, .refunded: return true
        default: return false
        }
    }
}

public struct AssignmentJobSummary: Codable, Sendable, Hashable {
    public var title: String
    public var category: JobCategory
    public var contractType: ContractType?
    public var startsAt: Date
    public var endsAt: Date
    public var organizationId: String?
    public var organizationName: String
    public var areaLabel: String?
    public var address: String?
    public var location: GeoPoint?
    public var checkInRadiusMeters: Int?
    public var meetingPointNote: String?
    public var safetyNotes: String?
    public var minPhotoCount: Int?
}

public struct AssignmentStep: Codable, Sendable, Hashable, Identifiable {
    public var index: Int
    public var title: String
    public var description: String?
    public var requiresPhoto: Bool?
    public var completed: Bool
    public var completedAt: Date?
    public var id: Int { index }
}

public struct TimelineEntry: Codable, Sendable, Hashable {
    public var eventType: String
    public var at: Date
    public var actorRole: String?
    public var reason: String?
}

public struct AssignmentEarning: Codable, Sendable, Hashable {
    public var state: String?
    public var amountYen: Int?
    public var scheduledPayoutDate: CalendarDateString?
}

public struct Assignment: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var jobId: String
    public var workerId: String
    public var workerDisplayName: String?
    public var workerRatingAverage: Double?
    public var state: AssignmentState
    public var acceptedAmountYen: Int?
    public var acceptedAt: Date?
    public var reservationExpiresAt: Date?
    public var termsSnapshot: [String: JSONValue]?
    public var job: AssignmentJobSummary?
    public var steps: [AssignmentStep]?
    public var checkedInAt: Date?
    public var workStartedAt: Date?
    public var submittedAt: Date?
    public var completedAt: Date?
    public var reportNote: String?
    public var reviewReason: String?
    public var evidence: [Evidence]?
    public var timeline: [TimelineEntry]?
    public var earning: AssignmentEarning?
    public var myRatingSubmitted: Bool?
    public var lateCancellation: Bool?

    public init(id: String, jobId: String, workerId: String, state: AssignmentState) {
        self.id = id
        self.jobId = jobId
        self.workerId = workerId
        self.state = state
    }
}

public enum AssignmentScope: String, Sendable, CaseIterable {
    case active, upcoming, history, all
}

public enum AssignmentEventType: String, Codable, Sendable, CaseIterable {
    case traveling, checked_in, working, step_completed, submitted, cancelled, safety_alert, help_requested
}

public struct AssignmentEventRequest: Codable, Sendable, Hashable {
    public var eventType: AssignmentEventType
    public var stepIndex: Int?
    public var evidenceIds: [String]?
    public var note: String?
    public var location: GeoPoint?
    public var occurredAt: Date?

    public init(eventType: AssignmentEventType, stepIndex: Int? = nil, evidenceIds: [String]? = nil, note: String? = nil, location: GeoPoint? = nil, occurredAt: Date? = nil) {
        self.eventType = eventType
        self.stepIndex = stepIndex
        self.evidenceIds = evidenceIds
        self.note = note
        self.location = location
        self.occurredAt = occurredAt
    }
}

public struct LocationShareBody: Codable, Sendable, Hashable {
    public var location: GeoPoint
    public var accuracyMeters: Double?
    public init(location: GeoPoint, accuracyMeters: Double?) {
        self.location = location
        self.accuracyMeters = accuracyMeters.map { max(0, $0) }
    }
}

public struct RatingBody: Codable, Sendable, Hashable {
    public var score: Int
    public var comment: String?
    public init(score: Int, comment: String?) {
        self.score = min(max(score, 1), 5)
        self.comment = comment
    }
}

public struct HomeSummary: Codable, Sendable, Hashable {
    public var todayStopCount: Int
    public var todayCompletedStopCount: Int
    public var todayRoute: Route?
    public var todayAssignments: [Assignment]
    public var expectedEarningsYen: Int
    public var unreadNotificationCount: Int
    public var nearbyJobs: [Job]
    public var onboardingComplete: Bool?
}
