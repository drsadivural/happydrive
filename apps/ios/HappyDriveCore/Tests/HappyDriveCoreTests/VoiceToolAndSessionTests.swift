import XCTest
@testable import HappyDriveCore

private let allTools = VoiceToolName.allCases.map(\.rawValue)
private let fixedNow = Date(timeIntervalSince1970: 1_790_380_800) // 2026-09-26T00:00:00Z（JST 09:00）

private func object(_ output: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any]) ?? [:]
}

private func errorCode(_ result: VoiceToolResult) -> String? {
    (object(result.output)["error"] as? [String: Any])?["code"] as? String
}

private func makeAPI(_ handler: @escaping MockTransport.Handler) -> (HappyDriveAPI, MockTransport) {
    let transport = MockTransport(handler: handler)
    let store = InMemoryTokenStore(tokens: tokens(access: "A1", refresh: "R1"))
    return (HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store)), transport)
}

private func fixture(_ name: String) -> HTTPResponse {
    HTTPResponse(status: 200, headers: ["content-type": "application/json"], body: (try? Fixture.data(name)) ?? Data())
}

final class VoiceToolDispatcherTests: XCTestCase {
    private func dispatcher(_ api: HappyDriveAPI, tools: [String] = allTools, timeout: TimeInterval = 2, location: GeoPoint? = nil) -> VoiceToolDispatcher {
        VoiceToolDispatcher(api: api, serverTools: tools, timeout: timeout, location: { location }, now: { fixedNow })
    }

    func testAllowlistIsIntersectionWithServerTools() async {
        let (api, transport) = makeAPI { _ in XCTFail("実行されてはいけない"); return json(500, [:]) }
        let d = dispatcher(api, tools: ["get_today_overview", "delete_account", "search_jobs"])
        XCTAssertEqual(d.enabledTools, [.get_today_overview, .search_jobs])
        let r1 = await d.execute(name: "get_earnings_summary", arguments: "{}")
        XCTAssertFalse(r1.succeeded)
        XCTAssertEqual(errorCode(r1), "unknown_tool", "サーバーが有効にしていないツールは実行しない")
        let r2 = await d.execute(name: "delete_account", arguments: "{}")
        XCTAssertEqual(errorCode(r2), "unknown_tool", "許可リストに無いツールは実行しない")
        XCTAssertEqual((object(r2.output)["error"] as? [String: Any])?["message"] as? String, "この機能は利用できません。")
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testMalformedAndInvalidArgumentsNeverExecute() async {
        let (api, transport) = makeAPI { _ in XCTFail("実行されてはいけない"); return json(500, [:]) }
        let d = dispatcher(api)
        let cases: [(String, String)] = [
            ("list_delivery_stops", "{not json"),
            ("list_delivery_stops", "[1]"),
            ("list_delivery_stops", #"{"date":20260926}"#),
            ("list_delivery_stops", #"{"date":"2026/09/26"}"#),
            ("list_delivery_stops", #"{"date":"2026-02-30"}"#),
            ("list_delivery_stops", #"{"date":"26-09-26"}"#),
            ("list_delivery_stops", #"{"extra":"x"}"#),
            ("search_jobs", #"{"category":"personal_care"}"#),
            ("search_jobs", #"{"sort":"cheapest"}"#),
            ("search_jobs", #"{"keyword":true}"#),
            ("search_jobs", "{\"keyword\":\"" + String(repeating: "あ", count: 101) + "\"}"),
            ("get_job_details", "{}"),
            ("get_job_details", #"{"jobId":"123"}"#),
            ("get_job_details", #"{"jobId":null}"#),
            ("list_my_assignments", #"{"scope":"all"}"#),
            ("get_earnings_summary", #"{"month":"2026-13"}"#),
            ("get_earnings_summary", #"{"month":"2026-9"}"#),
            ("get_today_overview", #"{"date":"2026-09-26"}"#),
        ]
        for (name, args) in cases {
            let r = await d.execute(name: name, arguments: args)
            XCTAssertFalse(r.succeeded, "\(name) \(args)")
            XCTAssertEqual(r.errorCode, "invalid_arguments", "\(name) \(args)")
            XCTAssertEqual(errorCode(r), "invalid_arguments")
            let message = (object(r.output)["error"] as? [String: Any])?["message"] as? String
            XCTAssertFalse(message?.isEmpty ?? true)
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testTodayOverviewSummary() async throws {
        let (api, transport) = makeAPI { _ in fixture("home") }
        let r = await dispatcher(api, location: GeoPoint(latitude: 35.44371, longitude: 139.65029)).execute(name: "get_today_overview", arguments: "")
        XCTAssertTrue(r.succeeded, r.output)
        let o = object(r.output)
        XCTAssertEqual(o["date"] as? String, "2026-09-26")
        XCTAssertEqual((o["deliveryStops"] as? [String: Any])?["total"] as? Int, 12)
        XCTAssertEqual((o["deliveryStops"] as? [String: Any])?["completed"] as? Int, 3)
        XCTAssertEqual(o["expectedEarningsYen"] as? Int, 8400)
        XCTAssertEqual(o["unreadNotificationCount"] as? Int, 3)
        let req = try XCTUnwrap(transport.requests.first)
        XCTAssertTrue(req.url.path.hasSuffix("/home"))
        XCTAssertEqual(req.headers["Authorization"], "Bearer A1")
        XCTAssertTrue(req.url.query?.contains("latitude=35.444") ?? false, "位置は丸めて送る")
    }

    func testDeliveryStopsDefaultsToTodayJSTAndOmitsRecipient() async throws {
        let (api, transport) = makeAPI { _ in fixture("stops") }
        let r = await dispatcher(api).execute(name: "list_delivery_stops", arguments: "{}")
        XCTAssertTrue(r.succeeded, r.output)
        XCTAssertEqual(transport.requests.first?.url.query, "date=2026-09-26")
        let o = object(r.output)
        XCTAssertEqual(o["count"] as? Int, 3)
        let stops = try XCTUnwrap(o["stops"] as? [[String: Any]])
        XCTAssertEqual(stops.count, 3)
        XCTAssertNotNil(stops.first?["address"] as? String)
        XCTAssertNotNil(stops.first?["statusLabel"] as? String)
        XCTAssertFalse(r.output.contains("recipientName"), "受取人の個人情報をモデルに渡さない")
        XCTAssertFalse(r.output.contains("latitude"))

        let explicit = await dispatcher(api).execute(name: "list_delivery_stops", arguments: #"{"date":"2026-09-27"}"#)
        XCTAssertTrue(explicit.succeeded)
        XCTAssertEqual(transport.requests.last?.url.query, "date=2026-09-27")
    }

    func testSearchJobsBuildsQueryAndSummarizes() async throws {
        let (api, transport) = makeAPI { _ in fixture("job_search") }
        let r = await dispatcher(api).execute(name: "search_jobs", arguments: #"{"keyword":" 買い物 ","category":"shopping_assist","date":"2026-09-26","sort":"amount"}"#)
        XCTAssertTrue(r.succeeded, r.output)
        let query = try XCTUnwrap(transport.requests.first?.url.query)
        XCTAssertTrue(query.contains("category=shopping_assist"))
        XCTAssertTrue(query.contains("sort=amount"))
        XCTAssertTrue(query.contains("date=2026-09-26"))
        XCTAssertTrue(query.contains("limit=5"))
        XCTAssertTrue(query.contains("q=%E8%B2%B7"), "キーワードは前後の空白を除いて送る: \(query)")
        let jobs = try XCTUnwrap(object(r.output)["jobs"] as? [[String: Any]])
        let first = try XCTUnwrap(jobs.first)
        XCTAssertEqual(first["jobId"] as? String, "4e5f6a7b-0000-4c1e-9a53-0f4b8e2d1a31")
        XCTAssertEqual(first["amountYen"] as? Int, 900)
        XCTAssertEqual(first["startsAt"] as? String, "2026-09-26T15:00:00+09:00", "日時は JST")
        XCTAssertNotNil(first["categoryLabel"] as? String)
        XCTAssertNil(first["organizationContact"], "連絡先はモデルに渡さない")
    }

    func testJobDetailsValidatesUUIDAndUsesPath() async throws {
        let (api, transport) = makeAPI { _ in
            let page = try JSONSerialization.jsonObject(with: Fixture.data("job_search")) as? [String: Any]
            let job = (page?["items"] as? [Any])?.first ?? [:]
            return json(200, job)
        }
        let r = await dispatcher(api).execute(name: "get_job_details", arguments: #"{"jobId":"4E5F6A7B-0000-4C1E-9A53-0F4B8E2D1A31"}"#)
        XCTAssertTrue(r.succeeded, r.output)
        XCTAssertEqual(transport.requests.first?.url.path, "/v1/jobs/4e5f6a7b-0000-4c1e-9a53-0f4b8e2d1a31")
        let o = object(r.output)
        XCTAssertEqual(o["title"] as? String, "買い物付き添い")
        XCTAssertNotNil(o["cancellationPolicy"] as? String)
    }

    func testAssignmentsEarningsNotifications() async throws {
        let (api, transport) = makeAPI { req in
            if req.url.path.hasSuffix("/assignments") {
                let a = try JSONSerialization.jsonObject(with: Fixture.data("assignment"))
                return json(200, [a])
            }
            if req.url.path.hasSuffix("/earnings/summary") { return fixture("earnings_summary") }
            if req.url.path.hasSuffix("/notifications") { return fixture("notifications") }
            return json(404, [:])
        }
        let d = dispatcher(api)
        let a = await d.execute(name: "list_my_assignments", arguments: "{}")
        XCTAssertTrue(a.succeeded, a.output)
        XCTAssertEqual(transport.requests.last?.url.query, "scope=active")
        XCTAssertEqual(object(a.output)["count"] as? Int, 1)

        let e = await d.execute(name: "get_earnings_summary", arguments: "{}")
        XCTAssertTrue(e.succeeded, e.output)
        XCTAssertEqual(transport.requests.last?.url.query, "month=2026-09")
        XCTAssertEqual(object(e.output)["totalYen"] as? Int, 36450)

        let n = await d.execute(name: "list_unread_notifications", arguments: "{}")
        XCTAssertTrue(n.succeeded, n.output)
        XCTAssertEqual(transport.requests.last?.url.query, "unreadOnly=true")
        XCTAssertEqual(object(n.output)["count"] as? Int, 1, "既読は除く")
    }

    func testAPIErrorBecomesStructuredJapaneseError() async {
        let (api, _) = makeAPI { _ in errorResponse(404, code: "not_found", message: "案件が見つかりません") }
        let r = await dispatcher(api).execute(name: "get_job_details", arguments: #"{"jobId":"4e5f6a7b-0000-4c1e-9a53-0f4b8e2d1a31"}"#)
        XCTAssertFalse(r.succeeded)
        XCTAssertEqual(r.errorCode, "not_found")
        XCTAssertEqual((object(r.output)["error"] as? [String: Any])?["message"] as? String, "案件が見つかりません")
    }

    func testTimeout() async {
        let (api, _) = makeAPI { _ in
            try await Task.sleep(nanoseconds: 5_000_000_000)
            return fixture("home")
        }
        let started = Date()
        let r = await dispatcher(api, timeout: 0.2).execute(name: "get_today_overview", arguments: "{}")
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        XCTAssertFalse(r.succeeded)
        XCTAssertEqual(r.errorCode, "timeout")
    }

    func testArgumentHelpers() {
        XCTAssertTrue(ToolArguments.isValidDate("2028-02-29"))
        XCTAssertFalse(ToolArguments.isValidDate("2026-02-29"))
        XCTAssertFalse(ToolArguments.isValidDate("２０２６-09-26"))
        XCTAssertTrue(ToolArguments.isValidMonth("2026-01"))
        XCTAssertFalse(ToolArguments.isValidMonth("2026-00"))
        XCTAssertEqual(VoiceToolDispatcher.shortAddress("〒231-0023 神奈川県横浜市中区山下町1-2-3"), "神奈川県横浜市中区山下町1-2-3")
        XCTAssertEqual(VoiceToolDispatcher.shortAddress(String(repeating: "あ", count: 50)).count, 41)
    }
}

final class VoiceErrorAndPolicyTests: XCTestCase {
    func testAPIErrorMapping() {
        XCTAssertEqual(VoiceError.from(APIError.server(status: 503, body: APIErrorBody(code: "voice_unavailable", message: "音声アシスタントは現在ご利用いただけません"))),
                       .unavailable(message: "音声アシスタントは現在ご利用いただけません"))
        XCTAssertEqual(VoiceError.from(APIError.server(status: 503, body: nil)), .unavailable(message: nil))
        XCTAssertEqual(VoiceError.from(APIError.server(status: 429, body: APIErrorBody(code: "rate_limited", message: "上限です"))), .rateLimited(message: "上限です"))
        XCTAssertEqual(VoiceError.from(APIError.server(status: 401, body: nil)), .authExpired)
        XCTAssertEqual(VoiceError.from(APIError.sessionExpired), .authExpired)
        XCTAssertEqual(VoiceError.from(APIError.server(status: 403, body: APIErrorBody(code: "suspended", message: "停止中"))), .forbidden(message: "停止中"))
        XCTAssertEqual(VoiceError.from(APIError.network(description: "offline")), .connectionFailed)
        XCTAssertEqual(VoiceError.from(APIError.server(status: 500, body: nil)), .connectionFailed)
        XCTAssertEqual(VoiceError.from(APIError.server(status: 422, body: APIErrorBody(code: "validation", message: "x"))), .server(code: "validation"))
        XCTAssertEqual(VoiceError.from(VoiceError.microphoneDenied), .microphoneDenied)
        XCTAssertEqual(VoiceError.from(CancellationError()), .unknown)
    }

    func testJapaneseMessagesAndRetryability() {
        XCTAssertTrue(VoiceError.microphoneDenied.userMessage.contains("マイクの使用が許可されていません"))
        XCTAssertTrue(VoiceError.connectionFailed.userMessage.hasPrefix("接続できませんでした"))
        XCTAssertTrue(VoiceError.connectionLost.userMessage.hasPrefix("通信が切れました"))
        XCTAssertTrue(VoiceError.unavailable(message: nil).userMessage.hasPrefix("音声機能は現在ご利用いただけません"))
        XCTAssertTrue(VoiceError.rateLimited(message: nil).userMessage.hasPrefix("利用回数の上限に達しました"))
        XCTAssertEqual(VoiceError.rateLimited(message: "  ").userMessage, VoiceError.rateLimited(message: nil).userMessage)
        XCTAssertFalse(VoiceError.authExpired.isRetryable)
        XCTAssertFalse(VoiceError.forbidden(message: nil).isRetryable)
        XCTAssertTrue(VoiceError.unavailable(message: nil).isRetryable)
        XCTAssertEqual(VoiceError.authExpired.endReason, .auth_expired)
        XCTAssertEqual(VoiceError.maxDurationReached.endReason, .max_duration)
        XCTAssertEqual(VoiceError.unavailable(message: nil).endReason, .error)
        XCTAssertEqual(VoiceError.server(code: nil).metricCode, "realtime_error")
    }

    func testReconnectPolicyIsBoundedWithJitter() {
        let policy = ReconnectPolicy()
        XCTAssertEqual(policy.maxAttempts, 3)
        XCTAssertNil(policy.delay(forAttempt: 0))
        XCTAssertNil(policy.delay(forAttempt: 4))
        XCTAssertEqual(policy.delay(forAttempt: 1, random: 0), 0.25)
        XCTAssertEqual(policy.delay(forAttempt: 1, random: 1), 0.5)
        XCTAssertEqual(policy.delay(forAttempt: 3, random: 1), 2)
        for attempt in 1...3 {
            for _ in 0..<50 {
                let d = policy.delay(forAttempt: attempt)!
                let ceiling = policy.ceilingDelay(forAttempt: attempt)
                XCTAssertGreaterThanOrEqual(d, ceiling / 2)
                XCTAssertLessThanOrEqual(d, ceiling)
            }
        }
        let long = ReconnectPolicy(maxAttempts: 10, baseDelay: 0.5, maxDelay: 8)
        XCTAssertEqual(long.ceilingDelay(forAttempt: 10), 8, "上限で頭打ち")
        XCTAssertEqual(long.delay(forAttempt: 10, random: 5), 8, "random は 0...1 に丸める")
        XCTAssertTrue(policy.canRetry(afterAttempt: 2))
        XCTAssertFalse(policy.canRetry(afterAttempt: 3))
    }

    func testConfigurationAppliesServerLimits() {
        let session = VoiceSession(sessionId: "s", clientSecret: "ek_x", expiresAt: Date(), model: "m", voice: "v", callUrl: URL(string: "https://example.com")!, maxDurationSeconds: 600, idleTimeoutSeconds: 60, tools: [])
        let c = VoiceConfiguration.default.applying(session)
        XCTAssertEqual(c.idleTimeout, 60)
        XCTAssertEqual(c.maxDuration, 600)
        XCTAssertEqual(c.connectTimeout, 15)
        XCTAssertEqual(c.toolTimeout, 8)
        var zero = session
        zero.idleTimeoutSeconds = 0
        zero.maxDurationSeconds = -1
        XCTAssertEqual(VoiceConfiguration.default.applying(zero).idleTimeout, 120)
        XCTAssertEqual(VoiceConfiguration.default.applying(zero).maxDuration, 900)
    }
}

final class VoiceMetricsTests: XCTestCase {
    func testPercentiles() {
        XCTAssertNil(VoiceMetricsRecorder.percentile([], 50))
        XCTAssertEqual(VoiceMetricsRecorder.percentile([42], 95), 42)
        let values = Array(1...100)
        XCTAssertEqual(VoiceMetricsRecorder.percentile(values.shuffled(), 50), 50)
        XCTAssertEqual(VoiceMetricsRecorder.percentile(values, 95), 95)
        XCTAssertEqual(VoiceMetricsRecorder.percentile([300, 100, 200], 50), 200)
        XCTAssertEqual(VoiceMetricsRecorder.percentile([300, 100, 200], 95), 300)
        XCTAssertEqual(VoiceMetricsRecorder.percentile([5, 1], 0), 1)
    }

    func testRecorderSummary() throws {
        let t = Date(timeIntervalSince1970: 1_000)
        var m = VoiceMetricsRecorder()
        m.sessionStarted(at: t)
        m.connectStarted(at: t)
        m.connected(at: t.addingTimeInterval(0.8))
        m.userTurnEnded(at: t.addingTimeInterval(5))
        m.assistantAudioStarted(at: t.addingTimeInterval(5.6))
        m.assistantAudioStarted(at: t.addingTimeInterval(9)) // 起点が無い再生は数えない
        m.interruptionStarted(at: t.addingTimeInterval(10))
        m.assistantAudioStopped(at: t.addingTimeInterval(10.15))
        m.userTurnEnded(at: t.addingTimeInterval(20))
        m.assistantAudioStarted(at: t.addingTimeInterval(20.9))
        m.toolFinished(latencyMs: 300, succeeded: true)
        m.toolFinished(latencyMs: 900, succeeded: false)
        m.reconnected()
        m.connectStarted(at: t.addingTimeInterval(30))
        m.connected(at: t.addingTimeInterval(33)) // 再接続の時間は connectMs を上書きしない
        m.recordError(code: String(repeating: "x", count: 100))
        let s = m.summary(endReason: .user_ended, endedAt: t.addingTimeInterval(61.4))
        XCTAssertEqual(s.durationSeconds, 61)
        XCTAssertEqual(s.connectMs, 800)
        XCTAssertEqual(s.userTurns, 2)
        XCTAssertEqual(s.firstAudioLatencyMsP50, 600)
        XCTAssertEqual(s.firstAudioLatencyMsP95, 900)
        XCTAssertEqual(s.interruptionStopMsP50, 150)
        XCTAssertEqual(s.toolCalls, 2)
        XCTAssertEqual(s.toolFailures, 1)
        XCTAssertEqual(s.toolLatencyMsP50, 300)
        XCTAssertEqual(s.reconnectCount, 1)
        XCTAssertEqual(s.errorCount, 1)
        XCTAssertEqual(s.lastErrorCode?.count, 64)
    }

    func testMetricsEncodingOmitsNilsAndHasNoContent() throws {
        let m = VoiceSessionMetrics(endReason: .background, durationSeconds: 12, toolCalls: 0)
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: HDJSON.makeEncoder().encode(m)) as? [String: Any])
        XCTAssertEqual(Set(o.keys), ["endReason", "durationSeconds", "toolCalls"])
        XCTAssertEqual(o["endReason"] as? String, "background")
        XCTAssertEqual(VoiceSessionMetrics(endReason: .error, durationSeconds: -5).durationSeconds, 0)
    }
}

final class VoiceSessionAPITests: XCTestCase {
    static let sample = """
    {"sessionId":"7d1c2a4e-2b7d-4c1e-9a53-0f4b8e2d1a10","clientSecret":"ek_test_value","expiresAt":"2026-09-26T01:23:45Z","model":"gpt-realtime-2.1","voice":"marin","callUrl":"https://api.openai.com/v1/realtime/calls","maxDurationSeconds":900,"idleTimeoutSeconds":120,"tools":["get_today_overview","list_delivery_stops","search_jobs","get_job_details","list_my_assignments","get_earnings_summary","list_unread_notifications"]}
    """

    func testDecodeSampleAndRedactSecret() throws {
        let s = try HDJSON.makeDecoder().decode(VoiceSession.self, from: Data(Self.sample.utf8))
        XCTAssertEqual(s.sessionId, "7d1c2a4e-2b7d-4c1e-9a53-0f4b8e2d1a10")
        XCTAssertEqual(s.model, "gpt-realtime-2.1")
        XCTAssertEqual(s.voice, "marin")
        XCTAssertEqual(s.callUrl.absoluteString, "https://api.openai.com/v1/realtime/calls")
        XCTAssertEqual(s.expiresAt, HDJSON.parseDateTime("2026-09-26T01:23:45Z"))
        XCTAssertEqual(s.maxDurationSeconds, 900)
        XCTAssertEqual(s.idleTimeoutSeconds, 120)
        XCTAssertEqual(Set(s.tools), Set(VoiceToolName.allCases.map(\.rawValue)))
        XCTAssertFalse(String(describing: s).contains("ek_test_value"), "秘密はログに出さない")
        XCTAssertFalse(String(reflecting: s).contains("ek_test_value"))
        XCTAssertFalse("\(s)".contains("ek_test_value"))
    }

    func testCreateAndEndSessionRequests() async throws {
        let (api, transport) = makeAPI { req in
            if req.url.path.hasSuffix("/voice/realtime-session") {
                return HTTPResponse(status: 201, headers: [:], body: Data(Self.sample.utf8))
            }
            return HTTPResponse(status: 204)
        }
        _ = try await api.createVoiceSession()
        let first = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(first.method, .post)
        XCTAssertEqual(first.url.path, "/v1/voice/realtime-session")
        XCTAssertEqual(first.headers["Authorization"], "Bearer A1")
        XCTAssertEqual(String(decoding: first.body ?? Data(), as: UTF8.self), "{}")

        _ = try await api.createVoiceSession(previousSessionId: "7d1c2a4e-2b7d-4c1e-9a53-0f4b8e2d1a10")
        XCTAssertEqual(String(decoding: transport.requests[1].body ?? Data(), as: UTF8.self), #"{"previousSessionId":"7d1c2a4e-2b7d-4c1e-9a53-0f4b8e2d1a10"}"#)

        try await api.endVoiceSession(id: "7d1c2a4e-2b7d-4c1e-9a53-0f4b8e2d1a10", metrics: VoiceSessionMetrics(endReason: .user_ended, durationSeconds: 30, connectMs: 700, reconnectCount: 0))
        let end = transport.requests[2]
        XCTAssertEqual(end.url.path, "/v1/voice/sessions/7d1c2a4e-2b7d-4c1e-9a53-0f4b8e2d1a10/end")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: end.body ?? Data()) as? [String: Any])
        XCTAssertEqual(body["endReason"] as? String, "user_ended")
        XCTAssertEqual(body["durationSeconds"] as? Int, 30)
        XCTAssertEqual(body["connectMs"] as? Int, 700)
        XCTAssertEqual(Set(body.keys), ["endReason", "durationSeconds", "connectMs", "reconnectCount"])
    }

    func testVoiceUnavailableErrorMaps() async {
        let (api, _) = makeAPI { _ in errorResponse(503, code: "voice_unavailable", message: "音声アシスタントは現在ご利用いただけません。しばらくしてから再度お試しください") }
        do {
            _ = try await api.createVoiceSession()
            XCTFail("エラーになるべき")
        } catch {
            XCTAssertEqual(VoiceError.from(error), .unavailable(message: "音声アシスタントは現在ご利用いただけません。しばらくしてから再度お試しください"))
        }
    }
}
