import Foundation
import Crypto

/// 対称鍵（32バイト）の提供元。アプリ本体では Keychain に保存した鍵を返す。
public protocol SymmetricKeyProvider: Sendable {
    func keyData() throws -> Data
}

/// テスト用の固定鍵
public struct StaticKeyProvider: SymmetricKeyProvider {
    private let data: Data
    public init(data: Data) { self.data = data }
    public static func random() -> StaticKeyProvider {
        StaticKeyProvider(data: SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
    }
    public func keyData() throws -> Data { data }
}

public enum EncryptionError: Error, Sendable, Equatable {
    case invalidKey
    case sealFailed
    case openFailed
}

/// データの暗号化/復号（AES-GCM 256bit、nonce + 暗号文 + tag を結合した形式）
public protocol DataSealer: Sendable {
    func seal(_ plaintext: Data) throws -> Data
    func open(_ sealed: Data) throws -> Data
}

public struct AESGCMSealer: DataSealer {
    private let keyProvider: SymmetricKeyProvider

    public init(keyProvider: SymmetricKeyProvider) {
        self.keyProvider = keyProvider
    }

    private func key() throws -> SymmetricKey {
        let data = try keyProvider.keyData()
        guard data.count == 32 else { throw EncryptionError.invalidKey }
        return SymmetricKey(data: data)
    }

    public func seal(_ plaintext: Data) throws -> Data {
        let box = try AES.GCM.seal(plaintext, using: key())
        guard let combined = box.combined else { throw EncryptionError.sealFailed }
        return combined
    }

    public func open(_ sealed: Data) throws -> Data {
        do {
            let box = try AES.GCM.SealedBox(combined: sealed)
            return try AES.GCM.open(box, using: key())
        } catch let e as EncryptionError {
            throw e
        } catch {
            throw EncryptionError.openFailed
        }
    }
}

/// 暗号化してファイルに保存する Codable ストア。
/// 圏外でも今日の配送先（停止順・住所・メモ）を参照するための最小キャッシュに使う。
public final class EncryptedFileStore<Value: Codable & Sendable>: @unchecked Sendable {
    private let url: URL
    private let sealer: DataSealer
    private let lock = NSLock()

    public init(url: URL, sealer: DataSealer) {
        self.url = url
        self.sealer = sealer
    }

    public func save(_ value: Value) throws {
        lock.lock(); defer { lock.unlock() }
        let plain = try HDJSON.makeEncoder().encode(value)
        let sealed = try sealer.seal(plain)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try sealed.write(to: url, options: HDFileWriting.protectedAtomic)
    }

    /// 復号できない（鍵の変更・破損）場合は nil を返してファイルを削除する。
    public func load() -> Value? {
        lock.lock(); defer { lock.unlock() }
        guard let sealed = try? Data(contentsOf: url) else { return nil }
        guard let plain = try? sealer.open(sealed), let value = try? HDJSON.makeDecoder().decode(Value.self, from: plain) else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return value
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        try? FileManager.default.removeItem(at: url)
    }
}

/// 今日の配送のオフライン用スナップショット
public struct DeliveryCacheSnapshot: Codable, Sendable, Hashable {
    public var date: CalendarDateString
    public var stops: [Stop]
    public var route: Route?
    public var savedAt: Date

    public init(date: CalendarDateString, stops: [Stop], route: Route?, savedAt: Date) {
        self.date = date
        self.stops = stops
        self.route = route
        self.savedAt = savedAt
    }
}

public typealias DeliveryCache = EncryptedFileStore<DeliveryCacheSnapshot>

/// 証跡データの SHA-256（契約: 16進小文字 64 文字）と形式判定
public enum EvidenceHashing {
    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// マジックバイトから画像形式を判定（JPEG/PNG 以外は nil）
    public static func detectContentType(_ data: Data) -> EvidenceContentType? {
        let bytes = [UInt8](data.prefix(8))
        if bytes.count >= 3, bytes[0] == 0xFF, bytes[1] == 0xD8, bytes[2] == 0xFF { return .jpeg }
        if bytes.count >= 8, bytes == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] { return .png }
        return nil
    }

    /// 契約上の上限（15,000,000 バイト）
    public static let maxByteSize = 15_000_000
}

/// ファイル書込オプション（iOS ではデータ保護を付与）
public enum HDFileWriting {
    public static var protectedAtomic: Data.WritingOptions {
        #if os(iOS)
        return [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        return [.atomic]
        #endif
    }
}
