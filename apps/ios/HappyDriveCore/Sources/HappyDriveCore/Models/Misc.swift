import Foundation

// MARK: - Evidence

public enum EvidencePurpose: String, Codable, Sendable, CaseIterable {
    case work_photo, delivery_photo, signature, identity_document, skill_document, message_attachment
}

public enum EvidenceContentType: String, Codable, Sendable {
    case jpeg = "image/jpeg"
    case png = "image/png"
}

public struct EvidenceUploadRequest: Codable, Sendable, Hashable {
    public var assignmentId: String?
    public var deliveryStopId: String?
    public var purpose: EvidencePurpose?
    public var contentType: EvidenceContentType
    public var byteSize: Int
    public var sha256: String

    public init(assignmentId: String? = nil, deliveryStopId: String? = nil, purpose: EvidencePurpose?, contentType: EvidenceContentType, byteSize: Int, sha256: String) {
        self.assignmentId = assignmentId
        self.deliveryStopId = deliveryStopId
        self.purpose = purpose
        self.contentType = contentType
        self.byteSize = byteSize
        self.sha256 = sha256
    }
}

public struct EvidenceUploadTicket: Codable, Sendable, Hashable {
    public var evidenceId: String
    public var uploadUrl: URL
    public var uploadMethod: String?
    public var uploadHeaders: [String: String]?
    public var expiresAt: Date
}

public enum EvidenceStatus: String, UnknownCaseRepresentable {
    case pending_upload, verified, rejected
    case unknown
    public static var unknownCase: EvidenceStatus { .unknown }
}

public struct Evidence: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var purpose: String
    public var status: EvidenceStatus
    public var contentType: String?
    public var byteSize: Int?
    public var createdAt: Date
    public var expiresAt: Date?
}

public struct SignedURL: Codable, Sendable, Hashable {
    public var url: URL
    public var expiresAt: Date
}

public struct VerificationSubmission: Codable, Sendable, Hashable {
    public var documentEvidenceIds: [String]
    public init(documentEvidenceIds: [String]) { self.documentEvidenceIds = documentEvidenceIds }
}

// MARK: - Messaging

public enum SenderRole: String, UnknownCaseRepresentable {
    case worker, organization, operator_ = "operator", system
    case unknown
    public static var unknownCase: SenderRole { .unknown }
}

public struct Message: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var assignmentId: String
    public var senderRole: SenderRole
    public var senderName: String?
    public var isMine: Bool?
    public var body: String
    public var evidenceId: String?
    public var hidden: Bool?
    public var createdAt: Date
}

public struct SendMessageBody: Codable, Sendable, Hashable {
    public var body: String
    public var evidenceId: String?
    public init(body: String, evidenceId: String? = nil) {
        self.body = body
        self.evidenceId = evidenceId
    }
}

public enum ReportTargetType: String, Codable, Sendable {
    case message, job, user, organization
}

public enum ReportReason: String, Codable, Sendable, CaseIterable {
    case harassment, fraud, unsafe, illegal, spam, privacy, other
}

public struct ReportInput: Codable, Sendable, Hashable {
    public var targetType: ReportTargetType
    public var targetId: String
    public var reason: ReportReason
    public var detail: String?
    public init(targetType: ReportTargetType, targetId: String, reason: ReportReason, detail: String?) {
        self.targetType = targetType
        self.targetId = targetId
        self.reason = reason
        self.detail = detail
    }
}

public struct Report: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var reporterId: String?
    public var targetType: String
    public var targetId: String
    public var reason: String
    public var detail: String?
    public var status: String
    public var resolution: String?
    public var createdAt: Date
}

public struct BlockOrganizationBody: Codable, Sendable, Hashable {
    public var organizationId: String
    public init(organizationId: String) { self.organizationId = organizationId }
}

// MARK: - Notifications

public struct AppNotification: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var type: String
    public var title: String
    public var body: String
    public var entityType: String?
    public var entityId: String?
    public var readAt: Date?
    public var createdAt: Date

    public var isUnread: Bool { readAt == nil }
}

public struct MarkNotificationsReadBody: Codable, Sendable, Hashable {
    public var ids: [String]?
    public var all: Bool?
    public init(ids: [String]? = nil, all: Bool? = nil) {
        self.ids = ids
        self.all = all
    }
}

// MARK: - Earnings

public enum EarningState: String, UnknownCaseRepresentable, CaseIterable {
    case estimated, pending, payable, paid, failed, reversed
    case unknown
    public static var unknownCase: EarningState { .unknown }
}

public struct EarningBreakdownLine: Codable, Sendable, Hashable {
    public var type: String
    public var amountYen: Int
    public var note: String?
}

public struct EarningEntry: Codable, Sendable, Hashable {
    public var id: String?
    public var assignmentId: String
    public var jobTitle: String?
    public var organizationName: String?
    public var contractType: ContractType?
    public var amountYen: Int
    public var state: EarningState
    public var scheduledPayoutDate: CalendarDateString?
    public var paidAt: Date?
    public var workDate: CalendarDateString?
    public var breakdown: [EarningBreakdownLine]?

    /// id が無い場合は割当IDで識別
    public var stableId: String { id ?? "assignment-\(assignmentId)" }
}

public struct EarningsSummary: Codable, Sendable, Hashable {
    public var month: String
    public var totalYen: Int
    public var paidYen: Int
    public var payableYen: Int
    public var pendingYen: Int
    public var estimatedYen: Int
    public var completedCount: Int
    public var employmentYen: Int?
    public var contractorYen: Int?
}

public enum PayoutStatus: String, UnknownCaseRepresentable, CaseIterable {
    case requested, processing, paid, failed
    case unknown
    public static var unknownCase: PayoutStatus { .unknown }
}

public struct Payout: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var workerId: String?
    public var workerDisplayName: String?
    public var amountYen: Int
    public var status: PayoutStatus
    public var failureReason: String?
    public var providerReference: String?
    public var attemptCount: Int?
    public var scheduledDate: CalendarDateString?
    public var paidAt: Date?
    public var createdAt: Date
}

// MARK: - Learning

public struct CourseSummary: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var category: String
    public var summary: String?
    public var durationMinutes: Int
    public var grantsSkill: String?
    public var grantsSkillName: String?
    public var completed: Bool
    public var skillValidUntil: CalendarDateString?
}

public struct Lesson: Codable, Sendable, Hashable {
    public var title: String
    public var body: String
}

public struct QuizQuestion: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var question: String
    public var choices: [String]
}

public struct Course: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var category: String
    public var summary: String?
    public var durationMinutes: Int
    public var grantsSkill: String?
    public var grantsSkillName: String?
    public var completed: Bool
    public var skillValidUntil: CalendarDateString?
    public var lessons: [Lesson]
    public var questions: [QuizQuestion]
    public var passScore: Int
}

public struct QuizAnswer: Codable, Sendable, Hashable {
    public var questionId: String
    public var choiceIndex: Int
    public init(questionId: String, choiceIndex: Int) {
        self.questionId = questionId
        self.choiceIndex = choiceIndex
    }
}

public struct QuizAttempt: Codable, Sendable, Hashable {
    public var answers: [QuizAnswer]
    public init(answers: [QuizAnswer]) { self.answers = answers }
}

public struct QuizResult: Codable, Sendable, Hashable {
    public var passed: Bool
    public var score: Int
    public var total: Int
    public var grantedSkill: Skill?
    public var incorrectQuestionIds: [String]?
}
