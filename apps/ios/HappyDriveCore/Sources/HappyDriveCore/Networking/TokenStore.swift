import Foundation

/// 認証トークンの保存先。アプリ本体では Keychain 実装（KeychainTokenStore）を使う。
public protocol TokenStore: Sendable {
    func loadTokens() -> Tokens?
    func saveTokens(_ tokens: Tokens) throws
    func clearTokens()
}

/// テスト・プレビュー用のメモリ内実装
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: Tokens?

    public init(tokens: Tokens? = nil) {
        self.tokens = tokens
    }

    public func loadTokens() -> Tokens? {
        lock.lock(); defer { lock.unlock() }
        return tokens
    }

    public func saveTokens(_ tokens: Tokens) throws {
        lock.lock(); defer { lock.unlock() }
        self.tokens = tokens
    }

    public func clearTokens() {
        lock.lock(); defer { lock.unlock() }
        tokens = nil
    }
}

/// リフレッシュトークンのローテーションを単一実行（single-flight）にする。
/// 同時に複数の要求が 401 を受けても /auth/refresh は 1 回だけ呼ばれ、
/// 使用済みリフレッシュトークンの再利用（サーバー側で全失効の対象）を防ぐ。
public actor TokenRefresher {
    public typealias RefreshCall = @Sendable (_ refreshToken: String) async throws -> Tokens

    private let store: TokenStore
    private var inFlight: Task<Tokens, Error>?
    public private(set) var refreshCount = 0

    public init(store: TokenStore) {
        self.store = store
    }

    /// - Parameter failedAccessToken: 401 を受けた要求で使ったアクセストークン。
    ///   既に別の要求が新しいトークンを取得済みなら、リフレッシュせずにそれを返す。
    public func refresh(failedAccessToken: String?, using call: @escaping RefreshCall) async throws -> Tokens {
        if let task = inFlight {
            return try await task.value
        }
        if let current = store.loadTokens(), let failed = failedAccessToken, current.accessToken != failed {
            return current
        }
        guard let refreshToken = store.loadTokens()?.refreshToken else {
            throw APIError.sessionExpired
        }
        refreshCount += 1
        let store = self.store
        let task = Task<Tokens, Error> {
            do {
                let tokens = try await call(refreshToken)
                try store.saveTokens(tokens)
                return tokens
            } catch let error as APIError {
                if case .server(let status, _) = error, status == 401 || status == 403 {
                    store.clearTokens()
                    throw APIError.sessionExpired
                }
                throw error
            }
        }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }
}
