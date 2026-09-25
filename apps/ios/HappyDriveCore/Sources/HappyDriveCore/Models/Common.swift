import Foundation

// MARK: - 共通型

/// 緯度経度（契約: Point）
public struct GeoPoint: Codable, Sendable, Hashable {
    public var latitude: Double
    public var longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }

    public var isValid: Bool {
        (-90.0...90.0).contains(latitude) && (-180.0...180.0).contains(longitude)
    }
}

/// サーバーのエラー応答（契約: Error）。message は利用者に表示できる日本語。
public struct APIErrorBody: Codable, Sendable, Hashable {
    public var code: String
    public var message: String
    public var requestId: String?
    public var details: [String: JSONValue]?

    public init(code: String, message: String, requestId: String? = nil, details: [String: JSONValue]? = nil) {
        self.code = code
        self.message = message
        self.requestId = requestId
        self.details = details
    }
}

/// 任意の JSON 値（details / termsSnapshot など additionalProperties: true 用）
public enum JSONValue: Codable, Sendable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "未対応のJSON値")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let n): try container.encode(n)
        case .bool(let b): try container.encode(b)
        case .object(let o): try container.encode(o)
        case .array(let a): try container.encode(a)
        case .null: try container.encodeNil()
        }
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var doubleValue: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    public var intValue: Int? {
        if case .number(let n) = self { return Int(n) }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    /// 文字列配列として取り出す（ineligibleReasons 等）
    public var stringArray: [String]? {
        arrayValue?.compactMap { $0.stringValue }
    }
}

/// 204 No Content 等の本文なし応答
public struct EmptyResponse: Codable, Sendable, Hashable {
    public init() {}
}

/// 未知の値を受け取ってもデコードを失敗させない列挙型。
/// サーバーが状態を追加しても古いアプリが落ちないようにする。
public protocol UnknownCaseRepresentable: RawRepresentable, Codable, Sendable, Hashable where RawValue == String {
    static var unknownCase: Self { get }
}

extension UnknownCaseRepresentable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.unknownCase
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// PATCH で「変更しない / null で消去 / 値を設定」を区別するためのフィールド。
public enum Nullable<Value: Codable & Sendable & Hashable>: Sendable, Hashable {
    case unchanged
    case null
    case value(Value)
}

extension KeyedEncodingContainer {
    public mutating func encode<V>(_ field: Nullable<V>, forKey key: Key) throws {
        switch field {
        case .unchanged: break
        case .null: try encodeNil(forKey: key)
        case .value(let v): try encode(v, forKey: key)
        }
    }
}
