import Foundation

/// ツールの実行結果（output はモデルへ返す JSON 文字列）
public struct VoiceToolResult: Sendable, Hashable {
    public var output: String
    public var succeeded: Bool
    public var errorCode: String?

    public init(output: String, succeeded: Bool, errorCode: String? = nil) {
        self.output = output
        self.succeeded = succeeded
        self.errorCode = errorCode
    }
}

/// 音声アシスタントのツール名（許可リスト）
public enum VoiceToolName: String, Sendable, CaseIterable {
    case get_today_overview
    case list_delivery_stops
    case search_jobs
    case get_job_details
    case list_my_assignments
    case get_earnings_summary
    case list_unread_notifications
}

/// モデルからのファンクション呼び出しを検証し、既存の HappyDriveAPI で実行して要約 JSON を返す。
/// - 許可リスト（端末側）∩ サーバーが有効にしたツールのみ実行
/// - 引数は型・形式を検証し、不正なら実行せずに構造化エラーを返す
/// - タイムアウトつき。例外は投げない
public struct VoiceToolDispatcher: Sendable {
    private let api: HappyDriveAPI
    public let enabledTools: Set<VoiceToolName>
    private let timeout: TimeInterval
    private let location: @Sendable () async -> GeoPoint?
    private let now: @Sendable () -> Date

    public init(
        api: HappyDriveAPI,
        serverTools: [String],
        timeout: TimeInterval = VoiceConfiguration.default.toolTimeout,
        location: @escaping @Sendable () async -> GeoPoint? = { nil },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.api = api
        self.enabledTools = Set(serverTools.compactMap(VoiceToolName.init(rawValue:)))
        self.timeout = timeout
        self.location = location
        self.now = now
    }

    public func execute(_ call: RealtimeFunctionCall) async -> VoiceToolResult {
        await execute(name: call.name, arguments: call.arguments)
    }

    public func execute(name: String, arguments: String) async -> VoiceToolResult {
        guard let tool = VoiceToolName(rawValue: name), enabledTools.contains(tool) else {
            return Self.failure("unknown_tool", "この機能は利用できません。")
        }
        let args: ToolArguments
        switch ToolArguments.parse(arguments, spec: Self.spec(for: tool)) {
        case .success(let parsed): args = parsed
        case .failure(let error): return Self.failure("invalid_arguments", error.message)
        }
        let deadline = timeout
        do {
            let output = try await Self.withTimeout(deadline) { [self] in
                try await run(tool, args)
            }
            return VoiceToolResult(output: output, succeeded: true)
        } catch is ToolTimeout {
            return Self.failure("timeout", "情報の取得に時間がかかっています。しばらくしてから再度お試しください。")
        } catch let error as APIError {
            return Self.failure(error.code ?? (error.isNetworkError ? "network_error" : "api_error"), error.userMessage)
        } catch is CancellationError {
            return Self.failure("cancelled", "取得を中止しました。")
        } catch {
            return Self.failure("tool_failed", "情報を取得できませんでした。")
        }
    }

    // MARK: - 引数の仕様

    enum FieldKind: Sendable {
        case date, month, uuid
        case enumeration([String])
        case text(maxLength: Int)
    }

    struct FieldSpec: Sendable {
        let name: String
        let kind: FieldKind
        let required: Bool
    }

    static let jobCategories = ["elderly_watch", "life_support", "shopping_assist", "corporate_task", "community_info", "delivery_related"]
    static let jobSorts = ["recommended", "distance", "starts_at", "amount"]
    static let assignmentScopes = ["active", "upcoming", "history"]

    static func spec(for tool: VoiceToolName) -> [FieldSpec] {
        switch tool {
        case .get_today_overview, .list_unread_notifications:
            return []
        case .list_delivery_stops:
            return [FieldSpec(name: "date", kind: .date, required: false)]
        case .search_jobs:
            return [
                FieldSpec(name: "keyword", kind: .text(maxLength: 100), required: false),
                FieldSpec(name: "category", kind: .enumeration(jobCategories), required: false),
                FieldSpec(name: "date", kind: .date, required: false),
                FieldSpec(name: "sort", kind: .enumeration(jobSorts), required: false),
            ]
        case .get_job_details:
            return [FieldSpec(name: "jobId", kind: .uuid, required: true)]
        case .list_my_assignments:
            return [FieldSpec(name: "scope", kind: .enumeration(assignmentScopes), required: false)]
        case .get_earnings_summary:
            return [FieldSpec(name: "month", kind: .month, required: false)]
        }
    }

    // MARK: - 実行（既存 API のみ）

    private func run(_ tool: VoiceToolName, _ args: ToolArguments) async throws -> String {
        switch tool {
        case .get_today_overview:
            let summary = try await api.home(location: await location())
            return try Self.encode(TodayOverviewOutput(summary, date: HDFormat.apiDate(now())))

        case .list_delivery_stops:
            let date = args["date"] ?? HDFormat.apiDate(now())
            let stops = try await api.stops(date: date)
            return try Self.encode(StopsOutput(date: date, stops: stops))

        case .search_jobs:
            var query = JobSearchQuery()
            if let point = await location() {
                query.latitude = point.latitude
                query.longitude = point.longitude
            }
            query.q = args["keyword"]
            query.category = args["category"].flatMap(JobCategory.init(rawValue:))
            query.date = args["date"]
            query.sort = args["sort"].flatMap(JobSort.init(rawValue:))
            query.limit = 5
            let page = try await api.searchJobs(query)
            return try Self.encode(JobsOutput(jobs: Array(page.items.prefix(5)), hasMore: page.nextCursor != nil || page.items.count > 5))

        case .get_job_details:
            let job = try await api.job(id: args["jobId"] ?? "")
            return try Self.encode(JobDetailOutput(job))

        case .list_my_assignments:
            let scope = args["scope"].flatMap(AssignmentScope.init(rawValue:)) ?? .active
            let list = try await api.assignments(scope: scope)
            return try Self.encode(AssignmentsOutput(scope: scope.rawValue, assignments: list))

        case .get_earnings_summary:
            let month = args["month"] ?? HDFormat.apiMonth(now())
            let summary = try await api.earningsSummary(month: month)
            return try Self.encode(EarningsOutput(summary))

        case .list_unread_notifications:
            let list = try await api.notifications(unreadOnly: true)
            return try Self.encode(NotificationsOutput(list.filter(\.isUnread)))
        }
    }

    // MARK: - 共通

    struct ToolTimeout: Error {}

    static func withTimeout<T: Sendable>(_ seconds: TimeInterval, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                throw ToolTimeout()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw ToolTimeout() }
            return first
        }
    }

    static func failure(_ code: String, _ message: String) -> VoiceToolResult {
        let body = ErrorOutput(error: .init(code: code, message: message))
        let output = (try? encode(body)) ?? #"{"error":{"code":"tool_failed","message":"情報を取得できませんでした。"}}"#
        return VoiceToolResult(output: output, succeeded: false, errorCode: code)
    }

    static func encode<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(value)
        return String(decoding: data, as: UTF8.self)
    }

    /// 日時は JST のオフセット付き ISO 8601（モデルが日本時間で読み上げやすい）
    static func jst(_ date: Date?) -> String? {
        guard let date else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = HDFormat.jst
        return f.string(from: date)
    }

    /// 住所の要約（郵便番号を除き、長すぎる場合は切り詰める）
    static func shortAddress(_ address: String, maxLength: Int = 40) -> String {
        var s = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("〒") { s.removeFirst() }
        let postal = s.prefix { $0.isNumber || $0 == "-" || $0 == "－" || $0 == "ー" }
        if postal.count >= 7 { s = String(s.dropFirst(postal.count)) }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.count > maxLength ? String(s.prefix(maxLength)) + "…" : s
    }

    static func clip(_ text: String?, _ maxLength: Int) -> String? {
        guard let text else { return nil }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        return t.count > maxLength ? String(t.prefix(maxLength)) + "…" : t
    }
}

// MARK: - 引数の解析と検証

struct ToolArgumentError: Error, Equatable {
    let message: String
}

struct ToolArguments: Sendable {
    private var values: [String: String] = [:]

    subscript(_ key: String) -> String? { values[key] }

    static func parse(_ raw: String, spec: [VoiceToolDispatcher.FieldSpec]) -> Result<ToolArguments, ToolArgumentError> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var object: [String: Any] = [:]
        if !trimmed.isEmpty {
            guard let parsed = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8), options: []),
                  let dict = parsed as? [String: Any] else {
                return .failure(ToolArgumentError(message: "引数は JSON オブジェクトで指定してください。"))
            }
            object = dict
        }
        let known = Set(spec.map(\.name))
        if let extra = object.keys.sorted().first(where: { !known.contains($0) }) {
            return .failure(ToolArgumentError(message: "使えない項目「\(extra)」が含まれています。"))
        }
        var result = ToolArguments()
        for field in spec {
            let value = object[field.name]
            if value == nil || value is NSNull {
                if field.required {
                    return .failure(ToolArgumentError(message: "「\(field.name)」を指定してください。"))
                }
                continue
            }
            guard let string = value as? String else {
                return .failure(ToolArgumentError(message: "「\(field.name)」は文字列で指定してください。"))
            }
            switch validate(string, field) {
            case .success(let normalized?): result.values[field.name] = normalized
            case .success(nil):
                if field.required {
                    return .failure(ToolArgumentError(message: "「\(field.name)」を指定してください。"))
                }
            case .failure(let error): return .failure(error)
            }
        }
        return .success(result)
    }

    private static func validate(_ value: String, _ field: VoiceToolDispatcher.FieldSpec) -> Result<String?, ToolArgumentError> {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        switch field.kind {
        case .text(let maxLength):
            if v.isEmpty { return .success(nil) }
            if v.count > maxLength {
                return .failure(ToolArgumentError(message: "「\(field.name)」は\(maxLength)文字以内で指定してください。"))
            }
            return .success(v)
        case .date:
            guard isValidDate(v) else {
                return .failure(ToolArgumentError(message: "「\(field.name)」は YYYY-MM-DD 形式の日付で指定してください。"))
            }
            return .success(v)
        case .month:
            guard isValidMonth(v) else {
                return .failure(ToolArgumentError(message: "「\(field.name)」は YYYY-MM 形式で指定してください。"))
            }
            return .success(v)
        case .uuid:
            guard v.count == 36, UUID(uuidString: v) != nil else {
                return .failure(ToolArgumentError(message: "「\(field.name)」は検索結果の ID をそのまま指定してください。"))
            }
            return .success(v.lowercased())
        case .enumeration(let allowed):
            guard allowed.contains(v) else {
                return .failure(ToolArgumentError(message: "「\(field.name)」は次のいずれかで指定してください: \(allowed.joined(separator: ", "))"))
            }
            return .success(v)
        }
    }

    static func isValidDate(_ s: String) -> Bool {
        let parts = s.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isASCIIDigit) }),
              let year = Int(parts[0]), (2000...2100).contains(year),
              let date = HDFormat.parseAPIDate(s) else { return false }
        // 2026-02-30 のような存在しない日付を弾く（往復して一致するか）
        return HDFormat.apiDate(date) == s
    }

    static func isValidMonth(_ s: String) -> Bool {
        let parts = s.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 4, parts[1].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isASCIIDigit) }),
              let year = Int(parts[0]), let month = Int(parts[1]) else { return false }
        return (2000...2100).contains(year) && (1...12).contains(month)
    }
}

private extension Character {
    var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}

// MARK: - モデルへ返す要約（必要な ID だけ含める）

private struct ErrorOutput: Encodable {
    struct Body: Encodable {
        let code: String
        let message: String
    }
    let error: Body
}

private struct TodayOverviewOutput: Encodable {
    struct StopCounts: Encodable {
        let total: Int
        let completed: Int
    }
    struct AssignmentItem: Encodable {
        let assignmentId: String
        let title: String
        let startsAt: String?
        let endsAt: String?
        let state: String
        let stateLabel: String
    }
    struct JobItem: Encodable {
        let jobId: String
        let title: String
        let area: String
        let startsAt: String?
        let amountYen: Int
    }
    let date: String
    let deliveryStops: StopCounts
    let routeCreated: Bool
    let todayAssignments: [AssignmentItem]
    let expectedEarningsYen: Int
    let unreadNotificationCount: Int
    let nearbyJobs: [JobItem]

    init(_ s: HomeSummary, date: String) {
        self.date = date
        deliveryStops = StopCounts(total: s.todayStopCount, completed: s.todayCompletedStopCount)
        routeCreated = s.todayRoute != nil
        todayAssignments = s.todayAssignments.prefix(10).map { a in
            AssignmentItem(
                assignmentId: a.id,
                title: a.job?.title ?? "案件",
                startsAt: VoiceToolDispatcher.jst(a.job?.startsAt),
                endsAt: VoiceToolDispatcher.jst(a.job?.endsAt),
                state: a.state.rawValue,
                stateLabel: a.state.presentation.label
            )
        }
        expectedEarningsYen = s.expectedEarningsYen
        unreadNotificationCount = s.unreadNotificationCount
        nearbyJobs = s.nearbyJobs.prefix(3).map { j in
            JobItem(jobId: j.id, title: j.title, area: j.areaLabel, startsAt: VoiceToolDispatcher.jst(j.startsAt), amountYen: j.amountYen)
        }
    }
}

private struct StopsOutput: Encodable {
    struct Item: Encodable {
        let sequence: Int?
        let address: String
        let timeWindow: String?
        let status: String
        let statusLabel: String
    }
    static let limit = 30
    let date: String
    let count: Int
    let completedCount: Int
    let stops: [Item]
    let omittedCount: Int?

    init(date: String, stops raw: [Stop]) {
        self.date = date
        let sorted = raw.sorted { ($0.sequence ?? Int.max, $0.address) < ($1.sequence ?? Int.max, $1.address) }
        count = raw.count
        completedCount = raw.filter { $0.status == .delivered }.count
        stops = sorted.prefix(Self.limit).map { s in
            var window: String?
            if let start = s.timeWindowStart, let end = s.timeWindowEnd {
                window = HDFormat.timeRange(start, end)
            } else if let start = s.timeWindowStart {
                window = "\(HDFormat.time(start))以降"
            } else if let end = s.timeWindowEnd {
                window = "\(HDFormat.time(end))まで"
            }
            return Item(sequence: s.sequence, address: VoiceToolDispatcher.shortAddress(s.address), timeWindow: window, status: s.status.rawValue, statusLabel: s.status.presentation.label)
        }
        omittedCount = raw.count > Self.limit ? raw.count - Self.limit : nil
    }
}

private struct JobItemOutput: Encodable {
    let jobId: String
    let title: String
    let category: String
    let categoryLabel: String
    let area: String
    let startsAt: String?
    let endsAt: String?
    let amountYen: Int
    let remainingCapacity: Int
    let matchReasons: [String]?
    let eligible: Bool?

    init(_ j: Job) {
        jobId = j.id
        title = j.title
        category = j.category.rawValue
        categoryLabel = j.category.label
        area = j.areaLabel
        startsAt = VoiceToolDispatcher.jst(j.startsAt)
        endsAt = VoiceToolDispatcher.jst(j.endsAt)
        amountYen = j.amountYen
        remainingCapacity = j.remainingCapacity
        matchReasons = j.matchReasons.map { Array($0.prefix(3)) }
        eligible = j.eligible
    }
}

private struct JobsOutput: Encodable {
    let count: Int
    let jobs: [JobItemOutput]
    let hasMore: Bool

    init(jobs: [Job], hasMore: Bool) {
        count = jobs.count
        self.jobs = jobs.map(JobItemOutput.init)
        self.hasMore = hasMore
    }
}

private struct JobDetailOutput: Encodable {
    let jobId: String
    let title: String
    let organizationName: String
    let category: String
    let categoryLabel: String
    let contractType: String
    let area: String
    let startsAt: String?
    let endsAt: String?
    let durationMinutes: Int
    let amountYen: Int
    let expensesReimbursedYen: Int?
    let capacity: Int
    let remainingCapacity: Int
    let requiredSkills: [String]
    let cancellationPolicy: String
    let meetingPointNote: String?
    let safetyNotes: String?
    let description: String?
    let eligible: Bool?
    let ineligibleReasons: [String]?
    let alreadyAccepted: Bool

    init(_ j: Job) {
        jobId = j.id
        title = j.title
        organizationName = j.organizationName
        category = j.category.rawValue
        categoryLabel = j.category.label
        contractType = j.contractType.label
        area = j.areaLabel
        startsAt = VoiceToolDispatcher.jst(j.startsAt)
        endsAt = VoiceToolDispatcher.jst(j.endsAt)
        durationMinutes = j.effectiveDurationMinutes
        amountYen = j.amountYen
        expensesReimbursedYen = j.expensesReimbursedYen
        capacity = j.capacity
        remainingCapacity = j.remainingCapacity
        requiredSkills = j.requiredSkillNames ?? j.requiredSkills
        cancellationPolicy = VoiceToolDispatcher.clip(j.cancellationPolicy.text, 200) ?? "無料キャンセルは開始\(j.cancellationPolicy.freeCancelHoursBefore)時間前まで"
        meetingPointNote = VoiceToolDispatcher.clip(j.meetingPointNote, 120)
        safetyNotes = VoiceToolDispatcher.clip(j.safetyNotes, 120)
        description = VoiceToolDispatcher.clip(j.description, 300)
        eligible = j.eligible
        ineligibleReasons = j.ineligibleReasons
        alreadyAccepted = j.myAssignmentId != nil
    }
}

private struct AssignmentsOutput: Encodable {
    struct Item: Encodable {
        let assignmentId: String
        let jobId: String
        let title: String
        let startsAt: String?
        let endsAt: String?
        let area: String?
        let state: String
        let stateLabel: String
        let amountYen: Int?
    }
    let scope: String
    let count: Int
    let assignments: [Item]

    init(scope: String, assignments list: [Assignment]) {
        self.scope = scope
        count = list.count
        assignments = list.prefix(10).map { a in
            Item(
                assignmentId: a.id,
                jobId: a.jobId,
                title: a.job?.title ?? "案件",
                startsAt: VoiceToolDispatcher.jst(a.job?.startsAt),
                endsAt: VoiceToolDispatcher.jst(a.job?.endsAt),
                area: a.job?.areaLabel,
                state: a.state.rawValue,
                stateLabel: a.state.presentation.label,
                amountYen: a.acceptedAmountYen
            )
        }
    }
}

private struct EarningsOutput: Encodable {
    let month: String
    let totalYen: Int
    let paidYen: Int
    let payableYen: Int
    let pendingYen: Int
    let estimatedYen: Int
    let completedCount: Int
    let employmentYen: Int?
    let contractorYen: Int?

    init(_ s: EarningsSummary) {
        month = s.month
        totalYen = s.totalYen
        paidYen = s.paidYen
        payableYen = s.payableYen
        pendingYen = s.pendingYen
        estimatedYen = s.estimatedYen
        completedCount = s.completedCount
        employmentYen = s.employmentYen
        contractorYen = s.contractorYen
    }
}

private struct NotificationsOutput: Encodable {
    struct Item: Encodable {
        let title: String
        let body: String?
        let createdAt: String?
    }
    let count: Int
    let notifications: [Item]

    init(_ list: [AppNotification]) {
        count = list.count
        notifications = list.sorted { $0.createdAt > $1.createdAt }.prefix(10).map { n in
            Item(title: n.title, body: VoiceToolDispatcher.clip(n.body, 120), createdAt: VoiceToolDispatcher.jst(n.createdAt))
        }
    }
}
