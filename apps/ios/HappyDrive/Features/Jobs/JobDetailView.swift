import SwiftUI
import HappyDriveCore

struct JobDetailView: View {
    @Environment(AppEnvironment.self) private var env
    let jobId: String

    @State private var state: LoadState<Job> = .idle
    @State private var showAccept = false
    @State private var alert: AlertMessage?
    @State private var showReport = false
    @State private var showAppeal = false
    @State private var confirmBlock = false
    @State private var isTogglingWaitlist = false

    var body: some View {
        LoadStateContainer(state: state, retry: { Task { await load() } }) { job in
            content(job)
        }
        .hdScreenBackground()
        .navigationTitle("案件の詳細")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let job = state.value {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await toggleFavorite(job) }
                    } label: {
                        Image(systemName: job.isFavorite == true ? "heart.fill" : "heart")
                            .foregroundStyle(job.isFavorite == true ? HDColor.danger : HDColor.textPrimary)
                    }
                    .accessibilityLabel(job.isFavorite == true ? "お気に入りを解除" : "お気に入りに追加")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            showReport = true
                        } label: {
                            Label("この案件を通報", systemImage: "exclamationmark.bubble")
                        }
                        Button(role: .destructive) {
                            confirmBlock = true
                        } label: {
                            Label("この発注者をブロック", systemImage: "hand.raised")
                        }
                        Button {
                            showAppeal = true
                        } label: {
                            Label("おすすめ・条件判定への異議申立て", systemImage: "questionmark.bubble")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").accessibilityLabel("その他の操作")
                    }
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showAccept) {
            if let job = state.value {
                AcceptConfirmationSheet(job: job) { outcome in
                    handleAcceptOutcome(outcome)
                }
            }
        }
        .sheet(isPresented: $showReport) {
            if let job = state.value {
                ReportSheet(targetType: .job, targetId: job.id, targetName: job.title)
            }
        }
        .sheet(isPresented: $showAppeal) {
            MatchingAppealSheet(jobId: jobId)
        }
        .confirmationDialog("この発注者をブロックしますか？", isPresented: $confirmBlock, titleVisibility: .visible) {
            Button("ブロックする", role: .destructive) { Task { await block() } }
        } message: {
            Text("ブロックすると、この発注者の案件は検索やおすすめに表示されなくなります。")
        }
        .hdAlert($alert)
    }

    // MARK: 表示

    private func content(_ job: Job) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HDSpacing.lg) {
                HDHeroCard(color: HDColor.jobGreen) {
                    Label(job.category.label, systemImage: job.category.symbol)
                        .font(.hd(.subheadline, .medium))
                    Text(job.title)
                        .font(.hd(.title2, .bold))
                    Text([job.areaLabel, job.distanceKm.map { HDFormat.distance(km: $0) }].compactMap { $0 }.joined(separator: " ・ "))
                        .font(.hd(.subheadline))
                }

                HDCard {
                    Text("報酬 \(HDFormat.yen(job.amountYen))")
                        .font(.hd(.title2, .bold))
                        .foregroundStyle(HDColor.textPrimary)
                        .accessibilityLabel("報酬 \(HDFormat.yenSpoken(job.amountYen))")
                    InfoRow(title: "日時", value: "\(HDFormat.schedule(job.startsAt, job.endsAt)) / 所要\(HDFormat.duration(minutes: job.effectiveDurationMinutes))", systemImage: "clock")
                    if let exp = job.expensesReimbursedYen, exp > 0 {
                        InfoRow(title: "実費の支給（交通費等）", value: HDFormat.yen(exp), systemImage: "tram")
                    }
                    if let borne = job.workerBorneCostsNote, !borne.isEmpty {
                        InfoRow(title: "ご自身の負担", value: borne, systemImage: "fuelpump")
                    }
                    InfoRow(title: "募集枠", value: "残り \(job.remainingCapacity) / \(job.capacity) 枠", systemImage: "person.2")
                }

                HDCard {
                    Text("発注者").font(.hd(.headline, .bold))
                    HStack {
                        Text(job.organizationName).font(.hd(.body, .semibold))
                        if job.organizationVerified == true {
                            Label("審査済み", systemImage: "checkmark.seal.fill")
                                .font(.hd(.caption, .semibold))
                                .foregroundStyle(HDColor.brandBlue)
                        }
                    }
                    if let a = job.organizationAddress { InfoRow(title: "所在地", value: a, systemImage: "building.2") }
                    if let c = job.organizationContact { InfoRow(title: "連絡先", value: c, systemImage: "envelope") }
                    if let name = job.contactName { InfoRow(title: "担当", value: name, systemImage: "person") }
                }

                HDCard {
                    HStack {
                        Text("契約区分").font(.hd(.headline, .bold))
                        Spacer()
                        StatusBadge(presentation: job.contractType.presentation)
                    }
                    Text(job.contractType.explanation)
                        .font(.hd(.subheadline))
                        .foregroundStyle(HDColor.textSecondary)
                    if job.contractType == .employment, let terms = job.employmentTermsText, !terms.isEmpty {
                        Text("労働条件").font(.hd(.subheadline, .bold))
                        Text(terms).font(.hd(.subheadline))
                    }
                    if let pay = job.paymentTermsText, !pay.isEmpty {
                        Text(job.contractType == .employment ? "賃金の支払" : "報酬の支払条件").font(.hd(.subheadline, .bold))
                        Text(pay).font(.hd(.subheadline))
                    }
                }

                HDCard {
                    Text("業務内容").font(.hd(.headline, .bold))
                    Text(job.description).font(.hd(.body))
                    if !job.steps.isEmpty {
                        Text("手順").font(.hd(.subheadline, .bold)).padding(.top, HDSpacing.xs)
                        ForEach(Array(job.steps.enumerated()), id: \.offset) { i, step in
                            HStack(alignment: .top) {
                                Text("\(i + 1).").font(.hd(.subheadline, .bold))
                                VStack(alignment: .leading) {
                                    Text(step.title).font(.hd(.subheadline))
                                    if step.requiresPhoto == true {
                                        Label("写真が必要", systemImage: "camera").font(.hd(.caption)).foregroundStyle(HDColor.textSecondary)
                                    }
                                }
                            }
                        }
                    }
                    let skills = job.requiredSkillNames ?? job.requiredSkills
                    InfoRow(title: "必要な資格・講習", value: skills.isEmpty ? "なし" : skills.joined(separator: "、"), systemImage: "graduationcap")
                    if let min = job.minPhotoCount, min > 0 {
                        InfoRow(title: "報告に必要な写真", value: "\(min)枚以上", systemImage: "camera")
                    }
                    InfoRow(title: "集合場所", value: job.myAssignmentId != nil ? (job.meetingPointNote ?? "業務画面で確認できます") : "受諾後に表示", systemImage: "mappin")
                }

                if let reasons = job.matchReasons, !reasons.isEmpty {
                    HDCard {
                        Text("おすすめの理由").font(.hd(.headline, .bold))
                        FlowChips(items: reasons)
                    }
                }

                if job.eligible == false {
                    HDCard {
                        Label("この案件の条件を満たしていません", systemImage: "exclamationmark.circle.fill")
                            .font(.hd(.headline, .bold))
                            .foregroundStyle(HDColor.warning)
                        ForEach(job.ineligibleReasons ?? [], id: \.self) { r in
                            Text("・\(r)").font(.hd(.subheadline))
                        }
                        Button("判定に異議を申し立てる") { showAppeal = true }
                            .font(.hd(.subheadline, .semibold))
                            .frame(minHeight: 44)
                    }
                }

                HDCard {
                    Text("キャンセル条件").font(.hd(.headline, .bold))
                    Text(job.cancellationPolicy.text).font(.hd(.subheadline))
                    InfoRow(title: "無償で取消できる期限", value: "開始\(job.cancellationPolicy.freeCancelHoursBefore)時間前まで")
                    InfoRow(title: "期限後に発注者が取消した場合の補償", value: "\(job.cancellationPolicy.lateCancelCompensationPercent)%")
                }

                if let safety = job.safetyNotes, !safety.isEmpty {
                    HDCard {
                        Label("安全上の注意", systemImage: "exclamationmark.shield").font(.hd(.headline, .bold))
                        Text(safety).font(.hd(.subheadline))
                    }
                }

                actionArea(job)
            }
            .padding(HDSpacing.lg)
        }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func actionArea(_ job: Job) -> some View {
        VStack(spacing: HDSpacing.sm) {
            if let assignmentId = job.myAssignmentId {
                Button("業務を開く") { env.router.push(.assignment(assignmentId)) }
                    .buttonStyle(.hdPrimary)
            } else if job.isFull {
                NoticeBox(kind: .info, text: "この案件は満員です。空き待ちに登録すると、空きが出たときに通知します（自動では確保されません）。")
                if job.waitlisted == true {
                    Button {
                        Task { await toggleWaitlist(job) }
                    } label: {
                        Text(isTogglingWaitlist ? "処理中…" : "空き待ちを解除")
                    }
                    .buttonStyle(.hdSecondary)
                    .disabled(isTogglingWaitlist)
                } else {
                    Button {
                        Task { await toggleWaitlist(job) }
                    } label: {
                        ProgressLabel(title: "空き待ちに登録", isLoading: isTogglingWaitlist)
                    }
                    .buttonStyle(.hdPrimary)
                    .disabled(isTogglingWaitlist)
                }
            } else if job.contractType == .other_legal_review || job.contractType == .unknown {
                NoticeBox(kind: .warning, text: job.contractType.explanation)
            } else if let blocker = env.session.acceptBlocker {
                NoticeBox(kind: .warning, text: blocker)
                Button("登録を続ける") { env.router.push(.verification, on: .myPage) }
                    .buttonStyle(.hdSecondary)
            } else if job.eligible == false {
                Button("内容を確認して受諾") {}
                    .buttonStyle(.hdPrimary)
                    .disabled(true)
                    .accessibilityHint("条件を満たしていないため受諾できません")
            } else {
                Button("内容を確認して受諾") { showAccept = true }
                    .buttonStyle(.hdPrimary)
                    .accessibilityIdentifier("reviewAndAcceptButton")
            }
        }
    }

    // MARK: 処理

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await env.api.job(id: jobId))
        } catch {
            if state.value == nil { state = .failed(error.hdUserMessage) } else { alert = AlertMessage(error: error) }
        }
    }

    private func toggleFavorite(_ job: Job) async {
        let newValue = !(job.isFavorite ?? false)
        do {
            try await env.api.setFavorite(jobId: job.id, favorite: newValue)
            var updated = job
            updated.isFavorite = newValue
            state = .loaded(updated)
        } catch {
            alert = AlertMessage(error: error)
        }
    }

    private func toggleWaitlist(_ job: Job) async {
        isTogglingWaitlist = true
        defer { isTogglingWaitlist = false }
        let join = !(job.waitlisted ?? false)
        do {
            try await env.api.setWaitlist(jobId: job.id, joined: join)
            var updated = job
            updated.waitlisted = join
            state = .loaded(updated)
            if join {
                alert = AlertMessage(title: "空き待ちに登録しました", message: "空きが出たら通知でお知らせします。先着順のため、通知後に受諾してください。")
                await env.push.requestAuthorizationIfNeeded()
            }
        } catch {
            alert = AlertMessage(error: error)
        }
    }

    private func block() async {
        guard let job = state.value else { return }
        do {
            try await env.api.blockOrganization(id: job.organizationId)
            alert = AlertMessage(title: "ブロックしました", message: "\(job.organizationName)の案件は今後表示されません。")
        } catch {
            alert = AlertMessage(error: error)
        }
    }

    private func handleAcceptOutcome(_ outcome: AcceptOutcome) {
        switch outcome {
        case .accepted(let assignment):
            Task {
                await load()
                await env.push.requestAuthorizationIfNeeded()
            }
            env.router.push(.assignment(assignment.id))
        case .waitlistOffered:
            Task { await load() }
        case .reload:
            Task { await load() }
        }
    }
}

/// 折り返すチップ
struct FlowChips: View {
    let items: [String]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: HDSpacing.xs) { chips }
            VStack(alignment: .leading, spacing: HDSpacing.xs) { chips }
        }
    }

    private var chips: some View {
        ForEach(items, id: \.self) { r in
            Label(r, systemImage: "sparkles")
                .font(.hd(.footnote, .semibold))
                .foregroundStyle(HDColor.brandBlue)
                .padding(.horizontal, HDSpacing.sm)
                .padding(.vertical, 4)
                .background(HDColor.brandBlueSoft, in: Capsule())
        }
    }
}
