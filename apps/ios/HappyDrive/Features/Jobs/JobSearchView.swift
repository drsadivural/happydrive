import MapKit
import SwiftUI
import HappyDriveCore

@Observable
@MainActor
final class JobSearchViewModel {
    var query = JobSearchQuery()
    var text = ""
    var category: JobCategory?
    var jobs: [Job] = []
    var nextCursor: String?
    var isLoading = false
    var isLoadingMore = false
    var errorMessage: String?
    var loadedOnce = false
    /// 位置を使わずエリア名で検索している
    var usingAreaSearch = false

    func search(env: AppEnvironment) async {
        isLoading = true
        errorMessage = nil
        defer {
            isLoading = false
            loadedOnce = true
        }
        var q = query
        q.cursor = nil
        q.limit = 20
        q.category = category
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        q.latitude = nil
        q.longitude = nil
        q.areaQuery = nil
        q.q = nil
        if env.location.isAuthorized, let loc = await env.location.currentLocation(maxAge: 300) {
            q.latitude = loc.coordinate.latitude
            q.longitude = loc.coordinate.longitude
            q.q = trimmed.isEmpty ? nil : trimmed
            usingAreaSearch = false
        } else {
            // 位置が使えない場合はエリア名での手動検索
            q.areaQuery = trimmed.isEmpty ? nil : trimmed
            usingAreaSearch = true
        }
        do {
            let page = try await env.api.searchJobs(q)
            jobs = page.items
            nextCursor = page.nextCursor
            query = q
        } catch {
            errorMessage = error.hdUserMessage
        }
    }

    func loadMore(env: AppEnvironment) async {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        var q = query
        q.cursor = cursor
        do {
            let page = try await env.api.searchJobs(q)
            let known = Set(jobs.map(\.id))
            jobs.append(contentsOf: page.items.filter { !known.contains($0.id) })
            nextCursor = page.nextCursor
        } catch {
            errorMessage = error.hdUserMessage
        }
    }

    var activeFilterCount: Int {
        var n = 0
        if query.date != nil { n += 1 }
        if query.startAfterHour != nil { n += 1 }
        if (query.minAmountYen ?? 0) > 0 { n += 1 }
        if query.eligibleOnly == true { n += 1 }
        if query.favoritesOnly == true { n += 1 }
        if query.sort != nil && query.sort != .recommended { n += 1 }
        return n
    }
}

struct JobSearchView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model = JobSearchViewModel()
    @State private var showFilters = false
    @State private var showMap = false
    @State private var selectedJobId: String?

    var body: some View {
        VStack(spacing: 0) {
            searchHeader
            if showMap {
                mapContent
            } else {
                listContent
            }
        }
        .hdScreenBackground()
        .navigationTitle("案件を探す")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    env.router.push(.myAssignments, on: .jobs)
                } label: {
                    Label("マイ案件", systemImage: "list.bullet.clipboard")
                }
                .accessibilityIdentifier("myAssignmentsButton")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Picker("表示", selection: $showMap) {
                    Image(systemName: "list.bullet").accessibilityLabel("リスト").tag(false)
                    Image(systemName: "map").accessibilityLabel("地図").tag(true)
                }
                .pickerStyle(.segmented)
                .frame(width: 110)
            }
        }
        .sheet(isPresented: $showFilters) {
            JobFiltersView(query: $model.query) {
                Task { await model.search(env: env) }
            }
        }
        .task {
            if !model.loadedOnce { await model.search(env: env) }
        }
        .onChange(of: env.location.authorization) { _, _ in
            Task { await model.search(env: env) }
        }
    }

    // MARK: 検索欄・カテゴリ

    private var searchHeader: some View {
        VStack(alignment: .leading, spacing: HDSpacing.sm) {
            HStack(spacing: HDSpacing.sm) {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(HDColor.textSecondary).accessibilityHidden(true)
                    TextField(model.usingAreaSearch ? "エリア名で検索（例 横浜市中区）" : "場所・キーワードで検索", text: $model.text)
                        .submitLabel(.search)
                        .onSubmit { Task { await model.search(env: env) } }
                        .accessibilityIdentifier("jobSearchField")
                }
                .padding(.horizontal, HDSpacing.md)
                .frame(minHeight: 48)
                .background(HDColor.surface, in: RoundedRectangle(cornerRadius: HDRadius.button))
                .overlay(RoundedRectangle(cornerRadius: HDRadius.button).stroke(HDColor.border))

                Button {
                    showFilters = true
                } label: {
                    Image(systemName: model.activeFilterCount > 0 ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                        .font(.title2)
                        .frame(width: 48, height: 48)
                }
                .accessibilityLabel(model.activeFilterCount > 0 ? "絞り込み（\(model.activeFilterCount)件適用中）" : "絞り込み")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: HDSpacing.sm) {
                    ChipButton(title: "すべて", isSelected: model.category == nil) {
                        model.category = nil
                        Task { await model.search(env: env) }
                    }
                    ForEach(JobCategory.searchable, id: \.self) { c in
                        ChipButton(title: c.label, isSelected: model.category == c, color: c.color) {
                            model.category = c
                            Task { await model.search(env: env) }
                        }
                    }
                }
            }
            locationNotice
        }
        .padding(.horizontal, HDSpacing.lg)
        .padding(.vertical, HDSpacing.sm)
    }

    @ViewBuilder
    private var locationNotice: some View {
        if env.location.authorization == .notDetermined {
            Button {
                env.location.requestWhenInUse()
            } label: {
                Label("現在地の近くから探す", systemImage: "location.fill")
                    .font(.hd(.subheadline, .semibold))
                    .frame(minHeight: 44)
            }
        } else if env.location.isDenied {
            HStack {
                Label("位置情報がオフのため、エリア名で検索します", systemImage: "location.slash")
                    .font(.hd(.footnote))
                    .foregroundStyle(HDColor.textSecondary)
                Spacer()
                Button("設定") { SystemSettings.open() }
                    .font(.hd(.footnote, .semibold))
                    .frame(minHeight: 44)
            }
        }
    }

    // MARK: リスト

    @ViewBuilder
    private var listContent: some View {
        if model.isLoading && model.jobs.isEmpty {
            LoadingStateView()
            Spacer()
        } else if let error = model.errorMessage, model.jobs.isEmpty {
            ErrorStateView(message: error) { Task { await model.search(env: env) } }
        } else if model.jobs.isEmpty && model.loadedOnce {
            EmptyStateView(title: "条件に合う案件がありません", systemImage: "magnifyingglass", message: model.usingAreaSearch && model.text.isEmpty ? "エリア名（市区町村など）を入力して検索してください。" : "条件を変えて検索してください。")
        } else {
            ScrollView {
                LazyVStack(spacing: HDSpacing.md) {
                    ForEach(model.jobs) { job in
                        NavigationLink(value: AppRoute.job(job.id)) {
                            JobCard(job: job)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("jobCard")
                        .onAppear {
                            if job.id == model.jobs.last?.id {
                                Task { await model.loadMore(env: env) }
                            }
                        }
                    }
                    if model.isLoadingMore { ProgressView().padding() }
                }
                .padding(HDSpacing.lg)
            }
            .refreshable { await model.search(env: env) }
        }
    }

    // MARK: 地図

    private var mapContent: some View {
        let located = model.jobs.filter { $0.approximateLocation != nil }
        return ZStack(alignment: .bottom) {
            Map(initialPosition: .automatic, selection: $selectedJobId) {
                ForEach(located) { job in
                    Annotation(job.title, coordinate: job.approximateLocation!.coordinate) {
                        Text(HDFormat.yen(job.amountYen))
                            .font(.hd(.caption, .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(job.category.color, in: Capsule())
                            .accessibilityLabel("\(job.title) \(HDFormat.yenSpoken(job.amountYen))")
                    }
                    .tag(job.id)
                }
                if env.location.isAuthorized { UserAnnotation() }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .id(located.map(\.id))

            if let id = selectedJobId, let job = model.jobs.first(where: { $0.id == id }) {
                NavigationLink(value: AppRoute.job(job.id)) {
                    JobCard(job: job)
                }
                .buttonStyle(.plain)
                .padding(HDSpacing.lg)
            } else if located.count < model.jobs.count {
                Text("地図に表示できない案件は一覧で確認できます")
                    .font(.hd(.footnote))
                    .padding(HDSpacing.sm)
                    .background(.regularMaterial, in: Capsule())
                    .padding(HDSpacing.lg)
            }
        }
    }
}

/// 案件カード（発注者・タイトル・日時・所要・距離・金額・推薦理由）
struct JobCard: View {
    let job: Job

    var body: some View {
        HDCard {
            HStack(spacing: HDSpacing.xs) {
                Text(job.organizationName)
                    .font(.hd(.caption, .semibold))
                    .foregroundStyle(HDColor.jobGreen)
                    .padding(.horizontal, HDSpacing.sm)
                    .padding(.vertical, 4)
                    .background(HDColor.jobGreenSoft, in: Capsule())
                if job.organizationVerified == true {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(HDColor.brandBlue)
                        .accessibilityLabel("審査済みの発注者")
                }
                Spacer()
                CategoryTag(category: job.category)
            }
            Text(job.title)
                .font(.hd(.title3, .bold))
                .foregroundStyle(HDColor.textPrimary)
            Text(meta)
                .font(.hd(.subheadline))
                .foregroundStyle(HDColor.textSecondary)
            if let reasons = job.matchReasons, !reasons.isEmpty {
                HStack(spacing: HDSpacing.xs) {
                    ForEach(reasons.prefix(3), id: \.self) { r in
                        Label(r, systemImage: "sparkles")
                            .font(.hd(.caption))
                            .foregroundStyle(HDColor.brandBlue)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(HDColor.brandBlueSoft, in: Capsule())
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("おすすめの理由 \(reasons.joined(separator: "、"))")
            }
            HStack {
                statusLine
                Spacer()
                PricePill(amountYen: job.amountYen)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var meta: String {
        var parts = [HDFormat.relativeDayTime(job.startsAt), HDFormat.duration(minutes: job.effectiveDurationMinutes), job.areaLabel]
        if let d = job.distanceKm { parts.append(HDFormat.distance(km: d)) }
        return parts.joined(separator: " • ")
    }

    @ViewBuilder
    private var statusLine: some View {
        if job.myAssignmentId != nil {
            StatusBadge(presentation: StatusPresentation("受諾済み", "checkmark.seal", .success), compact: true)
        } else if job.isFull {
            StatusBadge(presentation: StatusPresentation(job.waitlisted == true ? "満員（空き待ち登録済み）" : "満員", "person.3.fill", .neutral), compact: true)
        } else if job.eligible == false {
            StatusBadge(presentation: StatusPresentation("条件を満たしていません", "exclamationmark.circle", .warning), compact: true)
        } else {
            Text("残り\(job.remainingCapacity)枠")
                .font(.hd(.footnote, .semibold))
                .foregroundStyle(HDColor.textSecondary)
        }
    }
}

/// 絞り込み
struct JobFiltersView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var query: JobSearchQuery
    let onApply: () -> Void

    @State private var useDate = false
    @State private var date = Date()
    @State private var useStartHour = false
    @State private var startHour = 9
    @State private var minAmount = 0
    @State private var eligibleOnly = false
    @State private var favoritesOnly = false
    @State private var sort: JobSort = .recommended
    @State private var radius: Double = 10

    var body: some View {
        NavigationStack {
            Form {
                Section("日時") {
                    Toggle("日付を指定", isOn: $useDate)
                    if useDate {
                        DatePicker("日付", selection: $date, in: Date()..., displayedComponents: .date)
                            .environment(\.timeZone, HDFormat.jst)
                    }
                    Toggle("開始時刻を指定", isOn: $useStartHour)
                    if useStartHour {
                        Stepper("\(startHour)時以降に開始", value: $startHour, in: 0...23)
                    }
                }
                Section("報酬") {
                    Picker("最低報酬", selection: $minAmount) {
                        Text("指定なし").tag(0)
                        ForEach([500, 1000, 2000, 3000, 5000], id: \.self) { v in
                            Text("\(HDFormat.yen(v))以上").tag(v)
                        }
                    }
                }
                Section("距離") {
                    VStack(alignment: .leading) {
                        Text("現在地から \(Int(radius)) km 以内")
                        Slider(value: $radius, in: 1...50, step: 1)
                            .accessibilityLabel("検索範囲（キロメートル）")
                    }
                }
                Section {
                    Toggle("応募できる案件のみ", isOn: $eligibleOnly)
                    Toggle("お気に入りのみ", isOn: $favoritesOnly)
                    Picker("並び順", selection: $sort) {
                        ForEach(JobSort.allCases, id: \.self) { s in Text(s.label).tag(s) }
                    }
                } footer: {
                    Text("おすすめ順は、資格・時間・距離などの条件を満たす案件だけを、理由を示して並べます。")
                }
            }
            .navigationTitle("絞り込み")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("リセット") { reset() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("適用") { apply() }
                }
            }
            .onAppear(perform: load)
        }
    }

    private func load() {
        if let d = query.date, let parsed = HDFormat.parseAPIDate(d) {
            useDate = true
            date = parsed
        }
        if let h = query.startAfterHour {
            useStartHour = true
            startHour = h
        }
        minAmount = query.minAmountYen ?? 0
        eligibleOnly = query.eligibleOnly ?? false
        favoritesOnly = query.favoritesOnly ?? false
        sort = query.sort ?? .recommended
        radius = query.radiusKm ?? 10
    }

    private func reset() {
        useDate = false
        useStartHour = false
        minAmount = 0
        eligibleOnly = false
        favoritesOnly = false
        sort = .recommended
        radius = 10
    }

    private func apply() {
        query.date = useDate ? HDFormat.apiDate(date) : nil
        query.startAfterHour = useStartHour ? startHour : nil
        query.minAmountYen = minAmount > 0 ? minAmount : nil
        query.eligibleOnly = eligibleOnly ? true : nil
        query.favoritesOnly = favoritesOnly ? true : nil
        query.sort = sort
        query.radiusKm = radius
        onApply()
        dismiss()
    }
}
