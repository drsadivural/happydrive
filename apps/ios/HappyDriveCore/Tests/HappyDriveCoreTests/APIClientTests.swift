import XCTest
@testable import HappyDriveCore

final class APIClientTests: XCTestCase {
    private func userJSON() -> [String: Any] {
        ["id": "6f1c2a4e-2b7d-4c1e-9a53-0f4b8e2d1a10", "displayName": "山田 太郎", "verificationStatus": "verified"]
    }

    func testBearerHeaderAndCommonHeaders() async throws {
        let store = InMemoryTokenStore(tokens: tokens(access: "A1", refresh: "R1"))
        let transport = MockTransport { _ in json(200, self.userJSON()) }
        let api = HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store))
        let me = try await api.me()
        XCTAssertEqual(me.displayName, "山田 太郎")
        let req = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(req.url.absoluteString, "http://localhost:8080/v1/me")
        XCTAssertEqual(req.headers["Authorization"], "Bearer A1")
        XCTAssertEqual(req.headers["Accept-Language"], "ja-JP")
        XCTAssertNil(req.headers["Idempotency-Key"])
    }

    func testRefreshOn401AndRetryWithSameIdempotencyKey() async throws {
        let store = InMemoryTokenStore(tokens: tokens(access: "OLD", refresh: "R-OLD"))
        let transport = MockTransport { req in
            if req.url.path.hasSuffix("/auth/refresh") {
                return json(200, tokensJSON(access: "NEW", refresh: "R-NEW"))
            }
            if req.headers["Authorization"] == "Bearer OLD" {
                return errorResponse(401, code: "token_expired", message: "認証の有効期限が切れました")
            }
            return json(201, ["id": "5a6b7c8d-0000-4c1e-9a53-0f4b8e2d1a61", "jobId": "j", "workerId": "w", "state": "accepted"])
        }
        let events = Locked<[SessionEvent]>([])
        let client = APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store, onSessionEvent: { e in events.mutate { $0.append(e) } })
        let api = HappyDriveAPI(client: client)

        let key = IdempotencyKey.generate()
        let assignment = try await api.acceptJob(id: "job-1", termsHash: "h1", idempotencyKey: key)
        XCTAssertEqual(assignment.state, .accepted)

        let acceptRequests = transport.requests(path: "/jobs/job-1/accept")
        XCTAssertEqual(acceptRequests.count, 2)
        XCTAssertEqual(acceptRequests.map { $0.headers["Idempotency-Key"] }, [key, key], "再送でも同じ冪等キー")
        XCTAssertEqual(acceptRequests[1].headers["Authorization"], "Bearer NEW")
        XCTAssertEqual(store.loadTokens()?.refreshToken, "R-NEW")

        let refreshReq = try XCTUnwrap(transport.requests(path: "/auth/refresh").first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: refreshReq.body ?? Data()) as? [String: String])
        XCTAssertEqual(body["refreshToken"], "R-OLD")
        XCTAssertNil(refreshReq.headers["Authorization"])
        XCTAssertEqual(events.get(), [.tokensRefreshed])
    }

    func testConcurrent401sTriggerSingleRefresh() async throws {
        let store = InMemoryTokenStore(tokens: tokens(access: "OLD", refresh: "R-OLD"))
        let refreshCalls = Locked(0)
        let transport = MockTransport { req in
            if req.url.path.hasSuffix("/auth/refresh") {
                refreshCalls.mutate { $0 += 1 }
                // 遅いリフレッシュ（他の要求が 401 を受けて待つ状況を作る）
                try await Task.sleep(nanoseconds: 100_000_000)
                return json(200, tokensJSON(access: "NEW", refresh: "R-NEW"))
            }
            if req.headers["Authorization"] != "Bearer NEW" {
                return errorResponse(401, code: "unauthorized", message: "ログインが必要です")
            }
            return json(200, ["id": "u", "displayName": "x", "verificationStatus": "pending"])
        }
        let client = APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store)
        let api = HappyDriveAPI(client: client)

        try await withThrowingTaskGroup(of: User.self) { group in
            for _ in 0..<8 {
                group.addTask { try await api.me() }
            }
            var count = 0
            for try await user in group {
                XCTAssertEqual(user.verificationStatus, .pending)
                count += 1
            }
            XCTAssertEqual(count, 8)
        }
        XCTAssertEqual(refreshCalls.get(), 1, "同時の 401 でもリフレッシュは 1 回だけ")
        let refreshCount = await client.refreshCount()
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(store.loadTokens()?.accessToken, "NEW")
    }

    func testProactiveRefreshWhenAccessTokenNearExpiry() async throws {
        let store = InMemoryTokenStore(tokens: tokens(access: "OLD", refresh: "R-OLD", expiresIn: 5))
        let transport = MockTransport { req in
            if req.url.path.hasSuffix("/auth/refresh") { return json(200, tokensJSON(access: "NEW", refresh: "R-NEW")) }
            XCTAssertEqual(req.headers["Authorization"], "Bearer NEW")
            return json(200, ["id": "u", "displayName": "x", "verificationStatus": "verified"])
        }
        let api = HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store))
        _ = try await api.me()
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertTrue(transport.requests[0].url.path.hasSuffix("/auth/refresh"))
    }

    func testRefreshFailureExpiresSession() async throws {
        let store = InMemoryTokenStore(tokens: tokens(access: "OLD", refresh: "R-OLD"))
        let transport = MockTransport { req in
            if req.url.path.hasSuffix("/auth/refresh") {
                return errorResponse(401, code: "refresh_reused", message: "再ログインが必要です")
            }
            return errorResponse(401, code: "unauthorized", message: "ログインが必要です")
        }
        let events = Locked<[SessionEvent]>([])
        let api = HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store, onSessionEvent: { e in events.mutate { $0.append(e) } }))
        do {
            _ = try await api.me()
            XCTFail("失敗するはず")
        } catch let error as APIError {
            XCTAssertEqual(error, .sessionExpired)
            XCTAssertEqual(error.userMessage, "ログインの有効期限が切れました。もう一度ログインしてください。")
        }
        XCTAssertNil(store.loadTokens(), "失効時は端末のトークンを消去")
        XCTAssertEqual(events.get(), [.expired])
    }

    func testNoTokensThrowsSessionExpiredWithoutNetwork() async {
        let transport = MockTransport { _ in json(200, [:]) }
        let api = HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: transport, tokenStore: InMemoryTokenStore()))
        do {
            _ = try await api.me()
            XCTFail()
        } catch {
            XCTAssertEqual(error as? APIError, .sessionExpired)
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testJapaneseErrorMapping() async throws {
        let store = InMemoryTokenStore(tokens: tokens(access: "A", refresh: "R"))
        let transport = MockTransport { req in
            if req.url.path.hasSuffix("/accept") {
                return errorResponse(409, code: "capacity_full", message: "この案件は満員になりました", details: ["remainingCapacity": 0])
            }
            if req.url.path.hasSuffix("/me") {
                return HTTPResponse(status: 503, body: Data("<html>busy</html>".utf8))
            }
            return errorResponse(429, code: "rate_limited", message: "")
        }
        let api = HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store))
        do {
            _ = try await api.acceptJob(id: "j", termsHash: nil, idempotencyKey: IdempotencyKey.generate())
            XCTFail()
        } catch let e as APIError {
            XCTAssertEqual(e.status, 409)
            XCTAssertEqual(e.code, "capacity_full")
            XCTAssertEqual(e.userMessage, "この案件は満員になりました")
            XCTAssertEqual(e.requestId, "req-test")
            XCTAssertFalse(e.isRetryable)
            XCTAssertEqual(AcceptFailureResolution(error: e), .offerWaitlist(message: "この案件は満員になりました"))
        }
        do {
            _ = try await api.me()
            XCTFail()
        } catch let e as APIError {
            XCTAssertEqual(e.status, 503)
            XCTAssertEqual(e.userMessage, "サーバーで問題が発生しました。時間をおいて再度お試しください。")
            XCTAssertTrue(e.isRetryable)
        }
        do {
            _ = try await api.courses()
            XCTFail()
        } catch let e as APIError {
            XCTAssertEqual(e.userMessage, "操作回数の上限に達しました。しばらく待ってから再度お試しください。", "空の message は既定の日本語")
        }
        XCTAssertEqual(APIError.network(description: "offline").userMessage, "通信できませんでした。電波の良い場所で再度お試しください。")
    }

    func testQueryEncodingAndEmptyResponse() async throws {
        let store = InMemoryTokenStore(tokens: tokens(access: "A", refresh: "R"))
        let transport = MockTransport { req in
            if req.method == .put { return HTTPResponse(status: 204) }
            return json(200, ["items": [], "nextCursor": NSNull()])
        }
        let api = HappyDriveAPI(client: APIClient(baseURL: URL(string: "http://localhost:8080/v1/")!, transport: transport, tokenStore: store))
        var q = JobSearchQuery()
        q.areaQuery = "横浜市 中区"
        q.q = "a+b"
        let page = try await api.searchJobs(q)
        XCTAssertTrue(page.items.isEmpty)
        let url = try XCTUnwrap(transport.requests.first?.url)
        XCTAssertTrue(url.absoluteString.hasPrefix("http://localhost:8080/v1/jobs?"), url.absoluteString)
        let comps = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertTrue(comps.percentEncodedQuery?.contains("q=a%2Bb") ?? false, comps.percentEncodedQuery ?? "")
        XCTAssertEqual(comps.queryItems?.first(where: { $0.name == "areaQuery" })?.value, "横浜市 中区")

        try await api.setFavorite(jobId: "job-1", favorite: true)
        XCTAssertEqual(transport.requests.last?.method, .put)
        XCTAssertEqual(transport.requests.last?.url.path, "/v1/jobs/job-1/favorite")
    }

    func testVerifyOTPStoresTokensAndSkipsAuth() async throws {
        let store = InMemoryTokenStore()
        let fixture = try Fixture.data("auth_result")
        let transport = MockTransport { _ in HTTPResponse(status: 200, body: fixture) }
        let api = HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store))
        let result = try await api.verifyOTP(phone: "09012345678", code: "123456", deviceName: "iPhone")
        XCTAssertTrue(result.isNewUser)
        XCTAssertEqual(store.loadTokens()?.refreshToken, "refresh-token-abcdefghijklmnopqrstuvwxyz")
        XCTAssertNil(transport.requests.first?.headers["Authorization"])
    }

    func testEvidenceUploadFlow() async throws {
        let store = InMemoryTokenStore(tokens: tokens(access: "A", refresh: "R"))
        let photo = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
        let transport = MockTransport { req in
            switch req.url.path {
            case "/v1/evidence/uploads":
                return json(201, ["evidenceId": "ev-1", "uploadUrl": "http://localhost:8080/v1/evidence-blobs/tok", "uploadMethod": "PUT", "uploadHeaders": ["x-amz-meta": "1"], "expiresAt": "2026-09-26T07:00:00Z"])
            case "/v1/evidence-blobs/tok":
                return HTTPResponse(status: 204)
            case "/v1/evidence/ev-1/complete":
                return json(200, ["id": "ev-1", "purpose": "delivery_photo", "status": "verified", "createdAt": "2026-09-26T06:00:00Z"])
            default:
                return HTTPResponse(status: 404)
            }
        }
        let api = HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store))
        let ev = try await api.uploadEvidence(data: photo, contentType: .jpeg, purpose: .delivery_photo, deliveryStopId: "stop-1", idempotencyKey: String(repeating: "k", count: 20))
        XCTAssertEqual(ev.status, .verified)
        let create = transport.requests[0]
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: create.body ?? Data()) as? [String: Any])
        XCTAssertEqual(body["sha256"] as? String, EvidenceHashing.sha256Hex(photo))
        XCTAssertEqual(body["byteSize"] as? Int, 6)
        XCTAssertEqual(create.headers["Idempotency-Key"], String(repeating: "k", count: 20))
        let put = transport.requests[1]
        XCTAssertEqual(put.method, .put)
        XCTAssertNil(put.headers["Authorization"], "署名 URL には Bearer を付けない")
        XCTAssertEqual(put.headers["Content-Type"], "image/jpeg")
        XCTAssertEqual(put.body, photo)
    }

    func testRouteNotFoundReturnsNil() async throws {
        let store = InMemoryTokenStore(tokens: tokens(access: "A", refresh: "R"))
        let transport = MockTransport { _ in errorResponse(404, code: "not_found", message: "ルートがありません") }
        let api = HappyDriveAPI(client: APIClient(baseURL: testBaseURL, transport: transport, tokenStore: store))
        let route = try await api.route(date: "2026-09-26")
        XCTAssertNil(route)
    }

    func testIdempotencyKeyFormat() {
        let a = IdempotencyKey.generate(), b = IdempotencyKey.generate()
        XCTAssertNotEqual(a, b)
        XCTAssertTrue(IdempotencyKey.isValid(a))
        XCTAssertFalse(IdempotencyKey.isValid("short"))
    }
}
