import Foundation

public struct MarketplaceList<Item: Decodable & Sendable>: Decodable, Sendable {
    public let items: [Item]
}
public struct MarketplaceAccount: Decodable, Sendable {
    public struct Profile: Decodable, Sendable { public let familyName: String; public let givenName: String; public let phoneVerified: Bool }
    public struct Supplier: Decodable, Sendable, Identifiable { public let id: String; public let legalName: String; public let role: String; public let reviewStatus: String }
    public struct Subscription: Decodable, Sendable { public let planCode: String; public let status: String; public let trialEndsAt: Date?; public let currentPeriodEnd: Date? }
    public let profile: Profile?
    public let roles: [String]
    public let suppliers: [Supplier]
    public let subscription: Subscription?
}
public struct MarketplaceService: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let category: String
    public let description: String
    public let areaCodes: [String]
    public let durationMinutes: Int
    public let pricePolicy: String
    public let supplierName: String?
    public let status: String?
}
public struct MarketplaceRequest: Decodable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let status: String?
    public let serviceName: String
    public let areaCode: String
    public let startsAt: Date
    public let endsAt: Date
    public let customerId: String?
    public let staffId: String?
    public let address: String?
    public let details: String?
    public let supplierName: String?
}
public struct MarketplaceResult: Decodable, Sendable { public let id: String; public let status: String? }
public struct CompletionToken: Decodable, Sendable {
    public let requestId: String
    public let token: String
    public let expiresAt: Date
    public var qrPayload: Data? { try? JSONEncoder().encode(CompletionPayload(requestId: requestId, token: token)) }
    public func isExpired(at date: Date) -> Bool { expiresAt <= date }
}
public struct CompletionPayload: Codable, Sendable, Equatable {
    public let requestId: String
    public let token: String
    public init(requestId: String, token: String) { self.requestId = requestId; self.token = token }
    public static func parse(_ raw: String) -> CompletionPayload? {
        guard raw.utf8.count <= 512, let data = raw.data(using: .utf8),
              let payload = try? JSONDecoder().decode(Self.self, from: data),
              UUID(uuidString: payload.requestId) != nil, payload.token.count == 43,
              payload.token.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        return payload
    }
}
public enum MarketplaceStatus {
    public static func label(_ status: String?) -> String {
        switch status {
        case "open": "供給者を探しています"
        case "accepted": "受諾済み"
        case "en_route": "移動中"
        case "arrived": "到着"
        case "in_progress": "作業中"
        case "awaiting_customer_confirmation": "完了確認待ち"
        case "completed": "完了"
        case "cancelled": "キャンセル"
        case "disputed": "サポート対応中"
        default: "募集中"
        }
    }
    public static func next(_ status: String?) -> String? {
        switch status {
        case "accepted": "en_route"
        case "en_route": "arrived"
        case "arrived": "in_progress"
        case "in_progress": "awaiting_customer_confirmation"
        default: nil
        }
    }
}
