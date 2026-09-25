import Foundation
import XCTest
@testable import HappyDriveCore

enum Fixture {
    static func data(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
            throw NSError(domain: "Fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "fixture \(name) not found"])
        }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try HDJSON.makeDecoder().decode(type, from: data(name))
    }
}

/// 送信内容を記録し、ハンドラで応答を返すモック
final class MockTransport: HTTPTransport, @unchecked Sendable {
    typealias Handler = @Sendable (HTTPRequest) async throws -> HTTPResponse
    private let lock = NSLock()
    private var _requests: [HTTPRequest] = []
    private let handler: Handler

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    var requests: [HTTPRequest] {
        lock.lock(); defer { lock.unlock() }
        return _requests
    }

    func requests(path: String) -> [HTTPRequest] {
        requests.filter { $0.url.path.hasSuffix(path) }
    }

    func perform(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.lock()
        _requests.append(request)
        lock.unlock()
        return try await handler(request)
    }
}

/// スレッド安全なカウンタ・値入れ
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
    @discardableResult
    func mutate<R>(_ f: (inout T) -> R) -> R { lock.lock(); defer { lock.unlock() }; return f(&value) }
}

func json(_ status: Int, _ object: Any) -> HTTPResponse {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    return HTTPResponse(status: status, headers: ["content-type": "application/json"], body: data)
}

func errorResponse(_ status: Int, code: String, message: String, details: [String: Any]? = nil) -> HTTPResponse {
    var obj: [String: Any] = ["code": code, "message": message, "requestId": "req-test"]
    if let details { obj["details"] = details }
    return json(status, obj)
}

func tokens(access: String, refresh: String, expiresIn: TimeInterval = 900, now: Date = Date()) -> Tokens {
    Tokens(accessToken: access, refreshToken: refresh, accessTokenExpiresAt: now.addingTimeInterval(expiresIn), refreshTokenExpiresAt: now.addingTimeInterval(86400 * 30))
}

func tokensJSON(access: String, refresh: String) -> [String: Any] {
    [
        "accessToken": access,
        "refreshToken": refresh,
        "accessTokenExpiresAt": HDJSON.formatDateTime(Date().addingTimeInterval(900)),
        "refreshTokenExpiresAt": HDJSON.formatDateTime(Date().addingTimeInterval(86400 * 30)),
    ]
}

let testBaseURL = URL(string: "http://localhost:8080/v1")!
