import SwiftUI
import HappyDriveCore

struct MyPageView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var summary: LoadState<EarningsSummary> = .idle
    @State private var confirmLogout = false

    private var month: String { HDFormat.apiMonth(Date()) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HDSpacing.md) {
                header
                earningsCard
                menu
            }
            .padding(HDSpacing.lg)
        }
        .hdScreenBackground()
        .navigationTitle("マイページ")
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog("ログアウトしますか？", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("ログアウト", role: .destructive) { Task { await env.signOut() } }
        } message: {
            Text(env.pendingMutations.isEmpty ? "" : "送信待ちの記録が\(env.pendingMutations.count)件あります。ログアウトすると送信されません。")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: HDSpacing.xs) {
            Wordmark(height: 40)
            if let user = env.session.user {
                HStack(spacing: HDSpacing.sm) {
                    Text(user.displayName.isEmpty ? "ドライバー" : user.displayName)
                        .font(.hd(.title3, .bold))
                    if let avg = user.ratingAverage, (user.ratingCount ?? 0) > 0 {
                        Label(String(format: "%.1f", avg), systemImage: "star.fill")
                            .font(.hd(.headline, .bold))
                            .foregroundStyle(HDColor.textPrimary)
                            .accessibilityLabel("評価 \(String(format: "%.1f", avg))（\(user.ratingCount ?? 0)件）")
                    }
                }
                StatusBadge(presentation: user.verificationStatus.presentation, compact: true)
            } else if let error = env.session.userLoadError {
                NoticeBox(kind: .warning, text: error)
            }
        }
    }

    private var earningsCard: some View {
        Button {
            env.router.push(.earnings, on: .myPage)
        } label: {
            HDHeroCard {
                Text("今月の報酬（\(HDFormat.displayMonth(month))）")
                    .font(.hd(.subheadline, .medium))
                switch summary {
                case .loaded(let s):
                    Text(HDFormat.yen(s.totalYen))
                        .font(.hd(.largeTitle, .bold))
                        .accessibilityLabel(HDFormat.yenSpoken(s.totalYen))
                    Text("完了案件 \(s.completedCount)件")
                        .font(.hd(.subheadline))
                    Text("振込済 \(HDFormat.yen(s.paidYen)) ・ 支払予定 \(HDFormat.yen(s.payableYen)) ・ 確定待ち \(HDFormat.yen(s.pendingYen)) ・ 見込み \(HDFormat.yen(s.estimatedYen))")
                        .font(.hd(.caption))
                        .opacity(0.9)
                case .failed(let m):
                    Text(m).font(.hd(.subheadline))
                default:
                    ProgressView().tint(.white)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("報酬・振込履歴を開きます")
    }

    private var menu: some View {
        VStack(spacing: HDSpacing.sm) {
            MenuRow(title: "AIアシスタント（音声で話す）", systemImage: "waveform") { env.router.openVoiceAssistant() }
                .accessibilityIdentifier("voiceAssistantMenuRow")
            MenuRow(title: "報酬・振込履歴", systemImage: "yensign.circle") { env.router.push(.earnings, on: .myPage) }
            MenuRow(title: "実績・評価", systemImage: "star") { env.router.push(.results, on: .myPage) }
            MenuRow(title: "資格・講習", systemImage: "graduationcap") { env.router.push(.skills, on: .myPage) }
            MenuRow(title: "通知", systemImage: "bell") { env.router.push(.notifications, on: .myPage) }
            MenuRow(title: "メッセージ", systemImage: "bubble.left.and.bubble.right") { env.router.push(.messages, on: .myPage) }
            MenuRow(title: "本人確認・登録状況", systemImage: "person.text.rectangle") { env.router.push(.verification, on: .myPage) }
            MenuRow(title: "アカウント・設定", systemImage: "gearshape") { env.router.push(.accountSettings, on: .myPage) }
            MenuRow(title: "ヘルプ・お問い合わせ", systemImage: "questionmark.circle") { env.router.push(.support, on: .myPage) }
            Button(role: .destructive) {
                confirmLogout = true
            } label: {
                Text("ログアウト").frame(maxWidth: .infinity, minHeight: 44)
            }
            .padding(.top, HDSpacing.sm)
        }
    }

    private func load() async {
        if summary.value == nil { summary = .loading }
        let session = env.session
        async let refreshUser: Void = session.refreshUser()
        do {
            summary = .loaded(try await env.api.earningsSummary(month: month))
        } catch {
            summary = .failed(error.hdUserMessage)
        }
        await refreshUser
    }
}

struct MenuRow: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: systemImage)
                    .font(.hd(.body, .semibold))
                    .foregroundStyle(HDColor.textPrimary)
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundStyle(HDColor.textSecondary)
                    .accessibilityHidden(true)
            }
            .padding(HDSpacing.lg)
            .frame(minHeight: 56)
            .background(HDColor.surface, in: RoundedRectangle(cornerRadius: HDRadius.card))
            .overlay(RoundedRectangle(cornerRadius: HDRadius.card).stroke(HDColor.border))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 報酬

struct EarningsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var month = HDFormat.apiMonth(Date())
    @State private var summary: EarningsSummary?
    @State private var entries: LoadState<[EarningEntry]> = .idle

    var body: some View {
        List {
            Section {
                HStack {
                    Button {
                        month = HDFormat.shiftMonth(month, by: -1)
                    } label: {
                        Image(systemName: "chevron.left").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("前の月")
                    Spacer()
                    Text(HDFormat.displayMonth(month)).font(.hd(.headline, .bold))
                    Spacer()
                    Button {
                        month = HDFormat.shiftMonth(month, by: 1)
                    } label: {
                        Image(systemName: "chevron.right").frame(width: 44, height: 44)
                    }
                    .disabled(month >= HDFormat.apiMonth(Date()))
                    .accessibilityLabel("次の月")
                }
                .buttonStyle(.plain)
            }

            if let s = summary {
                Section("集計") {
                    InfoRow(title: "合計", value: HDFormat.yen(s.totalYen))
                    InfoRow(title: "振込済", value: HDFormat.yen(s.paidYen))
                    InfoRow(title: "支払予定", value: HDFormat.yen(s.payableYen))
                    InfoRow(title: "確定待ち", value: HDFormat.yen(s.pendingYen))
                    InfoRow(title: "見込み", value: HDFormat.yen(s.estimatedYen))
                    if let e = s.employmentYen, e > 0 { InfoRow(title: "うち雇用（賃金）", value: HDFormat.yen(e)) }
                    if let c = s.contractorYen, c > 0 { InfoRow(title: "うち業務委託（報酬）", value: HDFormat.yen(c)) }
                    InfoRow(title: "完了案件", value: "\(s.completedCount)件")
                }
            }

            Section {
                Text(EarningsPresentation.payoutNotice)
                    .font(.hd(.footnote))
                    .foregroundStyle(HDColor.textSecondary)
                NavigationLink(value: AppRoute.payouts) {
                    Label("振込履歴", systemImage: "building.columns")
                }
            }

            switch entries {
            case .idle, .loading:
                Section { LoadingStateView() }
            case .failed(let m):
                Section { ErrorStateView(message: m) { Task { await load() } } }
            case .loaded(let list):
                Section("明細") {
                    if list.isEmpty {
                        Text("この月の報酬はありません").foregroundStyle(HDColor.textSecondary)
                    }
                    ForEach(list, id: \.stableId) { e in
                        EarningRow(entry: e)
                    }
                }
            }
        }
        .navigationTitle("報酬・振込履歴")
        .task(id: month) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        entries = .loading
        let api = env.api
        let m = month
        do {
            async let s = api.earningsSummary(month: m)
            async let e = api.earnings(month: m)
            let (sum, list) = try await (s, e)
            summary = sum
            entries = .loaded(list)
        } catch {
            entries = .failed(error.hdUserMessage)
        }
    }
}

struct EarningRow: View {
    let entry: EarningEntry
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 4) {
                if let org = entry.organizationName { InfoRow(title: "発注者", value: org) }
                if let c = entry.contractType { InfoRow(title: "契約区分", value: c.label) }
                if let d = entry.workDate { InfoRow(title: "実施日", value: HDFormat.displayAPIDate(d)) }
                if let d = entry.scheduledPayoutDate { InfoRow(title: "振込予定日", value: HDFormat.displayAPIDate(d)) }
                if let p = entry.paidAt { InfoRow(title: "振込日", value: HDFormat.dateTime(p)) }
                ForEach(Array((entry.breakdown ?? []).enumerated()), id: \.offset) { _, line in
                    InfoRow(title: breakdownLabel(line), value: HDFormat.yen(line.amountYen))
                }
                Text(entry.state.explanation).font(.hd(.footnote)).foregroundStyle(HDColor.textSecondary)
            }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(entry.jobTitle ?? "案件").font(.hd(.body, .semibold))
                    Spacer()
                    Text(HDFormat.yen(entry.amountYen)).font(.hd(.body, .bold))
                }
                StatusBadge(presentation: entry.state.presentation, compact: true)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func breakdownLabel(_ line: EarningBreakdownLine) -> String {
        let base: String
        switch line.type {
        case "base", "reward": base = "報酬"
        case "wage": base = "賃金"
        case "expenses", "expense": base = "実費"
        case "late_cancel_compensation", "compensation": base = "取消補償"
        case "adjustment": base = "調整"
        case "fee": base = "手数料"
        default: base = line.type
        }
        return line.note.map { "\(base)（\($0)）" } ?? base
    }
}

struct PayoutsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var state: LoadState<[Payout]> = .idle

    var body: some View {
        LoadStateContainer(state: state, retry: { Task { await load() } }) { list in
            if list.isEmpty {
                EmptyStateView(title: "振込履歴はありません", systemImage: "building.columns", message: "報酬が確定すると、振込予定日にまとめて振り込まれます。")
            } else {
                List(list) { p in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(HDFormat.yen(p.amountYen)).font(.hd(.headline, .bold))
                            Spacer()
                            StatusBadge(presentation: p.status.presentation, compact: true)
                        }
                        if let d = p.scheduledDate { Text("振込予定日 \(HDFormat.displayAPIDate(d))").font(.hd(.subheadline)) }
                        if let paid = p.paidAt { Text("振込日 \(HDFormat.dateTime(paid))").font(.hd(.subheadline)) }
                        if p.status == .failed {
                            Text(p.failureReason.map { "失敗理由：\($0)。口座情報を確認してください。" } ?? "振込に失敗しました。口座情報を確認してください。")
                                .font(.hd(.footnote))
                                .foregroundStyle(HDColor.danger)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }
                .refreshable { await load() }
            }
        }
        .navigationTitle("振込履歴")
        .task { await load() }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await env.api.payouts().sorted { $0.createdAt > $1.createdAt })
        } catch {
            state = .failed(error.hdUserMessage)
        }
    }
}

// MARK: - 実績・評価

struct ResultsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var history: LoadState<[Assignment]> = .idle

    var body: some View {
        List {
            if let user = env.session.user {
                Section("実績") {
                    InfoRow(title: "完了した案件", value: "\(user.completedJobCount ?? 0)件")
                    if let avg = user.ratingAverage, let count = user.ratingCount, count > 0 {
                        InfoRow(title: "発注者からの評価", value: "★ \(String(format: "%.1f", avg))（\(count)件）")
                    } else {
                        InfoRow(title: "発注者からの評価", value: "まだありません")
                    }
                }
            }
            switch history {
            case .idle, .loading:
                Section { LoadingStateView() }
            case .failed(let m):
                Section { ErrorStateView(message: m) { Task { await load() } } }
            case .loaded(let list):
                Section("これまでの案件") {
                    if list.isEmpty { Text("履歴はありません").foregroundStyle(HDColor.textSecondary) }
                    ForEach(list) { a in
                        NavigationLink(value: AppRoute.assignment(a.id)) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(a.job?.title ?? "案件").font(.hd(.body, .semibold))
                                if let job = a.job {
                                    Text("\(HDFormat.monthDay(job.startsAt)) ・ \(job.organizationName)").font(.hd(.footnote)).foregroundStyle(HDColor.textSecondary)
                                }
                                StatusBadge(presentation: a.state.presentation, compact: true)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("実績・評価")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        if history.value == nil { history = .loading }
        do {
            history = .loaded(try await env.api.assignments(scope: .history))
        } catch {
            history = .failed(error.hdUserMessage)
        }
    }
}

// MARK: - 通知

struct NotificationsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var state: LoadState<[AppNotification]> = .idle
    @State private var alert: AlertMessage?

    var body: some View {
        LoadStateContainer(state: state, retry: { Task { await load() } }) { list in
            if list.isEmpty {
                EmptyStateView(title: "通知はありません", systemImage: "bell")
            } else {
                List(list) { n in
                    Button {
                        Task { await open(n) }
                    } label: {
                        HStack(alignment: .top, spacing: HDSpacing.sm) {
                            Image(systemName: n.isUnread ? "circle.fill" : "circle")
                                .font(.caption)
                                .foregroundStyle(n.isUnread ? HDColor.brandBlue : .clear)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(n.title).font(.hd(.body, n.isUnread ? .bold : .regular)).foregroundStyle(HDColor.textPrimary)
                                Text(n.body).font(.hd(.subheadline)).foregroundStyle(HDColor.textSecondary)
                                Text(HDFormat.relativeDayTime(n.createdAt)).font(.hd(.caption)).foregroundStyle(HDColor.textSecondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .accessibilityLabel("\(n.isUnread ? "未読 " : "")\(n.title) \(n.body)")
                }
                .refreshable { await load() }
            }
        }
        .navigationTitle("通知")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("すべて既読") { Task { await markAll() } }
                    .disabled((state.value ?? []).allSatisfy { !$0.isUnread })
            }
        }
        .task { await load() }
        .hdAlert($alert)
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await env.api.notifications())
        } catch {
            state = .failed(error.hdUserMessage)
        }
    }

    private func open(_ n: AppNotification) async {
        if n.isUnread {
            try? await env.api.markNotificationsRead(ids: [n.id])
            if var list = state.value, let i = list.firstIndex(where: { $0.id == n.id }) {
                list[i].readAt = Date()
                state = .loaded(list)
            }
        }
        if let link = DeepLink.from(entityType: n.entityType, entityId: n.entityId, type: n.type) {
            env.router.open(link)
        }
    }

    private func markAll() async {
        do {
            try await env.api.markNotificationsRead(all: true)
            await load()
        } catch {
            alert = AlertMessage(error: error)
        }
    }
}
