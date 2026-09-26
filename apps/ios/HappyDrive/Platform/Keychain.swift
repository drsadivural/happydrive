import Foundation
import HappyDriveCore
#if canImport(Security)
import Security

/// Keychain の汎用パスワード項目への読み書き（この端末のみ・初回ロック解除後に利用可能）
enum KeychainItem {
    static func read(service: String, account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    static func write(_ data: Data, service: String, account: String) throws {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add.merge(update) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    static func delete(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// 端末アカウントの秘密値（256bit 乱数、base64url）。この端末のキーチェーンにのみ保存し、サーバーへはログイン時に送る。
enum DeviceCredential {
    private static let service = "jp.happydrive.driver.device"
    private static let account = "secret"

    static func loadOrCreate() throws -> String {
        if let data = KeychainItem.read(service: service, account: account), let s = String(data: data, encoding: .utf8), s.count >= 43 {
            return s
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        let secret = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        try KeychainItem.write(Data(secret.utf8), service: service, account: account)
        return secret
    }

    /// 退会後に呼ぶ。次回起動時は新しいアカウントになる。
    static func reset() {
        KeychainItem.delete(service: service, account: account)
    }
}

/// 認証トークンを Keychain に保存する TokenStore
final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service = "jp.happydrive.driver.auth"
    private let account = "tokens"
    private let lock = NSLock()
    private var cached: Tokens?
    private var loaded = false

    func loadTokens() -> Tokens? {
        lock.lock(); defer { lock.unlock() }
        if loaded { return cached }
        loaded = true
        if let data = KeychainItem.read(service: service, account: account) {
            cached = try? HDJSON.makeDecoder().decode(Tokens.self, from: data)
        }
        return cached
    }

    func saveTokens(_ tokens: Tokens) throws {
        let data = try HDJSON.makeEncoder().encode(tokens)
        lock.lock(); defer { lock.unlock() }
        try KeychainItem.write(data, service: service, account: account)
        cached = tokens
        loaded = true
    }

    func clearTokens() {
        lock.lock(); defer { lock.unlock() }
        KeychainItem.delete(service: service, account: account)
        cached = nil
        loaded = true
    }
}

/// 暗号化キャッシュ用の 256bit 鍵を Keychain に生成・保存する
final class KeychainKeyProvider: SymmetricKeyProvider, @unchecked Sendable {
    private let service = "jp.happydrive.driver.cache"
    private let account = "aes-gcm-key"
    private let lock = NSLock()
    private var cached: Data?

    func keyData() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        if let cached { return cached }
        if let existing = KeychainItem.read(service: service, account: account), existing.count == 32 {
            cached = existing
            return existing
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw EncryptionError.invalidKey }
        let data = Data(bytes)
        try KeychainItem.write(data, service: service, account: account)
        cached = data
        return data
    }

    /// 退会・ログアウト時に鍵を破棄（以後キャッシュは復号できない）
    func destroy() {
        lock.lock(); defer { lock.unlock() }
        KeychainItem.delete(service: service, account: account)
        cached = nil
    }
}
#endif
