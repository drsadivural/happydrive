import Foundation

/// 契約 packages/contracts/openapi.yaml (v1.1) のうちドライバーアプリが使う操作。
public struct HappyDriveAPI: Sendable {
    public let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    private func p(_ id: String) -> String { APIClient.pathComponent(id) }

    // MARK: - Auth

    /// 端末アカウントでログイン（初回は自動でアカウント作成）し、トークンを保存する。
    public func deviceLogin(secret: String, deviceName: String?) async throws -> AuthResult {
        let result: AuthResult = try await client.send(try .json(.post, "/auth/device", body: DeviceLoginBody(deviceSecret: secret, deviceName: deviceName), requiresAuth: false))
        try client.tokenStore.saveTokens(result.tokens)
        return result
    }

    public func requestOTP(phone: String) async throws -> OTPRequestResult {
        try await client.send(try .json(.post, "/auth/otp/request", body: OTPRequestBody(phone: phone), requiresAuth: false))
    }

    /// OTP を検証し、成功したらトークンを保存する。
    public func verifyOTP(phone: String, code: String, deviceName: String?) async throws -> AuthResult {
        let result: AuthResult = try await client.send(try .json(.post, "/auth/otp/verify", body: OTPVerifyBody(phone: phone, code: code, deviceName: deviceName), requiresAuth: false))
        try client.tokenStore.saveTokens(result.tokens)
        return result
    }

    public func googleChallenge(link: Bool = false) async throws -> GoogleAuthChallenge {
        try await client.send(try .json(.post, link ? "/auth/google/link/challenge" : "/auth/google/challenge", body: ["platform":"ios"], requiresAuth: link))
    }
    public func googleSignIn(challengeId: String, idToken: String, deviceName: String?, link: Bool = false) async throws -> GoogleSignInResult {
        struct Input: Encodable { let challengeId: String; let idToken: String; let deviceName: String? }
        let endpoint: Endpoint<AuthResult> = try .json(.post, link ? "/auth/google/link" : "/auth/google/verify", body: Input(challengeId: challengeId, idToken: idToken, deviceName: deviceName), requiresAuth: link)
        let response = try await client.perform(method: endpoint.method, path: endpoint.path, body: endpoint.body, idempotencyKey: nil, requiresAuth: link)
        if response.status == 202 { return .mfa(try client.decode(GoogleMFAChallenge.self, from: response)) }
        let result = try client.decode(AuthResult.self, from: response)
        try client.tokenStore.saveTokens(result.tokens)
        return .authenticated(result)
    }
    public func verifyGoogleMFA(challenge: GoogleMFAChallenge, code: String) async throws -> AuthResult {
        let result: AuthResult = try await client.send(try .json(.post, "/auth/web/mfa/verify", body: ["mfaToken":challenge.mfaToken,"code":code], requiresAuth: false))
        try client.tokenStore.saveTokens(result.tokens)
        return result
    }
    public func linkPhone(phone: String, code: String, deviceName: String?) async throws -> AuthResult {
        let result: AuthResult = try await client.send(try .json(.post, "/auth/phone/link", body: OTPVerifyBody(phone: phone, code: code, deviceName: deviceName)))
        try client.tokenStore.saveTokens(result.tokens)
        return result
    }

    /// サーバー側のリフレッシュトークンを失効させ、端末のトークンを消去する（通信失敗でも端末側は消去）。
    public func logout() async {
        if let refresh = client.tokenStore.loadTokens()?.refreshToken {
            _ = try? await client.send(try Endpoint<EmptyResponse>.json(.post, "/auth/logout", body: RefreshBody(refreshToken: refresh)))
        }
        client.tokenStore.clearTokens()
    }

    // MARK: - Identity

    public func me() async throws -> User {
        try await client.send(.get("/me"))
    }

    public func updateDisplayName(_ name: String) async throws -> User {
        try await client.send(try .json(.patch, "/me", body: DisplayNameUpdate(displayName: name)))
    }

    /// 退会。confirm=false（または nil）で説明と阻害要因を取得、confirm=true で確定。
    public func requestAccountDeletion(confirm: Bool, reason: String?, idempotencyKey: String) async throws -> DeletionRequest {
        try await client.send(try .json(.delete, "/me", body: DeletionRequestBody(confirm: confirm, reason: reason), idempotencyKey: idempotencyKey))
    }

    public func acceptTerms(termsVersion: String, privacyVersion: String) async throws -> User {
        try await client.send(try .json(.post, "/me/terms", body: TermsAcceptance(termsVersion: termsVersion, privacyVersion: privacyVersion)))
    }

    public func updateProfile(_ input: ProfileInput) async throws -> User {
        try await client.send(try .json(.put, "/me/profile", body: input))
    }

    public func updateVehicle(_ vehicle: Vehicle) async throws -> User {
        try await client.send(try .json(.put, "/me/vehicle", body: vehicle))
    }

    public func updateBankAccount(_ input: BankAccountInput) async throws -> User {
        try await client.send(try .json(.put, "/me/bank-account", body: input))
    }

    public func submitVerification(documentEvidenceIds: [String], idempotencyKey: String) async throws -> User {
        try await client.send(try .json(.post, "/me/verification", body: VerificationSubmission(documentEvidenceIds: documentEvidenceIds), idempotencyKey: idempotencyKey))
    }

    public func submitSkill(_ submission: SkillSubmission, idempotencyKey: String) async throws -> Skill {
        try await client.send(try .json(.post, "/me/skills", body: submission, idempotencyKey: idempotencyKey))
    }

    public func skillCatalog() async throws -> [SkillDefinition] {
        try await client.send(.get("/skills/catalog"))
    }

    public func updatePreferences(_ preferences: Preferences) async throws -> User {
        try await client.send(try .json(.put, "/me/preferences", body: preferences))
    }

    public func registerDevice(apnsToken: String, environment: APNsEnvironment) async throws {
        let _: EmptyResponse = try await client.send(try .json(.post, "/me/devices", body: DeviceRegistration(apnsToken: apnsToken, environment: environment)))
    }

    public func unregisterDevice(apnsToken: String) async throws {
        let _: EmptyResponse = try await client.send(.bodyless(.delete, "/me/devices/\(p(apnsToken))"))
    }

    public func createSupportTicket(_ input: SupportTicketInput, idempotencyKey: String) async throws -> SupportTicket {
        try await client.send(try .json(.post, "/support/tickets", body: input, idempotencyKey: idempotencyKey))
    }

    public func supportTickets() async throws -> [SupportTicket] {
        try await client.send(.get("/support/tickets"))
    }

    public func createMatchingAppeal(_ input: MatchingAppealInput, idempotencyKey: String) async throws -> SupportTicket {
        try await client.send(try .json(.post, "/matching/appeals", body: input, idempotencyKey: idempotencyKey))
    }

    // MARK: - Delivery

    public func stops(date: CalendarDateString) async throws -> [Stop] {
        try await client.send(.get("/delivery/stops", query: [QueryItem("date", date)]))
    }

    public func addStop(_ stop: NewStop, idempotencyKey: String) async throws -> Stop {
        try await client.send(try .json(.post, "/delivery/stops", body: stop, idempotencyKey: idempotencyKey))
    }

    public func importStops(_ request: StopImportRequest, idempotencyKey: String) async throws -> StopImportResult {
        try await client.send(try .json(.post, "/delivery/stops/import", body: request, idempotencyKey: idempotencyKey))
    }

    public func stop(id: String) async throws -> Stop {
        try await client.send(.get("/delivery/stops/\(p(id))"))
    }

    public func updateStop(id: String, update: StopUpdate) async throws -> Stop {
        try await client.send(try .json(.patch, "/delivery/stops/\(p(id))", body: update))
    }

    public func deleteStop(id: String) async throws {
        let _: EmptyResponse = try await client.send(.bodyless(.delete, "/delivery/stops/\(p(id))"))
    }

    /// 受取人の電話番号（取得は監査記録される。タップ時のみ呼ぶ）
    public func stopContact(id: String) async throws -> StopContact {
        try await client.send(.get("/delivery/stops/\(p(id))/contact"))
    }

    public func optimizeRoute(_ request: RouteRequest, idempotencyKey: String) async throws -> Route {
        try await client.send(try .json(.post, "/delivery/routes/optimize", body: request, idempotencyKey: idempotencyKey))
    }

    /// その日の最新ルート。未作成なら nil（404）。
    public func route(date: CalendarDateString) async throws -> Route? {
        do {
            return try await client.send(.get("/delivery/routes", query: [QueryItem("date", date)]))
        } catch let error as APIError where error.status == 404 {
            return nil
        }
    }

    public func reorderRoute(routeId: String, orderedStopIds: [String], idempotencyKey: String) async throws -> Route {
        try await client.send(try .json(.post, "/delivery/routes/\(p(routeId))/reorder", body: ReorderRequest(orderedStopIds: orderedStopIds), idempotencyKey: idempotencyKey))
    }

    public func startRoute(routeId: String, idempotencyKey: String) async throws -> Route {
        try await client.send(.bodyless(.post, "/delivery/routes/\(p(routeId))/start", idempotencyKey: idempotencyKey))
    }

    /// 配送状態の記録（通常は OfflineQueue 経由で送る）
    public func stopEventMutation(stopId: String, event: StopEventRequest, idempotencyKey: String = IdempotencyKey.generate()) throws -> PendingMutation {
        if let message = event.validationError() { throw APIError.invalidInput(message: message) }
        return PendingMutation(
            entityKey: "stop:\(stopId)",
            kind: .stopEvent,
            method: .post,
            path: "/delivery/stops/\(p(stopId))/events",
            body: try HDJSON.makeEncoder().encode(event),
            idempotencyKey: idempotencyKey
        )
    }

    public func deliveryReports(from: CalendarDateString, to: CalendarDateString) async throws -> [DeliveryDayReport] {
        try await client.send(.get("/delivery/reports/daily", query: [QueryItem("from", from), QueryItem("to", to)]))
    }

    // MARK: - Jobs

    public func home(location: GeoPoint?) async throws -> HomeSummary {
        var q: [QueryItem] = []
        if let location {
            q.append(QueryItem("latitude", JobSearchQuery.coordinateString(location.latitude)))
            q.append(QueryItem("longitude", JobSearchQuery.coordinateString(location.longitude)))
        }
        return try await client.send(.get("/home", query: q))
    }

    public func searchJobs(_ query: JobSearchQuery) async throws -> JobSearchPage {
        try await client.send(.get("/jobs", query: query.queryItems))
    }

    public func job(id: String) async throws -> Job {
        try await client.send(.get("/jobs/\(p(id))"))
    }

    /// 受諾。確認シートを開いた時点で生成したキーを再試行でも使い回すこと。
    public func acceptJob(id: String, termsHash: String?, idempotencyKey: String) async throws -> Assignment {
        try await client.send(try .json(.post, "/jobs/\(p(id))/accept", body: AcceptJobBody(termsHash: termsHash), idempotencyKey: idempotencyKey))
    }

    public func setFavorite(jobId: String, favorite: Bool) async throws {
        let _: EmptyResponse = try await client.send(.bodyless(favorite ? .put : .delete, "/jobs/\(p(jobId))/favorite"))
    }

    public func setWaitlist(jobId: String, joined: Bool) async throws {
        let _: EmptyResponse = try await client.send(.bodyless(joined ? .put : .delete, "/jobs/\(p(jobId))/waitlist"))
    }

    public func assignments(scope: AssignmentScope) async throws -> [Assignment] {
        try await client.send(.get("/assignments", query: [QueryItem("scope", scope.rawValue)]))
    }

    public func assignment(id: String) async throws -> Assignment {
        try await client.send(.get("/assignments/\(p(id))"))
    }

    /// 業務状態の進行（通常は OfflineQueue 経由）
    public func assignmentEventMutation(assignmentId: String, event: AssignmentEventRequest, idempotencyKey: String = IdempotencyKey.generate()) throws -> PendingMutation {
        PendingMutation(
            entityKey: "assignment:\(assignmentId)",
            kind: .assignmentEvent,
            method: .post,
            path: "/assignments/\(p(assignmentId))/events",
            body: try HDJSON.makeEncoder().encode(event),
            idempotencyKey: idempotencyKey
        )
    }

    /// 即時送信が必要な業務イベント（安全通報・ヘルプなど）
    public func advanceAssignment(id: String, event: AssignmentEventRequest, idempotencyKey: String) async throws -> Assignment {
        try await client.send(try .json(.post, "/assignments/\(p(id))/events", body: event, idempotencyKey: idempotencyKey))
    }

    public func shareLocation(assignmentId: String, location: GeoPoint, accuracyMeters: Double?) async throws {
        let _: EmptyResponse = try await client.send(try .json(.post, "/assignments/\(p(assignmentId))/location", body: LocationShareBody(location: location, accuracyMeters: accuracyMeters)))
    }

    public func rateAssignment(id: String, score: Int, comment: String?) async throws {
        let _: EmptyResponse = try await client.send(try .json(.post, "/assignments/\(p(id))/rating", body: RatingBody(score: score, comment: comment)))
    }

    public func messages(assignmentId: String, after: Date? = nil) async throws -> [Message] {
        var q: [QueryItem] = []
        if let after { q.append(QueryItem("after", HDJSON.formatDateTime(after))) }
        return try await client.send(.get("/assignments/\(p(assignmentId))/messages", query: q))
    }

    public func sendMessage(assignmentId: String, body: String, evidenceId: String?, idempotencyKey: String) async throws -> Message {
        try await client.send(try .json(.post, "/assignments/\(p(assignmentId))/messages", body: SendMessageBody(body: body, evidenceId: evidenceId), idempotencyKey: idempotencyKey))
    }

    public func report(_ input: ReportInput, idempotencyKey: String) async throws -> Report {
        try await client.send(try .json(.post, "/reports", body: input, idempotencyKey: idempotencyKey))
    }

    public func blockOrganization(id: String) async throws {
        let _: EmptyResponse = try await client.send(try .json(.post, "/blocks", body: BlockOrganizationBody(organizationId: id)))
    }

    // MARK: - Evidence

    public func createEvidenceUpload(_ request: EvidenceUploadRequest, idempotencyKey: String) async throws -> EvidenceUploadTicket {
        try await client.send(try .json(.post, "/evidence/uploads", body: request, idempotencyKey: idempotencyKey))
    }

    public func completeEvidenceUpload(evidenceId: String) async throws -> Evidence {
        try await client.send(.bodyless(.post, "/evidence/\(p(evidenceId))/complete"))
    }

    public func evidenceURL(evidenceId: String) async throws -> SignedURL {
        try await client.send(.get("/evidence/\(p(evidenceId))/url"))
    }

    /// 作成 → 署名 URL へ PUT → 検証完了 までを行い、検証済み証跡を返す。
    public func uploadEvidence(data: Data, contentType: EvidenceContentType, purpose: EvidencePurpose?, assignmentId: String? = nil, deliveryStopId: String? = nil, idempotencyKey: String = IdempotencyKey.generate()) async throws -> Evidence {
        let request = EvidenceUploadRequest(assignmentId: assignmentId, deliveryStopId: deliveryStopId, purpose: purpose, contentType: contentType, byteSize: data.count, sha256: EvidenceHashing.sha256Hex(data))
        let ticket = try await createEvidenceUpload(request, idempotencyKey: idempotencyKey)
        var headers = ticket.uploadHeaders ?? [:]
        if headers.keys.first(where: { $0.lowercased() == "content-type" }) == nil {
            headers["Content-Type"] = contentType.rawValue
        }
        try await client.uploadBlob(to: ticket.uploadUrl, method: ticket.uploadMethod ?? "PUT", headers: headers, data: data)
        return try await completeEvidenceUpload(evidenceId: ticket.evidenceId)
    }

    // MARK: - Notifications

    public func notifications(unreadOnly: Bool = false) async throws -> [AppNotification] {
        try await client.send(.get("/notifications", query: unreadOnly ? [QueryItem("unreadOnly", "true")] : []))
    }

    public func markNotificationsRead(ids: [String]? = nil, all: Bool = false) async throws {
        let _: EmptyResponse = try await client.send(try .json(.post, "/notifications/read", body: MarkNotificationsReadBody(ids: ids, all: all ? true : nil)))
    }

    // MARK: - Earnings

    public func earnings(month: String?) async throws -> [EarningEntry] {
        try await client.send(.get("/earnings", query: month.map { [QueryItem("month", $0)] } ?? []))
    }

    public func earningsSummary(month: String?) async throws -> EarningsSummary {
        try await client.send(.get("/earnings/summary", query: month.map { [QueryItem("month", $0)] } ?? []))
    }

    public func payouts() async throws -> [Payout] {
        try await client.send(.get("/payouts"))
    }

    // MARK: - Learning

    public func courses() async throws -> [CourseSummary] {
        try await client.send(.get("/learning/courses"))
    }

    public func course(id: String) async throws -> Course {
        try await client.send(.get("/learning/courses/\(p(id))"))
    }

    public func submitQuiz(courseId: String, answers: [QuizAnswer], idempotencyKey: String) async throws -> QuizResult {
        try await client.send(try .json(.post, "/learning/courses/\(p(courseId))/attempts", body: QuizAttempt(answers: answers), idempotencyKey: idempotencyKey))
    }
}
