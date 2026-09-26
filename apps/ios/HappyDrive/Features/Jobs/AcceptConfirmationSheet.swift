import SwiftUI
import HappyDriveCore
import HappyAvatarKit

enum AcceptOutcome {
    case accepted(Assignment)
    case waitlistOffered
    case reload
}

/// 受諾前の最終確認。表示中の条件の termsHash を送り、条件が変わっていれば 409 terms_changed で止まる。
struct AcceptConfirmationSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let job: Job
    let onOutcome: (AcceptOutcome) -> Void

    @State private var confirmed = false
    @State private var isAccepting = false
    @State private var failure: AcceptFailureResolution?
    @State private var errorMessage: String?
    @State private var reserved: Assignment?
    /// 通信失敗時の再試行でも同じ受諾として扱われるよう、シートを開いている間は固定
    @State private var idempotencyKey = IdempotencyKey.generate()

    var body: some View {
        NavigationStack {
            Form {
                Section("受諾する内容") {
                    InfoRow(title: "案件", value: job.title)
                    InfoRow(title: "発注者", value: job.organizationName)
                    InfoRow(title: "日時", value: HDFormat.schedule(job.startsAt, job.endsAt))
                    InfoRow(title: "契約区分", value: job.contractType.label)
                    InfoRow(title: "報酬", value: HDFormat.yen(job.amountYen))
                    if let exp = job.expensesReimbursedYen, exp > 0 {
                        InfoRow(title: "実費の支給", value: HDFormat.yen(exp))
                    }
                    if let borne = job.workerBorneCostsNote, !borne.isEmpty {
                        InfoRow(title: "ご自身の負担", value: borne)
                    }
                    if let pay = job.paymentTermsText {
                        InfoRow(title: "支払条件", value: pay)
                    }
                }
                Section("キャンセル条件") {
                    Text(job.cancellationPolicy.text).font(.hd(.subheadline))
                    Text("開始\(job.cancellationPolicy.freeCancelHoursBefore)時間前を過ぎた取消は記録され、評価や今後の受諾に影響する場合があります。")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.textSecondary)
                }
                if job.requiresOrgApproval == true {
                    Section {
                        NoticeBox(kind: .info, text: "この案件は発注者の承認が必要です。受諾すると期限付きの仮予約になり、承認されると確定します。")
                    }
                }
                Section {
                    Toggle("仕事内容・報酬・キャンセル条件を確認しました", isOn: $confirmed)
                        .accessibilityIdentifier("confirmTermsToggle")
                }

                if let reserved {
                    Section {
                        NoticeBox(kind: .success, text: reservedText(reserved))
                        Button("業務画面へ") {
                            onOutcome(.accepted(reserved))
                            dismiss()
                        }
                        .buttonStyle(.hdPrimary)
                    }
                }

                if let failure {
                    failureSection(failure)
                }
                if let errorMessage {
                    Section {
                        NoticeBox(kind: .danger, text: errorMessage)
                    }
                }

                if reserved == nil {
                    Section {
                        Button {
                            Task { await accept() }
                        } label: {
                            ProgressLabel(title: errorMessage == nil ? "受諾する" : "もう一度送信する", isLoading: isAccepting)
                        }
                        .buttonStyle(.hdPrimary)
                        .disabled(!confirmed || isAccepting || failure != nil)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .accessibilityIdentifier("acceptJobButton")
                    }
                }
            }
            .navigationTitle("内容を確認して受諾")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
            .interactiveDismissDisabled(isAccepting)
        }
    }

    private func reservedText(_ a: Assignment) -> String {
        if let exp = a.reservationExpiresAt {
            return "仮予約しました。発注者の承認をお待ちください（承認期限 \(HDFormat.dateTime(exp))）。"
        }
        return "仮予約しました。発注者の承認をお待ちください。"
    }

    @ViewBuilder
    private func failureSection(_ f: AcceptFailureResolution) -> some View {
        Section {
            switch f {
            case .offerWaitlist(let message):
                NoticeBox(kind: .warning, text: message)
                Button("空き待ちに登録する") { Task { await joinWaitlist() } }
                    .buttonStyle(.hdPrimary)
            case .reloadTerms(let message):
                NoticeBox(kind: .warning, text: "\(message)\n最新の条件を読み込み直して、もう一度確認してください。")
                Button("最新の条件を読み込む") {
                    onOutcome(.reload)
                    dismiss()
                }
                .buttonStyle(.hdPrimary)
            case .notEligible(let message, let reasons):
                NoticeBox(kind: .warning, text: message)
                ForEach(reasons, id: \.self) { Text("・\($0)").font(.hd(.subheadline)) }
            case .alreadyAccepted(let message, let assignmentId):
                NoticeBox(kind: .info, text: message)
                if let assignmentId {
                    Button("業務画面へ") {
                        dismiss()
                        env.router.push(.assignment(assignmentId))
                    }
                    .buttonStyle(.hdPrimary)
                }
            case .onboardingIncomplete(let message):
                NoticeBox(kind: .warning, text: message)
                Button("登録を続ける") {
                    dismiss()
                    env.router.push(.verification, on: .myPage)
                }
                .buttonStyle(.hdSecondary)
            case .other(let message):
                NoticeBox(kind: .danger, text: message)
            }
        }
    }

    private func accept() async {
        isAccepting = true
        errorMessage = nil
        defer { isAccepting = false }
        do {
            let assignment = try await env.api.acceptJob(id: job.id, termsHash: job.termsHash, idempotencyKey: idempotencyKey)
            if assignment.state == .reserved {
                reserved = assignment
            } else {
                env.voice.handleHappyDriveEvent(.jobAccepted)
                onOutcome(.accepted(assignment))
                dismiss()
            }
        } catch let error as APIError where error.isRetryable {
            // 通信失敗・サーバー一時障害：同じキーで再送できる（二重受諾にならない）
            errorMessage = "\(error.userMessage)\n「もう一度送信する」を押すと、同じ受諾として再送します。"
        } catch let error as APIError {
            failure = AcceptFailureResolution(error: error)
        } catch {
            errorMessage = error.hdUserMessage
        }
    }

    private func joinWaitlist() async {
        do {
            try await env.api.setWaitlist(jobId: job.id, joined: true)
            onOutcome(.waitlistOffered)
            dismiss()
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

/// 通報（案件・メッセージ・発注者）
struct ReportSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let targetType: ReportTargetType
    let targetId: String
    let targetName: String

    @State private var reason: ReportReason = .unsafe
    @State private var detail = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var done = false
    @State private var key = IdempotencyKey.generate()

    var body: some View {
        NavigationStack {
            Form {
                Section("対象") { Text(targetName) }
                Section("理由") {
                    Picker("理由", selection: $reason) {
                        ForEach(ReportReason.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    TextField("詳しい状況（任意）", text: $detail, axis: .vertical)
                        .lineLimit(3...6)
                }
                if done {
                    Section { NoticeBox(kind: .success, text: "通報を受け付けました。運営が確認して対応します。") }
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
            }
            .navigationTitle("通報する")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(done ? "閉じる" : "キャンセル") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if !done {
                        Button("送信") { Task { await send() } }
                            .disabled(isSending)
                    }
                }
            }
        }
    }

    private func send() async {
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        let trimmed = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await env.api.report(ReportInput(targetType: targetType, targetId: targetId, reason: reason, detail: trimmed.isEmpty ? nil : String(trimmed.prefix(2000))), idempotencyKey: key)
            done = true
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

/// マッチング（おすすめ・除外判定）への異議申立て
struct MatchingAppealSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let jobId: String?

    @State private var body_ = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var done = false
    @State private var key = IdempotencyKey.generate()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("例：資格を持っているのに対象外と表示される", text: $body_, axis: .vertical)
                        .lineLimit(4...8)
                } header: {
                    Text("内容")
                } footer: {
                    Text("おすすめの表示や、条件を満たさないという判定について運営が確認し、回答します。回答は「ヘルプ・お問い合わせ」で確認できます。")
                }
                if done {
                    Section { NoticeBox(kind: .success, text: "異議申立てを受け付けました。") }
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
            }
            .navigationTitle("異議申立て")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(done ? "閉じる" : "キャンセル") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if !done {
                        Button("送信") { Task { await send() } }
                            .disabled(isSending || body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func send() async {
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            _ = try await env.api.createMatchingAppeal(MatchingAppealInput(jobId: jobId, body: String(body_.prefix(2000))), idempotencyKey: key)
            done = true
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

/// マイ案件（進行中・予定・履歴）
struct MyAssignmentsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var scope: AssignmentScope = .active
    @State private var state: LoadState<[Assignment]> = .idle

    var body: some View {
        VStack(spacing: 0) {
            Picker("表示", selection: $scope) {
                Text("進行中").tag(AssignmentScope.active)
                Text("予定").tag(AssignmentScope.upcoming)
                Text("履歴").tag(AssignmentScope.history)
            }
            .pickerStyle(.segmented)
            .padding(HDSpacing.lg)

            LoadStateContainer(state: state, retry: { Task { await load() } }) { list in
                if list.isEmpty {
                    EmptyStateView(title: "案件はありません", systemImage: "briefcase", message: scope == .history ? nil : "「案件を探す」から受諾できます。")
                } else {
                    ScrollView {
                        LazyVStack(spacing: HDSpacing.md) {
                            ForEach(list) { a in
                                NavigationLink(value: AppRoute.assignment(a.id)) {
                                    AssignmentRow(assignment: a)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, HDSpacing.lg)
                    }
                    .refreshable { await load() }
                }
            }
            Spacer(minLength: 0)
        }
        .hdScreenBackground()
        .navigationTitle("マイ案件")
        .task(id: scope) { await load() }
    }

    private func load() async {
        state = .loading
        do {
            state = .loaded(try await env.api.assignments(scope: scope))
        } catch {
            state = .failed(error.hdUserMessage)
        }
    }
}
