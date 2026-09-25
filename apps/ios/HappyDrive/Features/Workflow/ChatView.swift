import SwiftUI
import HappyDriveCore

/// 案件ごとのメッセージ（電話番号は原則非公開。不適切なメッセージは通報できる）
struct ChatView: View {
    @Environment(AppEnvironment.self) private var env
    let assignmentId: String
    let title: String

    @State private var messages: [Message] = []
    @State private var loadError: String?
    @State private var loaded = false
    @State private var draft = ""
    @State private var photos: [PhotoAttachment] = []
    @State private var showPhotoPicker = false
    @State private var isSending = false
    @State private var sendError: String?
    @State private var reportTarget: Message?
    @State private var sendKey = IdempotencyKey.generate()

    var body: some View {
        VStack(spacing: 0) {
            if let loadError, messages.isEmpty {
                ErrorStateView(message: loadError) { Task { await refresh() } }
            } else if !loaded {
                LoadingStateView()
            } else if messages.isEmpty {
                EmptyStateView(title: "メッセージはまだありません", systemImage: "bubble.left.and.bubble.right", message: "業務の連絡に使ってください。電話番号などの個人情報は送らないでください。")
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: HDSpacing.sm) {
                            ForEach(messages) { m in
                                MessageBubble(message: m)
                                    .id(m.id)
                                    .contextMenu {
                                        if m.isMine != true {
                                            Button {
                                                reportTarget = m
                                            } label: {
                                                Label("このメッセージを通報", systemImage: "exclamationmark.bubble")
                                            }
                                        }
                                    }
                            }
                        }
                        .padding(HDSpacing.lg)
                    }
                    .onChange(of: messages.count) { _, _ in
                        if let last = messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                    }
                    .onAppear {
                        if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
            composer
        }
        .hdScreenBackground()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // 表示中は定期的に新着を確認
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
        .sheet(item: $reportTarget) { m in
            ReportSheet(targetType: .message, targetId: m.id, targetName: String(m.body.prefix(40)))
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: HDSpacing.xs) {
            if let sendError {
                Text(sendError).font(.hd(.footnote)).foregroundStyle(HDColor.danger)
            }
            if showPhotoPicker || !photos.isEmpty {
                PhotoAttachmentPicker(attachments: $photos, maxCount: 1, title: "写真を添付", privacyNote: "個人情報が写らないようにしてください")
            }
            HStack(alignment: .bottom, spacing: HDSpacing.sm) {
                Button {
                    showPhotoPicker.toggle()
                } label: {
                    Image(systemName: "paperclip").font(.title3).frame(width: 44, height: 44)
                }
                .accessibilityLabel("写真を添付")
                TextField("メッセージを入力", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .padding(.horizontal, HDSpacing.md)
                    .padding(.vertical, HDSpacing.sm)
                    .background(HDColor.surface, in: RoundedRectangle(cornerRadius: 20))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(HDColor.border))
                    .onChange(of: draft) { _, _ in sendKey = IdempotencyKey.generate() }
                Button {
                    Task { await send() }
                } label: {
                    if isSending {
                        ProgressView().frame(width: 44, height: 44)
                    } else {
                        Image(systemName: "paperplane.fill").font(.title3).frame(width: 44, height: 44)
                    }
                }
                .disabled(isSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("送信")
            }
        }
        .padding(HDSpacing.sm)
        .background(.regularMaterial)
    }

    private func refresh() async {
        do {
            let latest = try await env.api.messages(assignmentId: assignmentId)
            messages = latest.sorted { $0.createdAt < $1.createdAt }
            loadError = nil
        } catch {
            loadError = error.hdUserMessage
        }
        loaded = true
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        isSending = true
        sendError = nil
        defer { isSending = false }
        do {
            var evidenceId: String?
            if let photo = photos.first {
                evidenceId = try await env.api.uploadEvidence(data: photo.data, contentType: photo.contentType, purpose: .message_attachment, assignmentId: assignmentId).id
            }
            let m = try await env.api.sendMessage(assignmentId: assignmentId, body: String(text.prefix(2000)), evidenceId: evidenceId, idempotencyKey: sendKey)
            messages.append(m)
            draft = ""
            photos = []
            showPhotoPicker = false
            sendKey = IdempotencyKey.generate()
        } catch {
            sendError = error.hdUserMessage
        }
    }
}

struct MessageBubble: View {
    let message: Message

    private var mine: Bool { message.isMine == true }

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 40) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
                if !mine {
                    Text(senderLabel).font(.hd(.caption, .semibold)).foregroundStyle(HDColor.textSecondary)
                }
                if message.hidden == true {
                    Label("運営により非表示になったメッセージです", systemImage: "eye.slash")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.textSecondary)
                } else {
                    Text(message.body)
                        .font(.hd(.body))
                        .foregroundStyle(mine ? HDColor.onBrand : HDColor.textPrimary)
                        .padding(HDSpacing.md)
                        .background(mine ? HDColor.brandBlue : HDColor.surface, in: RoundedRectangle(cornerRadius: 16))
                        .textSelection(.enabled)
                    if message.evidenceId != nil {
                        Label("写真が添付されています", systemImage: "photo").font(.hd(.caption)).foregroundStyle(HDColor.textSecondary)
                    }
                }
                Text(HDFormat.relativeDayTime(message.createdAt)).font(.hd(.caption2)).foregroundStyle(HDColor.textSecondary)
            }
            if !mine { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .combine)
    }

    private var senderLabel: String {
        switch message.senderRole {
        case .organization: return message.senderName ?? "発注者"
        case .operator_: return "運営"
        case .system: return "お知らせ"
        default: return message.senderName ?? ""
        }
    }
}

/// メッセージ一覧（案件ごと）
struct MessagesListView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var state: LoadState<[Assignment]> = .idle

    var body: some View {
        LoadStateContainer(state: state, retry: { Task { await load() } }) { list in
            if list.isEmpty {
                EmptyStateView(title: "メッセージはありません", systemImage: "bubble.left.and.bubble.right", message: "案件を受諾すると、発注者とメッセージでやり取りできます。")
            } else {
                List(list) { a in
                    NavigationLink(value: AppRoute.chat(assignmentId: a.id, title: a.job?.organizationName ?? "メッセージ")) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(a.job?.title ?? "案件").font(.hd(.headline, .bold))
                            Text(a.job?.organizationName ?? "").font(.hd(.subheadline)).foregroundStyle(HDColor.textSecondary)
                            StatusBadge(presentation: a.state.presentation, compact: true)
                        }
                        .padding(.vertical, 4)
                    }
                }
                .refreshable { await load() }
            }
        }
        .navigationTitle("メッセージ")
        .task { await load() }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            let all = try await env.api.assignments(scope: .all)
            state = .loaded(all.sorted { ($0.job?.startsAt ?? .distantPast) > ($1.job?.startsAt ?? .distantPast) })
        } catch {
            state = .failed(error.hdUserMessage)
        }
    }
}
