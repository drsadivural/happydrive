import Foundation

/// 契約の `format: date`（例 "2026-09-26"、JSTの暦日）。文字列のまま扱い、表示時に HDFormat で整形する。
public typealias CalendarDateString = String

// MARK: - Auth

public struct OTPRequestBody: Codable, Sendable, Hashable {
    public var phone: String
    public init(phone: String) { self.phone = phone }
}

public struct OTPRequestResult: Codable, Sendable, Hashable {
    public var expiresAt: Date
    public var resendAfterSeconds: Int
    public init(expiresAt: Date, resendAfterSeconds: Int) {
        self.expiresAt = expiresAt
        self.resendAfterSeconds = resendAfterSeconds
    }
}

/// 端末アカウントでのログイン（電話番号確認なし）。deviceSecret はキーチェーンに保存した乱数。
public struct DeviceLoginBody: Codable, Sendable, Hashable {
    public var deviceSecret: String
    public var deviceName: String?
    public init(deviceSecret: String, deviceName: String? = nil) {
        self.deviceSecret = deviceSecret
        self.deviceName = deviceName
    }
}

public struct OTPVerifyBody: Codable, Sendable, Hashable {
    public var phone: String
    public var code: String
    public var deviceName: String?
    public init(phone: String, code: String, deviceName: String? = nil) {
        self.phone = phone
        self.code = code
        self.deviceName = deviceName
    }
}

public struct Tokens: Codable, Sendable, Hashable {
    public var accessToken: String
    public var refreshToken: String
    public var accessTokenExpiresAt: Date
    public var refreshTokenExpiresAt: Date

    public init(accessToken: String, refreshToken: String, accessTokenExpiresAt: Date, refreshTokenExpiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.refreshTokenExpiresAt = refreshTokenExpiresAt
    }
}

public struct AuthResult: Codable, Sendable, Hashable {
    public var tokens: Tokens
    public var user: User
    public var isNewUser: Bool
}

public struct RefreshBody: Codable, Sendable, Hashable {
    public var refreshToken: String
    public init(refreshToken: String) { self.refreshToken = refreshToken }
}

// MARK: - User

public enum Role: String, UnknownCaseRepresentable, CaseIterable {
    case worker, org_member, admin_operator, admin_support, admin_auditor
    case unknown
    public static var unknownCase: Role { .unknown }
}

public enum VerificationStatus: String, UnknownCaseRepresentable, CaseIterable {
    case unsubmitted, pending, verified, rejected
    case unknown
    public static var unknownCase: VerificationStatus { .unknown }
}

public struct OnboardingSteps: Codable, Sendable, Hashable {
    public var terms: Bool?
    public var profile: Bool?
    public var vehicle: Bool?
    public var bankAccount: Bool?
    public var verification: Bool?

    public init(terms: Bool? = nil, profile: Bool? = nil, vehicle: Bool? = nil, bankAccount: Bool? = nil, verification: Bool? = nil) {
        self.terms = terms
        self.profile = profile
        self.vehicle = vehicle
        self.bankAccount = bankAccount
        self.verification = verification
    }
}

public struct OrganizationMembership: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var legalName: String
    public var role: String
    public var reviewStatus: String
}

public struct User: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var displayName: String
    public var verificationStatus: VerificationStatus
    public var verificationNote: String?
    public var skills: [String]?
    public var skillDetails: [Skill]?
    public var roles: [Role]?
    public var phoneMasked: String?
    public var email: String?
    public var termsAccepted: Bool?
    public var profile: Profile?
    public var vehicle: Vehicle?
    public var bankAccount: BankAccountMasked?
    public var preferences: Preferences?
    public var organizations: [OrganizationMembership]?
    public var ratingAverage: Double?
    public var ratingCount: Int?
    public var completedJobCount: Int?
    public var suspended: Bool?
    public var onboardingSteps: OnboardingSteps?

    public init(id: String, displayName: String, verificationStatus: VerificationStatus) {
        self.id = id
        self.displayName = displayName
        self.verificationStatus = verificationStatus
    }
}

public struct ProfileInput: Codable, Sendable, Hashable {
    public var legalName: String
    public var legalNameKana: String
    public var birthDate: CalendarDateString
    public var postalCode: String
    public var address: String
    public var invoiceRegistrationNumber: String?

    public init(legalName: String, legalNameKana: String, birthDate: CalendarDateString, postalCode: String, address: String, invoiceRegistrationNumber: String? = nil) {
        self.legalName = legalName
        self.legalNameKana = legalNameKana
        self.birthDate = birthDate
        self.postalCode = postalCode
        self.address = address
        self.invoiceRegistrationNumber = invoiceRegistrationNumber
    }
}

public struct Profile: Codable, Sendable, Hashable {
    public var legalName: String?
    public var legalNameKana: String?
    public var birthDate: CalendarDateString?
    public var postalCode: String?
    public var address: String?
    public var invoiceRegistrationNumber: String?
}

public enum VehicleType: String, UnknownCaseRepresentable, CaseIterable {
    case kei_van, kei_truck, car, motorbike, bicycle, none
    case unknown
    public static var unknownCase: VehicleType { .unknown }
    /// 画面の選択肢（unknown を除く）
    public static var selectable: [VehicleType] { [.kei_van, .kei_truck, .car, .motorbike, .bicycle, .none] }
}

public struct Vehicle: Codable, Sendable, Hashable {
    public var type: VehicleType
    public var plateNumber: String?
    public var blackPlateRegistered: Bool?
    public var cargoCapacityKg: Int?

    public init(type: VehicleType, plateNumber: String? = nil, blackPlateRegistered: Bool? = nil, cargoCapacityKg: Int? = nil) {
        self.type = type
        self.plateNumber = plateNumber
        self.blackPlateRegistered = blackPlateRegistered
        self.cargoCapacityKg = cargoCapacityKg
    }
}

public enum BankAccountType: String, UnknownCaseRepresentable, CaseIterable {
    case ordinary, checking, savings
    case unknown
    public static var unknownCase: BankAccountType { .unknown }
    public static var selectable: [BankAccountType] { [.ordinary, .checking, .savings] }
}

public struct BankAccountInput: Codable, Sendable, Hashable {
    public var bankCode: String
    public var branchCode: String
    public var accountType: BankAccountType
    public var accountNumber: String
    public var holderNameKana: String

    public init(bankCode: String, branchCode: String, accountType: BankAccountType, accountNumber: String, holderNameKana: String) {
        self.bankCode = bankCode
        self.branchCode = branchCode
        self.accountType = accountType
        self.accountNumber = accountNumber
        self.holderNameKana = holderNameKana
    }
}

public struct BankAccountMasked: Codable, Sendable, Hashable {
    public var bankCode: String?
    public var branchCode: String?
    public var accountType: String?
    public var accountNumberLast4: String?
    public var holderNameKana: String?
}

public struct Preferences: Codable, Sendable, Hashable {
    public var useLocationForMatching: Bool?
    public var useHistoryForMatching: Bool?
    public var preferredCategories: [JobCategory]?
    public var maxDistanceKm: Double?
    public var notifyNewJobs: Bool?
    public var notifyMessages: Bool?
    public var showRatingToOrganizations: Bool?

    public init(useLocationForMatching: Bool? = nil, useHistoryForMatching: Bool? = nil, preferredCategories: [JobCategory]? = nil, maxDistanceKm: Double? = nil, notifyNewJobs: Bool? = nil, notifyMessages: Bool? = nil, showRatingToOrganizations: Bool? = nil) {
        self.useLocationForMatching = useLocationForMatching
        self.useHistoryForMatching = useHistoryForMatching
        self.preferredCategories = preferredCategories
        self.maxDistanceKm = maxDistanceKm
        self.notifyNewJobs = notifyNewJobs
        self.notifyMessages = notifyMessages
        self.showRatingToOrganizations = showRatingToOrganizations
    }
}

public enum SkillStatus: String, UnknownCaseRepresentable, CaseIterable {
    case pending, verified, rejected, expired
    case unknown
    public static var unknownCase: SkillStatus { .unknown }
}

public struct Skill: Codable, Sendable, Hashable, Identifiable {
    public var code: String
    public var name: String
    public var status: SkillStatus
    public var source: String?
    public var validUntil: CalendarDateString?
    public var note: String?
    public var id: String { code }
}

public struct SkillDefinition: Codable, Sendable, Hashable, Identifiable {
    public var code: String
    public var name: String
    public var source: String
    public var description: String?
    public var courseId: String?
    public var id: String { code }
}

public struct SkillSubmission: Codable, Sendable, Hashable {
    public var skillCode: String
    public var validUntil: CalendarDateString?
    public var documentEvidenceIds: [String]
    public init(skillCode: String, validUntil: CalendarDateString?, documentEvidenceIds: [String]) {
        self.skillCode = skillCode
        self.validUntil = validUntil
        self.documentEvidenceIds = documentEvidenceIds
    }
}

public struct TermsAcceptance: Codable, Sendable, Hashable {
    public var termsVersion: String
    public var privacyVersion: String
    public init(termsVersion: String, privacyVersion: String) {
        self.termsVersion = termsVersion
        self.privacyVersion = privacyVersion
    }
}

public struct DeletionRequestBody: Codable, Sendable, Hashable {
    public var confirm: Bool?
    public var reason: String?
    public init(confirm: Bool?, reason: String?) {
        self.confirm = confirm
        self.reason = reason
    }
}

public enum DeletionStatus: String, UnknownCaseRepresentable {
    case confirmation_required, completed
    case unknown
    public static var unknownCase: DeletionStatus { .unknown }
}

public struct DeletionRequest: Codable, Sendable, Hashable {
    public var id: String?
    public var userId: String?
    public var status: DeletionStatus
    public var requestedAt: Date?
    public var completedAt: Date?
    public var retentionNotice: String
    public var blockers: [String]?

    public init(id: String? = nil, userId: String? = nil, status: DeletionStatus, requestedAt: Date? = nil, completedAt: Date? = nil, retentionNotice: String, blockers: [String]? = nil) {
        self.id = id
        self.userId = userId
        self.status = status
        self.requestedAt = requestedAt
        self.completedAt = completedAt
        self.retentionNotice = retentionNotice
        self.blockers = blockers
    }
}

public enum SupportCategory: String, UnknownCaseRepresentable, CaseIterable {
    case account, payment, job, delivery, safety, privacy, other
    case unknown
    public static var unknownCase: SupportCategory { .unknown }
    public static var selectable: [SupportCategory] { [.account, .payment, .job, .delivery, .safety, .privacy, .other] }
}

public struct SupportTicketInput: Codable, Sendable, Hashable {
    public var category: SupportCategory
    public var body: String
    public var assignmentId: String?
    public init(category: SupportCategory, body: String, assignmentId: String? = nil) {
        self.category = category
        self.body = body
        self.assignmentId = assignmentId
    }
}

public enum TicketStatus: String, UnknownCaseRepresentable {
    case open, answered, closed
    case unknown
    public static var unknownCase: TicketStatus { .unknown }
}

public struct SupportTicket: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var userId: String?
    public var userDisplayName: String?
    public var category: String
    public var body: String
    public var answer: String?
    public var status: TicketStatus
    public var assignmentId: String?
    public var jobId: String?
    public var createdAt: Date
}

public struct MatchingAppealInput: Codable, Sendable, Hashable {
    public var jobId: String?
    public var body: String
    public init(jobId: String?, body: String) {
        self.jobId = jobId
        self.body = body
    }
}

public enum APNsEnvironment: String, Codable, Sendable {
    case sandbox, production
}

public struct DeviceRegistration: Codable, Sendable, Hashable {
    public var apnsToken: String
    public var environment: APNsEnvironment
    public init(apnsToken: String, environment: APNsEnvironment) {
        self.apnsToken = apnsToken
        self.environment = environment
    }
}

public struct DisplayNameUpdate: Codable, Sendable, Hashable {
    public var displayName: String
    public init(displayName: String) { self.displayName = displayName }
}
