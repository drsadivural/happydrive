import Foundation

public enum StopStatus: String, UnknownCaseRepresentable, CaseIterable {
    case draft, ready, en_route, arrived, delivered, failed, deferred
    case unknown
    public static var unknownCase: StopStatus { .unknown }

    /// 完了系（これ以上の配送操作が不要）
    public var isTerminal: Bool {
        switch self {
        case .delivered, .failed, .deferred: return true
        default: return false
        }
    }

    /// 配送先の編集が可能な状態（契約: draft/ready のみ編集可）
    public var isEditable: Bool { self == .draft || self == .ready }
}

public enum StopSource: String, Codable, Sendable, CaseIterable {
    case manual, csv, ocr
}

public struct Stop: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var status: StopStatus
    public var address: String
    public var scheduledDate: CalendarDateString
    public var location: GeoPoint?
    public var hasLocation: Bool
    public var timeWindowStart: Date?
    public var timeWindowEnd: Date?
    public var note: String?
    public var recipientName: String?
    public var hasRecipientPhone: Bool
    public var packageNumber: String?
    public var priority: Int
    public var serviceMinutes: Int
    public var sequence: Int?
    public var estimatedArrivalAt: Date?
    public var failureReason: String?
    public var failureNote: String?
    public var deferredUntil: Date?
    public var handoff: String?
    public var completedAt: Date?
    public var evidenceIds: [String]?
    public var duplicateOfStopId: String?
    public var version: Int
    public var source: String?

    public init(id: String, status: StopStatus, address: String, scheduledDate: CalendarDateString, location: GeoPoint? = nil, hasLocation: Bool, priority: Int = 0, serviceMinutes: Int = 0, hasRecipientPhone: Bool = false, version: Int = 1) {
        self.id = id
        self.status = status
        self.address = address
        self.scheduledDate = scheduledDate
        self.location = location
        self.hasLocation = hasLocation
        self.priority = priority
        self.serviceMinutes = serviceMinutes
        self.hasRecipientPhone = hasRecipientPhone
        self.version = version
    }
}

public struct NewStop: Codable, Sendable, Hashable {
    public var address: String
    public var scheduledDate: CalendarDateString
    public var location: GeoPoint?
    public var timeWindowStart: Date?
    public var timeWindowEnd: Date?
    public var note: String?
    public var recipientName: String?
    public var recipientPhone: String?
    public var packageNumber: String?
    public var priority: Int?
    public var serviceMinutes: Int?
    public var source: StopSource?
    public var allowDuplicate: Bool?

    public init(address: String, scheduledDate: CalendarDateString, location: GeoPoint? = nil, timeWindowStart: Date? = nil, timeWindowEnd: Date? = nil, note: String? = nil, recipientName: String? = nil, recipientPhone: String? = nil, packageNumber: String? = nil, priority: Int? = nil, serviceMinutes: Int? = nil, source: StopSource? = nil, allowDuplicate: Bool? = nil) {
        self.address = address
        self.scheduledDate = scheduledDate
        self.location = location
        self.timeWindowStart = timeWindowStart
        self.timeWindowEnd = timeWindowEnd
        self.note = note
        self.recipientName = recipientName
        self.recipientPhone = recipientPhone
        self.packageNumber = packageNumber
        self.priority = priority
        self.serviceMinutes = serviceMinutes
        self.source = source
        self.allowDuplicate = allowDuplicate
    }
}

/// PATCH /delivery/stops/{id}。null を送ると値を消去する項目は Nullable で表す。
public struct StopUpdate: Encodable, Sendable, Hashable {
    public var version: Int
    public var address: String?
    public var location: GeoPoint?
    public var timeWindowStart: Nullable<Date> = .unchanged
    public var timeWindowEnd: Nullable<Date> = .unchanged
    public var note: Nullable<String> = .unchanged
    public var recipientName: Nullable<String> = .unchanged
    public var recipientPhone: Nullable<String> = .unchanged
    public var packageNumber: Nullable<String> = .unchanged
    public var priority: Int?
    public var serviceMinutes: Int?

    public init(version: Int) { self.version = version }

    enum CodingKeys: String, CodingKey {
        case version, address, location, timeWindowStart, timeWindowEnd, note, recipientName, recipientPhone, packageNumber, priority, serviceMinutes
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version)
        try c.encodeIfPresent(address, forKey: .address)
        try c.encodeIfPresent(location, forKey: .location)
        try c.encode(timeWindowStart, forKey: .timeWindowStart)
        try c.encode(timeWindowEnd, forKey: .timeWindowEnd)
        try c.encode(note, forKey: .note)
        try c.encode(recipientName, forKey: .recipientName)
        try c.encode(recipientPhone, forKey: .recipientPhone)
        try c.encode(packageNumber, forKey: .packageNumber)
        try c.encodeIfPresent(priority, forKey: .priority)
        try c.encodeIfPresent(serviceMinutes, forKey: .serviceMinutes)
    }
}

public struct StopContact: Codable, Sendable, Hashable {
    public var recipientPhone: String
    public var recipientName: String?
}

public struct StopImportRequest: Codable, Sendable, Hashable {
    public var scheduledDate: CalendarDateString
    public var csv: String
    public var dryRun: Bool?
    public var skipDuplicates: Bool?

    public init(scheduledDate: CalendarDateString, csv: String, dryRun: Bool?, skipDuplicates: Bool?) {
        self.scheduledDate = scheduledDate
        self.csv = csv
        self.dryRun = dryRun
        self.skipDuplicates = skipDuplicates
    }
}

public struct StopImportDuplicate: Codable, Sendable, Hashable {
    public var row: Int
    public var address: String
    public var existingStopId: String?
    public var duplicateOfRow: Int?
}

public struct StopImportRowError: Codable, Sendable, Hashable {
    public var row: Int
    public var message: String
}

public struct StopImportResult: Codable, Sendable, Hashable {
    public var dryRun: Bool
    public var created: [Stop]
    public var valid: Int?
    public var duplicates: [StopImportDuplicate]
    public var errors: [StopImportRowError]
}

public struct RouteBreakRequest: Codable, Sendable, Hashable {
    public var earliestStart: Date
    public var latestStart: Date
    public var durationMinutes: Int

    public init(earliestStart: Date, latestStart: Date, durationMinutes: Int) {
        self.earliestStart = earliestStart
        self.latestStart = latestStart
        self.durationMinutes = durationMinutes
    }
}

public struct RouteRequest: Codable, Sendable, Hashable {
    public var date: CalendarDateString
    public var stopIds: [String]
    public var startLocation: GeoPoint?
    public var endLocation: GeoPoint?
    public var departureAt: Date?
    public var breaks: [RouteBreakRequest]?
    public var averageSpeedKmh: Double?

    public init(date: CalendarDateString, stopIds: [String], startLocation: GeoPoint? = nil, endLocation: GeoPoint? = nil, departureAt: Date? = nil, breaks: [RouteBreakRequest]? = nil, averageSpeedKmh: Double? = nil) {
        self.date = date
        self.stopIds = stopIds
        self.startLocation = startLocation
        self.endLocation = endLocation
        self.departureAt = departureAt
        self.breaks = breaks
        self.averageSpeedKmh = averageSpeedKmh
    }
}

public enum RouteStatus: String, UnknownCaseRepresentable {
    case planned, in_progress, completed
    case unknown
    public static var unknownCase: RouteStatus { .unknown }
}

public enum TravelTimeSource: String, UnknownCaseRepresentable {
    case estimated, provider
    case unknown
    public static var unknownCase: TravelTimeSource { .unknown }
}

public enum RouteViolationType: String, UnknownCaseRepresentable {
    case time_window_late, break_unplaced, priority_late
    case unknown
    public static var unknownCase: RouteViolationType { .unknown }
}

public struct RouteViolation: Codable, Sendable, Hashable {
    public var stopId: String
    public var type: RouteViolationType
    public var message: String
    public var minutes: Int?
}

public struct RouteLeg: Codable, Sendable, Hashable {
    public var stopId: String
    public var arrivalAt: Date
    public var departureAt: Date
    public var travelMinutes: Int
    public var distanceKm: Double
    public var waitMinutes: Int?
    public var lateMinutes: Int?
}

public struct RouteBreak: Codable, Sendable, Hashable {
    public var startAt: Date
    public var durationMinutes: Int
    public var afterStopId: String?
}

public struct Route: Codable, Sendable, Hashable, Identifiable {
    public var id: String?
    public var date: CalendarDateString?
    public var status: RouteStatus?
    public var orderedStopIds: [String]
    public var estimatedMinutes: Int
    public var totalDistanceKm: Double?
    public var feasible: Bool
    public var warnings: [String]?
    public var violations: [RouteViolation]?
    public var legs: [RouteLeg]?
    public var breaks: [RouteBreak]?
    public var travelTimeSource: TravelTimeSource?
    public var departureAt: Date?
    public var startLocation: GeoPoint?
    public var createdAt: Date?
    public var manuallyOrdered: Bool?

    public init(id: String?, orderedStopIds: [String], estimatedMinutes: Int, feasible: Bool) {
        self.id = id
        self.orderedStopIds = orderedStopIds
        self.estimatedMinutes = estimatedMinutes
        self.feasible = feasible
    }
}

public struct ReorderRequest: Codable, Sendable, Hashable {
    public var orderedStopIds: [String]
    public init(orderedStopIds: [String]) { self.orderedStopIds = orderedStopIds }
}

public enum StopEventType: String, Codable, Sendable, CaseIterable {
    case en_route, arrived, delivered, failed, deferred
}

public enum FailureReason: String, Codable, Sendable, CaseIterable {
    case absent, address_unknown, refused, damaged, access_denied, time_window_missed, other
}

public enum HandoffType: String, Codable, Sendable, CaseIterable {
    case in_person, safe_place, delivery_box, neighbor
}

public struct StopEventRequest: Codable, Sendable, Hashable {
    public var eventType: StopEventType
    public var failureReason: FailureReason?
    public var failureNote: String?
    public var deferredUntil: Date?
    public var handoff: HandoffType?
    public var evidenceIds: [String]?
    public var location: GeoPoint?
    public var occurredAt: Date?

    public init(eventType: StopEventType, failureReason: FailureReason? = nil, failureNote: String? = nil, deferredUntil: Date? = nil, handoff: HandoffType? = nil, evidenceIds: [String]? = nil, location: GeoPoint? = nil, occurredAt: Date? = nil) {
        self.eventType = eventType
        self.failureReason = failureReason
        self.failureNote = failureNote
        self.deferredUntil = deferredUntil
        self.handoff = handoff
        self.evidenceIds = evidenceIds
        self.location = location
        self.occurredAt = occurredAt
    }

    /// 契約上の必須項目を送信前に検査する（failed/deferred は理由必須、deferred は日時必須）。
    public func validationError() -> String? {
        switch eventType {
        case .failed:
            if failureReason == nil { return "未配達の理由を選択してください" }
        case .deferred:
            if failureReason == nil { return "持ち戻りの理由を選択してください" }
            if deferredUntil == nil { return "再配達の日時を選択してください" }
        default:
            break
        }
        return nil
    }
}

public struct DeliveryDayReport: Codable, Sendable, Hashable, Identifiable {
    public var date: CalendarDateString
    public var total: Int
    public var delivered: Int
    public var failed: Int
    public var deferred: Int
    public var pending: Int?
    public var estimatedDistanceKm: Double?
    public var id: String { date }
}
