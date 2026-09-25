import SwiftUI
import HappyDriveCore

/// 完了報告（実施時間・報告内容・写真）→ 送信後に「お疲れさまでした」
struct SubmitReportView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let model: WorkflowViewModel

    @State private var note = ""
    @State private var photos: [PhotoAttachment] = []
    @State private var submitted = false
    @State private var localError: String?

    private var assignment: Assignment? { model.assignment }

    private var alreadyUploaded: Int {
        (assignment?.evidence ?? []).filter { $0.purpose == EvidencePurpose.work_photo.rawValue && $0.status != .rejected }.count
    }

    private var missingPhotos: Int {
        ReportRequirements.missingPhotoCount(minPhotoCount: assignment?.job?.minPhotoCount, attached: photos.count, alreadyUploaded: alreadyUploaded)
    }

    var body: some View {
        NavigationStack {
            if submitted, let a = model.assignment {
                CompletionView(assignment: a) { dismiss() }
            } else {
                form
            }
        }
        .interactiveDismissDisabled(model.isSending)
    }

    private var form: some View {
        Form {
            if let a = assignment {
                Section("実施時間") {
                    Text(workTimeText(a)).font(.hd(.body, .semibold))
                }
                if a.state == .needs_revision, let reason = a.reviewReason {
                    Section { NoticeBox(kind: .warning, text: "修正の依頼：\(reason)") }
                }
            }
            Section("報告内容") {
                TextField("実施した内容・引き継ぎ事項", text: $note, axis: .vertical)
                    .lineLimit(4...10)
                    .accessibilityIdentifier("reportNoteField")
            }
            Section {
                PhotoAttachmentPicker(attachments: $photos, maxCount: 8, title: "写真を追加", privacyNote: "依頼先の個人情報は撮影しないでください")
            } header: {
                Text("写真")
            } footer: {
                if let min = assignment?.job?.minPhotoCount, min > 0 {
                    Text(missingPhotos > 0 ? "報告には写真が\(min)枚以上必要です（あと\(missingPhotos)枚）。" : "必要な写真枚数を満たしています。")
                }
            }
            if let error = localError ?? model.errorMessage {
                Section { NoticeBox(kind: .danger, text: error) }
            }
            Section {
                Button {
                    Task { await submit() }
                } label: {
                    ProgressLabel(title: assignment?.state == .needs_revision ? "修正した報告を送信" : "完了報告を送信", isLoading: model.isSending)
                }
                .buttonStyle(.hdJob)
                .disabled(model.isSending || missingPhotos > 0)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .accessibilityIdentifier("submitReportButton")
            }
        }
        .navigationTitle("完了報告")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("閉じる") { dismiss() }
            }
        }
    }

    private func workTimeText(_ a: Assignment) -> String {
        guard let start = a.workStartedAt ?? a.checkedInAt else { return "開始時刻の記録がありません" }
        let end = a.submittedAt ?? Date()
        let minutes = max(0, Int(end.timeIntervalSince(start) / 60))
        return "\(HDFormat.timeRange(start, end))（\(HDFormat.duration(minutes: minutes))）"
    }

    private func submit() async {
        localError = nil
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !photos.isEmpty else {
            localError = "報告内容を入力するか、写真を添付してください"
            return
        }
        let ok = await model.send(
            AssignmentEventRequest(eventType: .submitted, note: trimmed.isEmpty ? nil : String(trimmed.prefix(2000)), occurredAt: Date()),
            photos: photos,
            env: env
        )
        if ok {
            // 報告後は位置共有を停止
            env.locationSharing.stop()
            submitted = true
        }
    }
}

/// 完了画面（お疲れさまでした）
struct CompletionView: View {
    @Environment(AppEnvironment.self) private var env
    let assignment: Assignment
    let onClose: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: HDSpacing.xl) {
                ZStack {
                    Circle().fill(HDColor.jobGreenSoft).frame(width: 120, height: 120)
                    Image(systemName: "checkmark")
                        .font(.system(size: 56, weight: .bold))
                        .foregroundStyle(HDColor.jobGreen)
                }
                .accessibilityHidden(true)
                Text("お疲れさまでした")
                    .font(.hd(.title, .bold))
                Text("完了報告を受け付けました。発注者の検収後に報酬が確定し、振込予定日に振り込まれます。")
                    .font(.hd(.body))
                    .foregroundStyle(HDColor.textSecondary)
                    .multilineTextAlignment(.center)
                CompletionSummaryCard(assignment: assignment)
                Button("報酬を見る") {
                    onClose()
                    env.router.push(.earnings, on: .myPage)
                }
                .buttonStyle(.hdSecondary)
                Button("ホームへ戻る") {
                    onClose()
                    env.router.popToRoot(.jobs)
                    env.router.tab = .home
                }
                .buttonStyle(.hdPrimary)
                .accessibilityIdentifier("backHomeButton")
            }
            .padding(HDSpacing.xl)
        }
        .navigationTitle("完了報告")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct CompletionSummaryCard: View {
    let assignment: Assignment

    var body: some View {
        HDCard {
            Text("実施内容").font(.hd(.headline, .bold))
            if let start = assignment.workStartedAt ?? assignment.checkedInAt {
                let end = assignment.submittedAt ?? assignment.completedAt ?? Date()
                InfoRow(title: "実施時間", value: "\(HDFormat.timeRange(start, end))（\(HDFormat.duration(minutes: max(0, Int(end.timeIntervalSince(start) / 60)))))")
            }
            if let steps = assignment.steps, !steps.isEmpty {
                InfoRow(title: "手順", value: "\(steps.filter(\.completed).count) / \(steps.count) 完了")
            }
            if let count = assignment.evidence?.count, count > 0 {
                InfoRow(title: "証跡", value: "\(count)件")
            }
            if let note = assignment.reportNote, !note.isEmpty {
                Text(note).font(.hd(.subheadline)).foregroundStyle(HDColor.textSecondary)
            }
            if let amount = assignment.acceptedAmountYen {
                InfoRow(title: "受諾時の報酬", value: HDFormat.yen(amount))
            }
        }
    }
}

/// 検収後の発注者評価（1回のみ）
struct RatingView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let assignment: Assignment
    let onDone: () -> Void

    @State private var score = 0
    @State private var comment = ""
    @State private var isSending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("\(assignment.job?.organizationName ?? "発注者")の評価") {
                    HStack(spacing: HDSpacing.sm) {
                        ForEach(1...5, id: \.self) { i in
                            Button {
                                score = i
                            } label: {
                                Image(systemName: i <= score ? "star.fill" : "star")
                                    .font(.title)
                                    .foregroundStyle(i <= score ? HDColor.warning : HDColor.textSecondary)
                                    .frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(i)つ星")
                            .accessibilityAddTraits(i == score ? .isSelected : [])
                        }
                    }
                    TextField("コメント（任意）", text: $comment, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section {
                    Text("評価は一度だけ送信できます。不当な扱いや危険があった場合は、評価ではなく通報・サポートをご利用ください。")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.textSecondary)
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
            }
            .navigationTitle("評価")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("送信") { Task { await send() } }
                        .disabled(score == 0 || isSending)
                }
            }
        }
    }

    private func send() async {
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
            try await env.api.rateAssignment(id: assignment.id, score: score, comment: trimmed.isEmpty ? nil : String(trimmed.prefix(500)))
            onDone()
            dismiss()
        } catch let error as APIError where error.status == 409 {
            errorMessage = "この案件はすでに評価済みです。"
            onDone()
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}
