import SwiftUI
import HappyDriveCore

@Observable
@MainActor
final class WorkflowViewModel {
    let assignmentId: String
    var assignment: Assignment?
    var loadError: String?
    var isSending = false
    var errorMessage: String?
    var queuedNotice: String?
    var stepPhotos: [Int: [PhotoAttachment]] = [:]

    init(assignmentId: String) {
        self.assignmentId = assignmentId
    }

    var progress: AssignmentProgress? { assignment.map(AssignmentProgress.init(assignment:)) }

    func load(env: AppEnvironment) async {
        do {
            let a = try await env.api.assignment(id: assignmentId)
            assignment = a
            loadError = nil
            env.locationSharing.sync(assignmentId: a.id, state: a.state)
        } catch {
            if assignment == nil { loadError = error.hdUserMessage }
        }
    }

    /// 業務イベントを送る（オフラインキュー経由。送れない場合は保留して表示だけ進める）
    func send(_ event: AssignmentEventRequest, photos: [PhotoAttachment] = [], env: AppEnvironment) async -> Bool {
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            var mutation = try env.api.assignmentEventMutation(assignmentId: assignmentId, event: event)
            let pending = photos.pending(purpose: .work_photo, assignmentId: assignmentId)
            mutation.attachments = pending.attachments
            switch try await env.queue.submit(mutation, attachmentData: pending.data) {
            case .sent(let response):
                if let updated = try? HDJSON.makeDecoder().decode(Assignment.self, from: response.body) {
                    assignment = updated
                } else {
                    await load(env: env)
                }
                queuedNotice = nil
            case .queued:
                applyLocally(event)
                queuedNotice = "圏外のため端末に記録しました。通信が回復すると自動で送信します。"
            }
            if let a = assignment {
                env.locationSharing.sync(assignmentId: a.id, state: a.state)
            }
            return true
        } catch {
            errorMessage = error.hdUserMessage
            return false
        }
    }

    private func applyLocally(_ event: AssignmentEventRequest) {
        guard var a = assignment else { return }
        switch event.eventType {
        case .traveling: a.state = .traveling
        case .checked_in:
            a.state = .checked_in
            a.checkedInAt = event.occurredAt
        case .working:
            a.state = .working
            a.workStartedAt = event.occurredAt
        case .step_completed:
            if let i = a.steps?.firstIndex(where: { $0.index == event.stepIndex }) {
                a.steps?[i].completed = true
                a.steps?[i].completedAt = event.occurredAt
            }
        case .submitted:
            a.state = .submitted
            a.submittedAt = event.occurredAt
        case .cancelled: a.state = .cancelled
        case .safety_alert, .help_requested: break
        }
        assignment = a
    }
}

/// 業務を進める（移動 → チェックイン → 業務 → 手順 → 完了報告）
struct AssignmentWorkflowView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model: WorkflowViewModel
    @State private var sheet: Sheet?
    @State private var confirmCancel = false
    @State private var cancelReason = ""
    @State private var alert: AlertMessage?

    enum Sheet: Identifiable {
        case report, rating, safety, help, reportOrg
        var id: Int { hashValue }
    }

    init(assignmentId: String) {
        _model = State(initialValue: WorkflowViewModel(assignmentId: assignmentId))
    }

    var body: some View {
        Group {
            if let a = model.assignment {
                content(a)
            } else if let e = model.loadError {
                ErrorStateView(message: e) { Task { await model.load(env: env) } }
            } else {
                LoadingStateView()
            }
        }
        .hdScreenBackground()
        .navigationTitle("業務を進める")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .safeAreaInset(edge: .bottom) {
            if let a = model.assignment, a.state.isActive || a.state == .submitted {
                SafetyBar(onSafety: { sheet = .safety }, onHelp: { sheet = .help })
            }
        }
        .task { await model.load(env: env) }
        .refreshable { await model.load(env: env) }
        .sheet(item: $sheet) { s in
            if let a = model.assignment {
                switch s {
                case .report:
                    SubmitReportView(model: model)
                case .rating:
                    RatingView(assignment: a) { Task { await model.load(env: env) } }
                case .safety:
                    UrgentReportSheet(kind: .safety_alert, model: model)
                case .help:
                    UrgentReportSheet(kind: .help_requested, model: model)
                case .reportOrg:
                    ReportSheet(targetType: .organization, targetId: a.job?.organizationId ?? a.jobId, targetName: a.job?.organizationName ?? "発注者")
                }
            }
        }
        .confirmationDialog("この案件をキャンセルしますか？", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("キャンセルする", role: .destructive) {
                Task { _ = await model.send(AssignmentEventRequest(eventType: .cancelled, note: "ドライバーによるキャンセル", occurredAt: Date()), env: env) }
            }
        } message: {
            Text(cancelMessage)
        }
        .hdAlert($alert)
    }

    private var cancelMessage: String {
        guard let a = model.assignment, let job = a.job else { return "" }
        let hours = (a.termsSnapshot?["cancellationPolicy"].flatMap { v -> Int? in
            if case .object(let o) = v { return o["freeCancelHoursBefore"]?.intValue }
            return nil
        })
        if let hours {
            let deadline = job.startsAt.addingTimeInterval(TimeInterval(-hours * 3600))
            if Date() > deadline {
                return "無償で取消できる期限（開始\(hours)時間前）を過ぎています。直前の取消として記録されます。"
            }
            return "開始\(hours)時間前（\(HDFormat.dateTime(deadline))）までは無償で取消できます。"
        }
        return "受諾時のキャンセル条件が適用されます。"
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if let a = model.assignment {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    env.router.push(.chat(assignmentId: a.id, title: a.job?.organizationName ?? "メッセージ"))
                } label: {
                    Image(systemName: "bubble.left.and.bubble.right")
                }
                .accessibilityLabel("発注者とのメッセージ")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if a.state == .accepted || a.state == .reserved || a.state == .traveling {
                        Button(role: .destructive) { confirmCancel = true } label: {
                            Label("キャンセルする", systemImage: "xmark.circle")
                        }
                    }
                    Button { sheet = .reportOrg } label: {
                        Label("発注者を通報", systemImage: "exclamationmark.bubble")
                    }
                    Button {
                        env.router.push(.support, on: .myPage)
                    } label: {
                        Label("サポートに問い合わせ", systemImage: "questionmark.circle")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").accessibilityLabel("その他の操作")
                }
            }
        }
    }

    // MARK: 内容

    @ViewBuilder
    private func content(_ a: Assignment) -> some View {
        let progress = AssignmentProgress(assignment: a)
        ScrollView {
            VStack(alignment: .leading, spacing: HDSpacing.lg) {
                StatusBadge(presentation: a.state.presentation)
                Text(a.job?.title ?? "案件")
                    .font(.hd(.title2, .bold))
                    .foregroundStyle(HDColor.textPrimary)
                if let job = a.job {
                    Text("\(job.organizationName) ・ \(HDFormat.schedule(job.startsAt, job.endsAt))")
                        .font(.hd(.subheadline))
                        .foregroundStyle(HDColor.textSecondary)
                }
                if progress.totalSteps > 0 && (a.state == .working || a.state == .checked_in || a.state == .submitted || a.state == .needs_revision) {
                    VStack(alignment: .leading) {
                        Text(progress.label).font(.hd(.subheadline)).foregroundStyle(HDColor.textSecondary)
                        ProgressView(value: progress.fractionComplete).tint(HDColor.jobGreen)
                    }
                    .accessibilityElement(children: .combine)
                }

                if let notice = model.queuedNotice { NoticeBox(kind: .info, text: notice) }
                if let error = model.errorMessage { NoticeBox(kind: .danger, text: error) }
                if env.pendingCount(entityKey: "assignment:\(a.id)") > 0 {
                    Label("送信待ちの記録があります", systemImage: "arrow.triangle.2.circlepath")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.brandBlue)
                }

                if a.state.allowsLocationSharing {
                    LocationShareCard(assignmentId: a.id, state: a.state)
                }

                stateContent(a, progress: progress)
            }
            .padding(HDSpacing.lg)
        }
    }

    @ViewBuilder
    private func stateContent(_ a: Assignment, progress: AssignmentProgress) -> some View {
        switch a.state {
        case .reserved:
            NoticeBox(kind: .info, text: a.reservationExpiresAt.map { "発注者の承認待ちです（期限 \(HDFormat.dateTime($0))）。承認されると通知でお知らせします。" } ?? "発注者の承認待ちです。")
        case .accepted, .traveling:
            siteCard(a)
            if a.state == .accepted {
                primaryButton("移動を開始する", systemImage: "car.fill") {
                    Task {
                        env.location.requestWhenInUse()
                        _ = await model.send(AssignmentEventRequest(eventType: .traveling, occurredAt: Date()), env: env)
                        if let s = model.assignment?.state, s.allowsLocationSharing {
                            env.locationSharing.start(assignmentId: a.id, state: s)
                        }
                    }
                }
            } else {
                CheckInPanel(assignment: a) { point in
                    Task {
                        _ = await model.send(AssignmentEventRequest(eventType: .checked_in, location: point, occurredAt: Date()), env: env)
                    }
                }
                .environment(model)
            }
        case .checked_in:
            siteCard(a)
            primaryButton("業務を開始する", systemImage: "play.fill") {
                Task { _ = await model.send(AssignmentEventRequest(eventType: .working, occurredAt: Date()), env: env) }
            }
        case .working:
            stepsList(a)
            if case .submitReport = progress.nextAction {
                primaryButton("完了報告へ進む", systemImage: "doc.text.fill", color: HDColor.jobGreen) { sheet = .report }
            }
        case .needs_revision:
            NoticeBox(kind: .warning, text: "発注者から修正の依頼があります：\(a.reviewReason ?? "理由の記載はありません")")
            primaryButton("修正して再提出する", systemImage: "arrow.uturn.backward") { sheet = .report }
        case .submitted:
            CompletionSummaryCard(assignment: a)
            NoticeBox(kind: .info, text: "発注者の検収を待っています。検収後に報酬が確定し、振込予定日が決まります。")
        case .approved, .payable, .paid:
            CompletionSummaryCard(assignment: a)
            earningCard(a)
            if a.myRatingSubmitted != true {
                primaryButton("発注者を評価する", systemImage: "star.fill") { sheet = .rating }
            }
        case .disputed:
            NoticeBox(kind: .warning, text: "運営が内容を確認しています。確認結果は通知でお知らせします。")
        default:
            NoticeBox(kind: .info, text: "この案件は「\(a.state.presentation.label)」です。")
            if a.lateCancellation == true {
                NoticeBox(kind: .warning, text: "期限後のキャンセルとして記録されています。")
            }
        }
    }

    private func primaryButton(_ title: String, systemImage: String, color: Color = HDColor.brandBlue, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ProgressLabel(title: title, systemImage: systemImage, isLoading: model.isSending)
        }
        .buttonStyle(HDPrimaryButtonStyle(color: color))
        .disabled(model.isSending)
    }

    private func siteCard(_ a: Assignment) -> some View {
        HDCard {
            Text("集合場所").font(.hd(.headline, .bold))
            if let address = a.job?.address {
                Text(address).font(.hd(.body)).textSelection(.enabled)
            }
            if let note = a.job?.meetingPointNote {
                Text(note).font(.hd(.subheadline)).foregroundStyle(HDColor.textSecondary)
            }
            if let point = a.job?.location {
                SinglePointMap(point: point, title: a.job?.title ?? "集合場所")
                    .frame(height: 180)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                Button {
                    AppleMaps.navigate(to: point, name: a.job?.meetingPointNote ?? a.job?.title ?? "集合場所")
                } label: {
                    Label("Appleマップで案内", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                }
                .buttonStyle(.hdSecondary)
            }
            if let safety = a.job?.safetyNotes, !safety.isEmpty {
                NoticeBox(kind: .warning, text: safety)
            }
        }
    }

    private func stepsList(_ a: Assignment) -> some View {
        VStack(spacing: HDSpacing.sm) {
            ForEach((a.steps ?? []).sorted { $0.index < $1.index }) { step in
                StepCard(step: step, isNext: AssignmentProgress(assignment: a).nextAction == .completeStep(index: step.index), photos: Binding(
                    get: { model.stepPhotos[step.index] ?? [] },
                    set: { model.stepPhotos[step.index] = $0 }
                ), isSending: model.isSending) {
                    Task {
                        let photos = model.stepPhotos[step.index] ?? []
                        let ok = await model.send(AssignmentEventRequest(eventType: .step_completed, stepIndex: step.index, occurredAt: Date()), photos: photos, env: env)
                        if ok { model.stepPhotos[step.index] = nil }
                    }
                }
            }
        }
    }

    private func earningCard(_ a: Assignment) -> some View {
        HDCard {
            Text("報酬").font(.hd(.headline, .bold))
            if let amount = a.earning?.amountYen ?? a.acceptedAmountYen {
                Text(HDFormat.yen(amount)).font(.hd(.title2, .bold))
            }
            if let raw = a.earning?.state {
                let state = EarningState(rawValue: raw) ?? .unknown
                StatusBadge(presentation: state.presentation)
                Text(state.explanation).font(.hd(.footnote)).foregroundStyle(HDColor.textSecondary)
            }
            if let date = a.earning?.scheduledPayoutDate {
                InfoRow(title: "振込予定日", value: HDFormat.displayAPIDate(date))
            }
            Button("報酬・振込履歴を見る") { env.router.push(.earnings, on: .myPage) }
                .frame(minHeight: 44)
        }
    }
}

/// 手順カード（完了 / 未完了、写真が必要な手順は写真を添付）
struct StepCard: View {
    let step: AssignmentStep
    let isNext: Bool
    @Binding var photos: [PhotoAttachment]
    let isSending: Bool
    let onComplete: () -> Void

    var body: some View {
        HDCard {
            HStack(alignment: .top, spacing: HDSpacing.md) {
                ZStack {
                    Circle().fill(step.completed ? HDColor.jobGreen : HDColor.border)
                    if step.completed {
                        Image(systemName: "checkmark").foregroundStyle(.white).font(.headline)
                    } else {
                        Text("\(step.index + 1)").font(.hd(.subheadline, .bold)).foregroundStyle(HDColor.textSecondary)
                    }
                }
                .frame(width: 36, height: 36)
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(step.title).font(.hd(.headline, .bold)).foregroundStyle(HDColor.textPrimary)
                    Label(step.completed ? "完了" : "未完了", systemImage: step.completed ? "checkmark.circle.fill" : "circle")
                        .font(.hd(.footnote, .semibold))
                        .foregroundStyle(step.completed ? HDColor.jobGreen : HDColor.textSecondary)
                    if let d = step.description, !d.isEmpty, !step.completed {
                        Text(d).font(.hd(.subheadline)).foregroundStyle(HDColor.textSecondary)
                    }
                }
                Spacer()
            }
            if isNext && !step.completed {
                if step.requiresPhoto == true {
                    PhotoAttachmentPicker(attachments: $photos, maxCount: 4, title: "作業写真を追加", privacyNote: "依頼先の個人情報は撮影しないでください")
                }
                Button(action: onComplete) {
                    ProgressLabel(title: "この手順を完了にする", systemImage: "checkmark", isLoading: isSending)
                }
                .buttonStyle(.hdJob)
                .disabled(isSending || (step.requiresPhoto == true && photos.isEmpty))
                .accessibilityIdentifier("completeStepButton")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("手順\(step.index + 1) \(step.title) \(step.completed ? "完了" : "未完了")")
    }
}

/// 移動中：現地までの距離とチェックイン
struct CheckInPanel: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(WorkflowViewModel.self) private var model
    let assignment: Assignment
    let onCheckIn: (GeoPoint) -> Void

    var body: some View {
        HDCard {
            Text("現地でチェックイン").font(.hd(.headline, .bold))
            if env.location.isDenied {
                PermissionDeniedView(title: "位置情報がオフです", message: "チェックインには現在地が必要です。設定で位置情報を「このAppの使用中のみ許可」にしてください。")
            } else if let job = assignment.job {
                let evaluation = CheckInEvaluation.evaluate(current: env.location.currentPoint, accuracyMeters: env.location.lastLocation?.horizontalAccuracy, job: job, now: Date())
                Label(evaluation.message, systemImage: icon(evaluation))
                    .font(.hd(.subheadline))
                    .foregroundStyle(color(evaluation))
                Button {
                    if let p = env.location.currentPoint { onCheckIn(p) }
                } label: {
                    ProgressLabel(title: "チェックインする", systemImage: "mappin.circle.fill", isLoading: model.isSending)
                }
                .buttonStyle(.hdPrimary)
                .disabled(env.location.currentPoint == nil || model.isSending || isBlocked(evaluation))
                .accessibilityIdentifier("checkInButton")
            }
        }
        .onAppear {
            env.location.requestWhenInUse()
            env.location.begin("checkin")
        }
        .onDisappear { env.location.end("checkin") }
    }

    private func isBlocked(_ e: CheckInEvaluation) -> Bool {
        if case .tooEarly = e { return true }
        return false
    }

    private func icon(_ e: CheckInEvaluation) -> String {
        switch e {
        case .ok: return "checkmark.circle.fill"
        case .tooFar, .tooEarly: return "clock"
        default: return "location.slash"
        }
    }

    private func color(_ e: CheckInEvaluation) -> Color {
        switch e {
        case .ok: return HDColor.jobGreen
        case .tooFar, .tooEarly: return HDColor.warning
        default: return HDColor.textSecondary
        }
    }
}

/// 位置共有の状態と停止スイッチ
struct LocationShareCard: View {
    @Environment(AppEnvironment.self) private var env
    let assignmentId: String
    let state: AssignmentState

    var body: some View {
        HDCard {
            Toggle(isOn: Binding(
                get: { env.locationSharing.isSharing(assignmentId) },
                set: { on in
                    if on { env.locationSharing.start(assignmentId: assignmentId, state: state) } else { env.locationSharing.stop() }
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Label("発注者と位置を共有", systemImage: "location.fill").font(.hd(.headline, .semibold))
                    Text("業務中のみ、最新の1点だけが発注者に表示されます。報告の送信後は自動で停止します。")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.textSecondary)
                }
            }
            if let sent = env.locationSharing.lastSentAt, env.locationSharing.isSharing(assignmentId) {
                Text("最終送信 \(HDFormat.time(sent))").font(.hd(.caption)).foregroundStyle(HDColor.textSecondary)
            }
            if let error = env.locationSharing.lastError, env.locationSharing.isSharing(assignmentId) {
                Text(error).font(.hd(.caption)).foregroundStyle(HDColor.warning)
            }
        }
    }
}

/// 常に表示する安全・ヘルプの操作
struct SafetyBar: View {
    let onSafety: () -> Void
    let onHelp: () -> Void

    var body: some View {
        HStack(spacing: HDSpacing.sm) {
            Button(action: onSafety) {
                Label("危険を報告", systemImage: "exclamationmark.triangle.fill")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(HDColor.danger)
            Button(action: onHelp) {
                Label("ヘルプ", systemImage: "questionmark.circle.fill")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
        }
        .font(.hd(.subheadline, .bold))
        .padding(.horizontal, HDSpacing.lg)
        .padding(.vertical, HDSpacing.sm)
        .background(.regularMaterial)
    }
}

/// 危険報告・ヘルプ要請（運営に即時通知）
struct UrgentReportSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let kind: AssignmentEventType
    let model: WorkflowViewModel

    @State private var note = ""
    @State private var sent = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    NoticeBox(kind: .danger, text: "命に関わる緊急時は、ためらわず110番（警察）・119番（救急・消防）に通報してください。")
                    HStack {
                        Button("110番に発信") { SystemSettings.call("110") }
                            .buttonStyle(.hdDanger)
                        Button("119番に発信") { SystemSettings.call("119") }
                            .buttonStyle(.hdDanger)
                    }
                }
                Section(kind == .safety_alert ? "危険の内容" : "困っていること") {
                    TextField(kind == .safety_alert ? "例：依頼先で体調不良の方がいる" : "例：集合場所が見つからない", text: $note, axis: .vertical)
                        .lineLimit(3...6)
                }
                if sent {
                    Section { NoticeBox(kind: .success, text: model.queuedNotice ?? "運営に送信しました。運営から連絡します。") }
                }
                if let error = model.errorMessage {
                    Section { NoticeBox(kind: .danger, text: error) }
                }
                Section {
                    Button {
                        Task {
                            var location: GeoPoint?
                            if env.location.isAuthorized, let l = await env.location.currentLocation() {
                                location = GeoPoint(latitude: l.coordinate.latitude, longitude: l.coordinate.longitude)
                            }
                            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                            sent = await model.send(AssignmentEventRequest(eventType: kind, note: trimmed.isEmpty ? nil : trimmed, location: location, occurredAt: Date()), env: env)
                        }
                    } label: {
                        ProgressLabel(title: kind == .safety_alert ? "運営に危険を報告する" : "運営にヘルプを求める", isLoading: model.isSending)
                    }
                    .buttonStyle(kind == .safety_alert ? HDPrimaryButtonStyle(color: HDColor.danger) : HDPrimaryButtonStyle())
                    .disabled(model.isSending || sent)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }
            .navigationTitle(kind == .safety_alert ? "危険を報告" : "ヘルプ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
    }
}
