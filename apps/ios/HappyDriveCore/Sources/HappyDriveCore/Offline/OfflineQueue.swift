import Foundation

/// 送信待ちの証跡（写真・署名）。再送時に先にアップロードし、得た evidenceId を本文に差し込む。
public struct PendingAttachment: Codable, Sendable, Hashable {
    public var localFileName: String
    public var contentType: EvidenceContentType
    public var purpose: EvidencePurpose
    public var assignmentId: String?
    public var deliveryStopId: String?
    /// POST /evidence/uploads 用。再送でも同じキーを使う。
    public var idempotencyKey: String
    public var uploadedEvidenceId: String?

    public init(localFileName: String, contentType: EvidenceContentType, purpose: EvidencePurpose, assignmentId: String? = nil, deliveryStopId: String? = nil, idempotencyKey: String = IdempotencyKey.generate(), uploadedEvidenceId: String? = nil) {
        self.localFileName = localFileName
        self.contentType = contentType
        self.purpose = purpose
        self.assignmentId = assignmentId
        self.deliveryStopId = deliveryStopId
        self.idempotencyKey = idempotencyKey
        self.uploadedEvidenceId = uploadedEvidenceId
    }
}

/// 端末に一時保存する書込操作。接続復帰後に同じ Idempotency-Key で再送し、サーバー側で重複を排除する。
public struct PendingMutation: Codable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case stopEvent
        case assignmentEvent
        case other
    }

    public var id: UUID
    /// 同一対象（"stop:<id>" / "assignment:<id>"）の操作は記録順に送る
    public var entityKey: String
    public var kind: Kind
    public var method: HTTPMethod
    public var path: String
    public var body: Data?
    public var idempotencyKey: String
    public var createdAt: Date
    public var attemptCount: Int
    public var lastErrorMessage: String?
    public var attachments: [PendingAttachment]

    public init(id: UUID = UUID(), entityKey: String, kind: Kind, method: HTTPMethod, path: String, body: Data?, idempotencyKey: String, createdAt: Date = Date(), attemptCount: Int = 0, lastErrorMessage: String? = nil, attachments: [PendingAttachment] = []) {
        self.id = id
        self.entityKey = entityKey
        self.kind = kind
        self.method = method
        self.path = path
        self.body = body
        self.idempotencyKey = idempotencyKey
        self.createdAt = createdAt
        self.attemptCount = attemptCount
        self.lastErrorMessage = lastErrorMessage
        self.attachments = attachments
    }

    /// アップロード済み証跡の ID を本文の evidenceIds に追加した本文
    public func bodyMergingUploadedEvidence() throws -> Data? {
        let uploaded = attachments.compactMap { $0.uploadedEvidenceId }
        guard !uploaded.isEmpty else { return body }
        var object: [String: JSONValue] = [:]
        if let body, !body.isEmpty {
            object = try HDJSON.makeDecoder().decode([String: JSONValue].self, from: body)
        }
        var ids = object["evidenceIds"]?.stringArray ?? []
        for id in uploaded where !ids.contains(id) { ids.append(id) }
        object["evidenceIds"] = .array(ids.map { .string($0) })
        return try HDJSON.makeEncoder().encode(object)
    }
}

/// 破棄された操作（4xx）。画面で利用者に知らせる。
public struct DroppedMutation: Sendable, Hashable, Identifiable {
    public var mutation: PendingMutation
    public var error: APIError
    public var id: UUID { mutation.id }
}

public struct ReplayReport: Sendable {
    public var sent: [UUID: HTTPResponse] = [:]
    public var dropped: [DroppedMutation] = []
    public var kept: [UUID] = []
    public init() {}
}

public enum SubmitResult: Sendable {
    /// 送信できた（応答本文付き）
    case sent(HTTPResponse)
    /// 圏外等で保留。接続復帰後に自動送信する。
    case queued(reason: String)
}

/// 送信処理（アプリでは API クライアント実装、テストではモック）
public protocol MutationSender: Sendable {
    func send(_ mutation: PendingMutation, body: Data?) async throws -> HTTPResponse
    func uploadAttachment(_ attachment: PendingAttachment, data: Data) async throws -> String
}

public protocol OfflineQueueStorage: Sendable {
    func load() throws -> [PendingMutation]
    func save(_ items: [PendingMutation]) throws
}

public protocol AttachmentStore: Sendable {
    func save(_ data: Data, name: String) throws
    func load(name: String) throws -> Data
    func delete(name: String)
}

/// オフラインキュー。
/// - 記録順（FIFO）に送信し、同じ対象の操作は前の操作が保留中なら後続も保留（順序を保証）
/// - 4xx（408/429 を除く）は破棄して利用者に通知、5xx・通信失敗・408/429 は保持して再送
/// - 再送は常に同じ Idempotency-Key を使う
public actor OfflineQueue {
    private var items: [PendingMutation]
    private let storage: OfflineQueueStorage
    private let sender: MutationSender
    private let attachments: AttachmentStore?
    private var replayChain: Task<ReplayReport, Never>?
    private var observers: [UUID: @Sendable ([PendingMutation]) -> Void] = [:]
    public private(set) var recentlyDropped: [DroppedMutation] = []

    public init(storage: OfflineQueueStorage, sender: MutationSender, attachments: AttachmentStore? = nil) {
        self.storage = storage
        self.sender = sender
        self.attachments = attachments
        self.items = (try? storage.load()) ?? []
    }

    public var pending: [PendingMutation] { items }
    public var pendingCount: Int { items.count }

    public func pending(entityKey: String) -> [PendingMutation] {
        items.filter { $0.entityKey == entityKey }
    }

    @discardableResult
    public func addObserver(_ observer: @escaping @Sendable ([PendingMutation]) -> Void) -> UUID {
        let id = UUID()
        observers[id] = observer
        observer(items)
        return id
    }

    public func removeObserver(_ id: UUID) {
        observers[id] = nil
    }

    public func clearDropped() {
        recentlyDropped.removeAll()
    }

    /// すべて破棄（ログアウト時）
    public func removeAll() {
        for item in items {
            for a in item.attachments { attachments?.delete(name: a.localFileName) }
        }
        items.removeAll()
        persist()
    }

    public func enqueue(_ mutation: PendingMutation, attachmentData: [String: Data] = [:]) throws {
        for (name, data) in attachmentData {
            guard let store = attachments else { throw APIError.invalidInput(message: "証跡の一時保存先がありません") }
            try store.save(data, name: name)
        }
        items.append(mutation)
        persist()
    }

    /// 記録して即時送信を試みる。送れなければ保留（.queued）、4xx なら APIError を投げる。
    public func submit(_ mutation: PendingMutation, attachmentData: [String: Data] = [:]) async throws -> SubmitResult {
        try enqueue(mutation, attachmentData: attachmentData)
        let report = await replay()
        if let response = report.sent[mutation.id] {
            return .sent(response)
        }
        if let dropped = report.dropped.first(where: { $0.mutation.id == mutation.id }) {
            recentlyDropped.removeAll { $0.id == dropped.id }
            throw dropped.error
        }
        let reason = items.first(where: { $0.id == mutation.id })?.lastErrorMessage ?? "送信待ちです。通信が回復すると自動で送信します。"
        return .queued(reason: reason)
    }

    /// 保留中の操作を送信する。同時に呼ばれても直列に実行する。
    @discardableResult
    public func replay() async -> ReplayReport {
        let previous = replayChain
        let task = Task<ReplayReport, Never> {
            _ = await previous?.value
            return await self.runReplay()
        }
        replayChain = task
        return await task.value
    }

    // MARK: - 内部

    private func runReplay() async -> ReplayReport {
        var report = ReplayReport()
        var blocked = Set<String>()
        var processed = Set<UUID>()

        while let next = items.first(where: { !processed.contains($0.id) && !blocked.contains($0.entityKey) }) {
            processed.insert(next.id)
            do {
                var mutation = next
                for i in mutation.attachments.indices where mutation.attachments[i].uploadedEvidenceId == nil {
                    guard let store = attachments else {
                        throw APIError.invalidInput(message: "証跡ファイルが見つかりません")
                    }
                    let data: Data
                    do {
                        data = try store.load(name: mutation.attachments[i].localFileName)
                    } catch {
                        throw APIError.invalidInput(message: "端末に保存した証跡ファイルを読み込めませんでした")
                    }
                    let evidenceId = try await sender.uploadAttachment(mutation.attachments[i], data: data)
                    mutation.attachments[i].uploadedEvidenceId = evidenceId
                    replace(mutation)
                }
                let body = try mutation.bodyMergingUploadedEvidence()
                let response = try await sender.send(mutation, body: body)
                remove(mutation.id, deleteAttachments: true)
                report.sent[mutation.id] = response
            } catch {
                let apiError = Self.classify(error)
                if apiError.isRetryable {
                    markAttempt(next.id, message: apiError.userMessage)
                    report.kept.append(next.id)
                    blocked.insert(next.entityKey)
                    // 圏外・ログイン切れの場合は他の操作も失敗するため中断
                    if apiError.isNetworkError || apiError == .sessionExpired {
                        for item in items where !processed.contains(item.id) {
                            report.kept.append(item.id)
                        }
                        break
                    }
                } else {
                    let current = items.first(where: { $0.id == next.id }) ?? next
                    remove(next.id, deleteAttachments: true)
                    let dropped = DroppedMutation(mutation: current, error: apiError)
                    report.dropped.append(dropped)
                    recentlyDropped.append(dropped)
                }
            }
        }
        return report
    }

    static func classify(_ error: Error) -> APIError {
        if let api = error as? APIError { return api }
        if error is CancellationError { return .network(description: "中断されました") }
        if error is EncodingError || error is DecodingError { return .decoding(description: String(describing: error)) }
        return .network(description: String(describing: error))
    }

    private func replace(_ mutation: PendingMutation) {
        if let i = items.firstIndex(where: { $0.id == mutation.id }) {
            items[i] = mutation
            persist()
        }
    }

    private func markAttempt(_ id: UUID, message: String) {
        if let i = items.firstIndex(where: { $0.id == id }) {
            items[i].attemptCount += 1
            items[i].lastErrorMessage = message
            persist()
        }
    }

    private func remove(_ id: UUID, deleteAttachments: Bool) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let removed = items.remove(at: i)
        if deleteAttachments {
            for a in removed.attachments { attachments?.delete(name: a.localFileName) }
        }
        persist()
    }

    private func persist() {
        try? storage.save(items)
        let snapshot = items
        for observer in observers.values { observer(snapshot) }
    }
}

// MARK: - 保存先

public final class InMemoryOfflineQueueStorage: OfflineQueueStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [PendingMutation]
    public private(set) var saveCount = 0

    public init(items: [PendingMutation] = []) {
        self.items = items
    }

    public func load() throws -> [PendingMutation] {
        lock.lock(); defer { lock.unlock() }
        return items
    }

    public func save(_ items: [PendingMutation]) throws {
        lock.lock(); defer { lock.unlock() }
        self.items = items
        saveCount += 1
    }
}

/// 暗号化してファイルに保存するキュー（位置・メモ等を含むため平文で置かない）
public final class FileOfflineQueueStorage: OfflineQueueStorage, @unchecked Sendable {
    private let store: EncryptedFileStore<[PendingMutation]>

    public init(url: URL, sealer: DataSealer) {
        self.store = EncryptedFileStore(url: url, sealer: sealer)
    }

    public func load() throws -> [PendingMutation] {
        store.load() ?? []
    }

    public func save(_ items: [PendingMutation]) throws {
        if items.isEmpty {
            store.clear()
        } else {
            try store.save(items)
        }
    }
}

/// 暗号化してディレクトリに保存する証跡の一時置き場
public final class FileAttachmentStore: AttachmentStore, @unchecked Sendable {
    private let directory: URL
    private let sealer: DataSealer

    public init(directory: URL, sealer: DataSealer) {
        self.directory = directory
        self.sealer = sealer
    }

    private func url(_ name: String) -> URL {
        // ファイル名はアプリが生成した UUID のみを想定。パス区切りは除去する。
        let safe = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "..", with: "_")
        return directory.appendingPathComponent(safe)
    }

    public func save(_ data: Data, name: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try sealer.seal(data).write(to: url(name), options: HDFileWriting.protectedAtomic)
    }

    public func load(name: String) throws -> Data {
        try sealer.open(Data(contentsOf: url(name)))
    }

    public func delete(name: String) {
        try? FileManager.default.removeItem(at: url(name))
    }
}

/// API クライアントによる送信実装
public struct APIMutationSender: MutationSender {
    private let api: HappyDriveAPI

    public init(api: HappyDriveAPI) {
        self.api = api
    }

    public func send(_ mutation: PendingMutation, body: Data?) async throws -> HTTPResponse {
        try await api.client.perform(method: mutation.method, path: mutation.path, body: body, idempotencyKey: mutation.idempotencyKey)
    }

    public func uploadAttachment(_ attachment: PendingAttachment, data: Data) async throws -> String {
        let evidence = try await api.uploadEvidence(
            data: data,
            contentType: attachment.contentType,
            purpose: attachment.purpose,
            assignmentId: attachment.assignmentId,
            deliveryStopId: attachment.deliveryStopId,
            idempotencyKey: attachment.idempotencyKey
        )
        return evidence.id
    }
}
