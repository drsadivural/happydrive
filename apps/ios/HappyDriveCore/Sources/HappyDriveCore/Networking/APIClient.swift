import Foundation

/// 1 回の API 呼び出しの定義。Response は応答本文の型（204 は EmptyResponse）。
public struct Endpoint<Response: Decodable & Sendable>: Sendable {
    public var method: HTTPMethod
    public var path: String
    public var query: [QueryItem]
    public var body: Data?
    /// 重要な書込は Idempotency-Key 必須。再試行時は同じキーを使う。
    public var idempotencyKey: String?
    public var requiresAuth: Bool

    public init(method: HTTPMethod, path: String, query: [QueryItem] = [], body: Data? = nil, idempotencyKey: String? = nil, requiresAuth: Bool = true) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.idempotencyKey = idempotencyKey
        self.requiresAuth = requiresAuth
    }

    public static func get(_ path: String, query: [QueryItem] = [], requiresAuth: Bool = true) -> Endpoint {
        Endpoint(method: .get, path: path, query: query, requiresAuth: requiresAuth)
    }

    public static func json<B: Encodable>(_ method: HTTPMethod, _ path: String, body: B, idempotencyKey: String? = nil, requiresAuth: Bool = true) throws -> Endpoint {
        let data = try HDJSON.makeEncoder().encode(body)
        return Endpoint(method: method, path: path, body: data, idempotencyKey: idempotencyKey, requiresAuth: requiresAuth)
    }

    public static func bodyless(_ method: HTTPMethod, _ path: String, idempotencyKey: String? = nil) -> Endpoint {
        Endpoint(method: method, path: path, idempotencyKey: idempotencyKey)
    }
}

/// Idempotency-Key の生成（16〜128文字。UUID は 36 文字）
public enum IdempotencyKey {
    public static func generate() -> String {
        UUID().uuidString.lowercased()
    }

    public static func isValid(_ key: String) -> Bool {
        (16...128).contains(key.count)
    }
}

/// セッション状態の変化（アプリ側でログイン画面へ戻す等）
public enum SessionEvent: Sendable, Equatable {
    case tokensRefreshed
    case expired
}

/// HappyDrive API クライアント。
/// - Bearer 認証
/// - 401 受信時にリフレッシュトークンをローテーション（single-flight）して 1 回だけ再送
/// - Idempotency-Key を付与（再送時も同じキー）
/// - エラーは APIError（日本語メッセージ付き）に変換
public final class APIClient: Sendable {
    public let baseURL: URL
    private let transport: HTTPTransport
    public let tokenStore: TokenStore
    private let refresher: TokenRefresher
    private let onSessionEvent: (@Sendable (SessionEvent) -> Void)?
    private let userAgent: String
    /// 期限の何秒前から事前リフレッシュするか
    private let refreshLeeway: TimeInterval
    private let now: @Sendable () -> Date

    public init(
        baseURL: URL,
        transport: HTTPTransport,
        tokenStore: TokenStore,
        userAgent: String = "HappyDrive-iOS",
        refreshLeeway: TimeInterval = 30,
        now: @escaping @Sendable () -> Date = { Date() },
        onSessionEvent: (@Sendable (SessionEvent) -> Void)? = nil
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokenStore = tokenStore
        self.refresher = TokenRefresher(store: tokenStore)
        self.userAgent = userAgent
        self.refreshLeeway = refreshLeeway
        self.now = now
        self.onSessionEvent = onSessionEvent
    }

    public var isLoggedIn: Bool { tokenStore.loadTokens() != nil }

    /// リフレッシュが実行された回数（テスト用）
    public func refreshCount() async -> Int { await refresher.refreshCount }

    // MARK: - 送信

    public func send<R>(_ endpoint: Endpoint<R>) async throws -> R {
        let response = try await perform(method: endpoint.method, path: endpoint.path, query: endpoint.query, body: endpoint.body, idempotencyKey: endpoint.idempotencyKey, requiresAuth: endpoint.requiresAuth)
        return try decode(R.self, from: response)
    }

    public func decode<R: Decodable>(_ type: R.Type, from response: HTTPResponse) throws -> R {
        if R.self == EmptyResponse.self {
            // swiftlint:disable:next force_cast
            return EmptyResponse() as! R
        }
        do {
            return try HDJSON.makeDecoder().decode(R.self, from: response.body)
        } catch {
            throw APIError.decoding(description: String(describing: error))
        }
    }

    /// 生の送信（オフラインキューの再送でも使用）。2xx 以外は APIError.server を投げる。
    public func perform(method: HTTPMethod, path: String, query: [QueryItem] = [], body: Data?, idempotencyKey: String?, requiresAuth: Bool = true) async throws -> HTTPResponse {
        let url = try makeURL(path: path, query: query)
        var headers: [String: String] = [
            "Accept": "application/json",
            "Accept-Language": "ja-JP",
            "User-Agent": userAgent,
        ]
        if body != nil { headers["Content-Type"] = "application/json" }
        if let idempotencyKey { headers["Idempotency-Key"] = idempotencyKey }

        guard requiresAuth else {
            let response = try await transport.perform(HTTPRequest(url: url, method: method, headers: headers, body: body))
            return try validate(response)
        }

        var accessToken = try await currentAccessToken()
        headers["Authorization"] = "Bearer \(accessToken)"
        var response = try await transport.perform(HTTPRequest(url: url, method: method, headers: headers, body: body))

        if response.status == 401 {
            // アクセストークン失効 → リフレッシュ（single-flight）して同じ Idempotency-Key で 1 回だけ再送
            let tokens = try await refreshTokens(failedAccessToken: accessToken)
            accessToken = tokens.accessToken
            headers["Authorization"] = "Bearer \(accessToken)"
            response = try await transport.perform(HTTPRequest(url: url, method: method, headers: headers, body: body))
            if response.status == 401 {
                tokenStore.clearTokens()
                onSessionEvent?(.expired)
                throw APIError.sessionExpired
            }
        }
        return try validate(response)
    }

    /// 署名付き URL へのバイナリ送信（証跡アップロード）。Bearer は付けない。
    public func uploadBlob(to url: URL, method: String = "PUT", headers: [String: String], data: Data) async throws {
        let m = HTTPMethod(rawValue: method.uppercased()) ?? .put
        let response = try await transport.perform(HTTPRequest(url: url, method: m, headers: headers, body: data))
        _ = try validate(response)
    }

    // MARK: - 内部

    private func currentAccessToken() async throws -> String {
        guard let tokens = tokenStore.loadTokens() else {
            throw APIError.sessionExpired
        }
        if tokens.accessTokenExpiresAt.timeIntervalSince(now()) < refreshLeeway {
            return try await refreshTokens(failedAccessToken: tokens.accessToken).accessToken
        }
        return tokens.accessToken
    }

    private func refreshTokens(failedAccessToken: String) async throws -> Tokens {
        do {
            let tokens = try await refresher.refresh(failedAccessToken: failedAccessToken) { [transport, baseURL, userAgent] refreshToken in
                let body = try HDJSON.makeEncoder().encode(RefreshBody(refreshToken: refreshToken))
                let url = try APIClient.buildURL(baseURL: baseURL, path: "/auth/refresh", query: [])
                let response = try await transport.perform(HTTPRequest(url: url, method: .post, headers: [
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "User-Agent": userAgent,
                ], body: body))
                guard response.isSuccess else {
                    throw APIError.server(status: response.status, body: try? HDJSON.makeDecoder().decode(APIErrorBody.self, from: response.body))
                }
                do {
                    return try HDJSON.makeDecoder().decode(Tokens.self, from: response.body)
                } catch {
                    throw APIError.decoding(description: String(describing: error))
                }
            }
            onSessionEvent?(.tokensRefreshed)
            return tokens
        } catch APIError.sessionExpired {
            onSessionEvent?(.expired)
            throw APIError.sessionExpired
        }
    }

    private func validate(_ response: HTTPResponse) throws -> HTTPResponse {
        guard response.isSuccess else {
            let body = try? HDJSON.makeDecoder().decode(APIErrorBody.self, from: response.body)
            throw APIError.server(status: response.status, body: body)
        }
        return response
    }

    private func makeURL(path: String, query: [QueryItem]) throws -> URL {
        try Self.buildURL(baseURL: baseURL, path: path, query: query)
    }

    static func buildURL(baseURL: URL, path: String, query: [QueryItem]) throws -> URL {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        let p = path.hasPrefix("/") ? path : "/" + path
        guard var components = URLComponents(string: base + p) else {
            throw APIError.invalidInput(message: "URLを組み立てられませんでした")
        }
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.name, value: $0.value) }
            // "+" は空白と解釈されるサーバーがあるため明示的にエンコード
            components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components.url else {
            throw APIError.invalidInput(message: "URLを組み立てられませんでした")
        }
        return url
    }

    /// パス部品のエンコード（ID は UUID だが念のため）
    public static func pathComponent(_ raw: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
    }
}
