import XCTest
@testable import HappyDriveCore

/// 送信結果をスクリプトで制御するモック
final class ScriptedSender: MutationSender, @unchecked Sendable {
    enum Outcome {
        case ok
        case status(Int)
        case network
    }

    private let lock = NSLock()
    private var _sent: [(path: String, key: String, body: Data?)] = []
    private var _uploads: [String] = []
    /// path ごとの結果列（尽きたら ok）
    private var script: [String: [Outcome]] = [:]
    var uploadOutcome: Outcome = .ok

    var sent: [(path: String, key: String, body: Data?)] {
        lock.lock(); defer { lock.unlock() }
        return _sent
    }

    var uploads: [String] {
        lock.lock(); defer { lock.unlock() }
        return _uploads
    }

    func setScript(_ path: String, _ outcomes: [Outcome]) {
        lock.lock(); script[path] = outcomes; lock.unlock()
    }

    func send(_ mutation: PendingMutation, body: Data?) async throws -> HTTPResponse {
        lock.lock()
        _sent.append((mutation.path, mutation.idempotencyKey, body))
        var outcome = Outcome.ok
        if var list = script[mutation.path], !list.isEmpty {
            outcome = list.removeFirst()
            script[mutation.path] = list
        }
        lock.unlock()
        switch outcome {
        case .ok: return HTTPResponse(status: 200, body: Data(#"{"ok":true}"#.utf8))
        case .status(let s): throw APIError.server(status: s, body: APIErrorBody(code: "x", message: "エラー\(s)"))
        case .network: throw APIError.network(description: "offline")
        }
    }

    func uploadAttachment(_ attachment: PendingAttachment, data: Data) async throws -> String {
        lock.lock()
        _uploads.append(attachment.idempotencyKey)
        let outcome = uploadOutcome
        lock.unlock()
        switch outcome {
        case .ok: return "ev-\(attachment.localFileName)"
        case .status(let s): throw APIError.server(status: s, body: nil)
        case .network: throw APIError.network(description: "offline")
        }
    }
}

final class MemoryAttachmentStore: AttachmentStore, @unchecked Sendable {
    private let lock = NSLock()
    private var files: [String: Data] = [:]
    func save(_ data: Data, name: String) throws { lock.lock(); files[name] = data; lock.unlock() }
    func load(name: String) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        guard let d = files[name] else { throw CocoaError(.fileNoSuchFile) }
        return d
    }
    func delete(name: String) { lock.lock(); files[name] = nil; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return files.count }
}

final class OfflineQueueTests: XCTestCase {
    private func mutation(_ entity: String, _ path: String, key: String = IdempotencyKey.generate(), body: [String: Any] = ["eventType": "arrived"]) -> PendingMutation {
        PendingMutation(entityKey: entity, kind: .stopEvent, method: .post, path: path, body: try? JSONSerialization.data(withJSONObject: body), idempotencyKey: key)
    }

    func testReplaySendsInOrderAndClears() async {
        let sender = ScriptedSender()
        let queue = OfflineQueue(storage: InMemoryOfflineQueueStorage(), sender: sender)
        try? await queue.enqueue(mutation("stop:1", "/s/1/arrived"))
        try? await queue.enqueue(mutation("stop:2", "/s/2/arrived"))
        try? await queue.enqueue(mutation("stop:1", "/s/1/delivered"))
        let report = await queue.replay()
        XCTAssertEqual(report.sent.count, 3)
        XCTAssertEqual(sender.sent.map(\.path), ["/s/1/arrived", "/s/2/arrived", "/s/1/delivered"])
        let remaining = await queue.pendingCount
        XCTAssertEqual(remaining, 0)
    }

    func testNetworkFailureKeepsAllAndRetriesWithSameKey() async {
        let sender = ScriptedSender()
        sender.setScript("/s/1/arrived", [.network])
        let storage = InMemoryOfflineQueueStorage()
        let queue = OfflineQueue(storage: storage, sender: sender)
        let m1 = mutation("stop:1", "/s/1/arrived", key: "key-arrived-000000001")
        let m2 = mutation("stop:2", "/s/2/arrived", key: "key-arrived-000000002")
        try? await queue.enqueue(m1)
        try? await queue.enqueue(m2)

        let first = await queue.replay()
        XCTAssertTrue(first.sent.isEmpty)
        XCTAssertEqual(Set(first.kept), [m1.id, m2.id], "圏外なら残りも保持して中断")
        XCTAssertEqual(sender.sent.count, 1)
        let pending = await queue.pending
        XCTAssertEqual(pending.first?.attemptCount, 1)
        XCTAssertEqual(pending.first?.lastErrorMessage, APIError.network(description: "").userMessage)

        // 端末再起動を想定：同じ保存先から新しいキューを作る
        let restored = OfflineQueue(storage: storage, sender: sender)
        let restoredCount = await restored.pendingCount
        XCTAssertEqual(restoredCount, 2)
        let second = await restored.replay()
        XCTAssertEqual(second.sent.count, 2)
        XCTAssertEqual(sender.sent.map(\.key), ["key-arrived-000000001", "key-arrived-000000001", "key-arrived-000000002"], "再送は同じ Idempotency-Key")
    }

    func testServerErrorBlocksOnlySameEntityPreservingOrder() async {
        let sender = ScriptedSender()
        sender.setScript("/s/1/arrived", [.status(503)])
        let queue = OfflineQueue(storage: InMemoryOfflineQueueStorage(), sender: sender)
        let a = mutation("stop:1", "/s/1/arrived")
        let b = mutation("stop:1", "/s/1/delivered")
        let c = mutation("stop:2", "/s/2/arrived")
        for m in [a, b, c] { try? await queue.enqueue(m) }

        let report = await queue.replay()
        XCTAssertEqual(Array(report.sent.keys), [c.id], "別の対象は送信される")
        XCTAssertEqual(report.kept, [a.id])
        XCTAssertEqual(sender.sent.map(\.path), ["/s/1/arrived", "/s/2/arrived"], "stop:1 の後続は先行が保留の間は送らない")
        let pending = await queue.pending.map(\.id)
        XCTAssertEqual(pending, [a.id, b.id])

        let again = await queue.replay()
        XCTAssertEqual(Set(again.sent.keys), [a.id, b.id])
        XCTAssertEqual(sender.sent.map(\.path).suffix(2), ["/s/1/arrived", "/s/1/delivered"])
    }

    func testDropOn4xxButKeepOn408And429() async {
        let sender = ScriptedSender()
        sender.setScript("/a", [.status(422)])
        sender.setScript("/b", [.status(409)])
        sender.setScript("/c", [.status(408)])
        sender.setScript("/d", [.status(429)])
        let queue = OfflineQueue(storage: InMemoryOfflineQueueStorage(), sender: sender)
        let a = mutation("stop:a", "/a"), b = mutation("stop:b", "/b"), c = mutation("stop:c", "/c"), d = mutation("stop:d", "/d")
        for m in [a, b, c, d] { try? await queue.enqueue(m) }
        let report = await queue.replay()
        XCTAssertEqual(Set(report.dropped.map(\.id)), [a.id, b.id])
        XCTAssertEqual(report.dropped.first?.error.status, 422)
        XCTAssertEqual(Set(report.kept), [c.id, d.id])
        let dropped = await queue.recentlyDropped
        XCTAssertEqual(dropped.count, 2)
        let pending = await queue.pending.map(\.id)
        XCTAssertEqual(pending, [c.id, d.id])
    }

    func testSubmitReturnsSentQueuedOrThrows() async throws {
        let sender = ScriptedSender()
        let queue = OfflineQueue(storage: InMemoryOfflineQueueStorage(), sender: sender)
        let ok = try await queue.submit(mutation("stop:1", "/ok"))
        guard case .sent(let response) = ok else { return XCTFail("sent のはず") }
        XCTAssertEqual(response.status, 200)

        sender.setScript("/offline", [.network])
        let queued = try await queue.submit(mutation("stop:2", "/offline"))
        guard case .queued(let reason) = queued else { return XCTFail("queued のはず") }
        XCTAssertTrue(reason.contains("通信"))

        sender.setScript("/bad", [.status(422)])
        do {
            _ = try await queue.submit(mutation("stop:3", "/bad"))
            XCTFail("422 は例外")
        } catch let e as APIError {
            XCTAssertEqual(e.status, 422)
        }
        let dropped = await queue.recentlyDropped
        XCTAssertTrue(dropped.isEmpty, "submit で報告済みの破棄は一覧に残さない")
    }

    func testConcurrentReplaysDoNotDoubleSend() async {
        let sender = ScriptedSender()
        let queue = OfflineQueue(storage: InMemoryOfflineQueueStorage(), sender: sender)
        for i in 0..<20 { try? await queue.enqueue(mutation("stop:\(i % 3)", "/p/\(i)")) }
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<5 { group.addTask { await queue.replay() } }
        }
        XCTAssertEqual(sender.sent.count, 20, "並行して replay しても各操作は 1 回だけ送信")
        XCTAssertEqual(Set(sender.sent.map(\.key)).count, 20)
    }

    func testAttachmentsUploadedOnceAndMergedIntoBody() async throws {
        let sender = ScriptedSender()
        let files = MemoryAttachmentStore()
        let queue = OfflineQueue(storage: InMemoryOfflineQueueStorage(), sender: sender, attachments: files)
        var m = mutation("stop:1", "/stops/1/events", body: ["eventType": "delivered", "handoff": "in_person", "evidenceIds": ["ev-existing"]])
        m.attachments = [
            PendingAttachment(localFileName: "photo1", contentType: .jpeg, purpose: .delivery_photo, deliveryStopId: "1", idempotencyKey: "upload-key-000000001"),
            PendingAttachment(localFileName: "sig1", contentType: .png, purpose: .signature, deliveryStopId: "1", idempotencyKey: "upload-key-000000002"),
        ]
        sender.setScript("/stops/1/events", [.network])
        let result = try await queue.submit(m, attachmentData: ["photo1": Data([1, 2, 3]), "sig1": Data([4])])
        guard case .queued = result else { return XCTFail() }
        XCTAssertEqual(sender.uploads, ["upload-key-000000001", "upload-key-000000002"])
        let pending = await queue.pending
        XCTAssertEqual(pending.first?.attachments.compactMap(\.uploadedEvidenceId), ["ev-photo1", "ev-sig1"], "アップロード済み ID は保存される")

        _ = await queue.replay()
        XCTAssertEqual(sender.uploads.count, 2, "再送時に同じ写真を再アップロードしない")
        let lastBody = try XCTUnwrap(sender.sent.last?.body)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: lastBody) as? [String: Any])
        XCTAssertEqual(obj["evidenceIds"] as? [String], ["ev-existing", "ev-photo1", "ev-sig1"])
        XCTAssertEqual(obj["handoff"] as? String, "in_person")
        XCTAssertEqual(files.count, 0, "送信後に一時ファイルを削除")
    }

    func testObserverReceivesChanges() async throws {
        let sender = ScriptedSender()
        let queue = OfflineQueue(storage: InMemoryOfflineQueueStorage(), sender: sender)
        let counts = Locked<[Int]>([])
        await queue.addObserver { items in counts.mutate { $0.append(items.count) } }
        try await queue.enqueue(mutation("stop:1", "/x"))
        _ = await queue.replay()
        XCTAssertEqual(counts.get(), [0, 1, 0])
    }

    func testEncryptedFileStorageRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("hdq-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("queue.bin")
        let sealer = AESGCMSealer(keyProvider: StaticKeyProvider.random())
        let storage = FileOfflineQueueStorage(url: url, sealer: sealer)
        var m = mutation("stop:1", "/secret", body: ["failureNote": "佐藤様 不在"])
        m.createdAt = Date(timeIntervalSince1970: 1_790_000_000.25)
        try storage.save([m])
        let raw = try Data(contentsOf: url)
        XCTAssertNil(raw.range(of: Data("secret".utf8)), "平文で保存しない")
        XCTAssertEqual(try storage.load(), [m])

        // 鍵が変わると読めない → 空として扱う
        let other = FileOfflineQueueStorage(url: url, sealer: AESGCMSealer(keyProvider: StaticKeyProvider.random()))
        XCTAssertEqual(try other.load(), [])

        try storage.save([])
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testStopEventMutationBuilder() throws {
        let api = HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: MockTransport { _ in HTTPResponse(status: 200) }, tokenStore: InMemoryTokenStore()))
        XCTAssertThrowsError(try api.stopEventMutation(stopId: "s1", event: StopEventRequest(eventType: .failed)))
        let occurred = try XCTUnwrap(HDJSON.parseDateTime("2026-09-26T01:02:03Z"))
        let m = try api.stopEventMutation(stopId: "s1", event: StopEventRequest(eventType: .arrived, occurredAt: occurred), idempotencyKey: "stop-event-key-0001")
        XCTAssertEqual(m.path, "/delivery/stops/s1/events")
        XCTAssertEqual(m.entityKey, "stop:s1")
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: m.body ?? Data()) as? [String: Any])
        XCTAssertEqual(obj["occurredAt"] as? String, "2026-09-26T01:02:03Z", "端末で記録した時刻を保持")
    }
}
