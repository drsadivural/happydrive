import SwiftUI
import HappyDriveCore

/// HappyDrive AIアシスタント（音声が主、文字入力も同じ会話で使える）
struct VoiceConversationView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var textFieldFocused: Bool

    private var service: RealtimeVoiceService { env.voice }

    private static let suggestions = ["今日の予定を教えて", "近くの案件を探して", "今月の報酬はいくら？", "未読のお知らせはある？"]

    var body: some View {
        VStack(spacing: 0) {
            header
            content
            VoiceControlsView(service: service, draft: $draft, textFieldFocused: $textFieldFocused)
        }
        .hdScreenBackground()
        .onDisappear {
            // 画面が閉じられたらマイクを止める（会話記録はメモリに残る）
            if service.state.isActive { service.end(reason: .user_ended) }
        }
        .task {
            // 開くたびに接続（会話記録は残っているので文脈を引き継ぐ）
            if !service.state.isActive { service.start() }
        }
    }

    // MARK: 見出し

    private var header: some View {
        VStack(spacing: HDSpacing.sm) {
            HStack(alignment: .center, spacing: HDSpacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("HappyDrive AIアシスタント")
                        .font(.hd(.headline, .bold))
                        .foregroundStyle(HDColor.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Label(service.statusText, systemImage: service.state.symbol)
                        .font(.hd(.subheadline, .medium))
                        .foregroundStyle(statusColor)
                        .accessibilityIdentifier("voiceStatusLabel")
                        .accessibilityLabel("状態: \(service.statusText)")
                }
                Spacer(minLength: HDSpacing.sm)
                Button {
                    textFieldFocused = false
                    service.end(reason: .user_ended)
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(HDColor.textPrimary)
                        .frame(width: 44, height: 44)
                        .background(HDColor.border.opacity(0.6), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("voiceCloseButton")
                .accessibilityLabel("閉じる")
                .accessibilityHint("音声会話を終了して画面を閉じます")
            }
            micIndicator
        }
        .padding(.horizontal, HDSpacing.lg)
        .padding(.vertical, HDSpacing.sm)
        .background(HDColor.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(HDColor.border).frame(height: 1)
        }
    }

    /// マイクを使っている間は常に表示する（色だけでなく文字とアイコンで）
    @ViewBuilder
    private var micIndicator: some View {
        if service.isMicrophoneCapturing {
            indicatorPill(text: "マイク使用中", systemImage: "mic.fill", color: HDColor.danger, dot: true)
                .accessibilityIdentifier("voiceMicActiveIndicator")
        } else if service.state.isConnected && service.isMicrophoneMuted && !service.isTextMode {
            indicatorPill(text: "マイクはオフです", systemImage: "mic.slash.fill", color: HDColor.danger, dot: false)
        } else if service.state.isConnected && service.isTextMode {
            indicatorPill(text: "文字で会話中（マイクはオフ）", systemImage: "keyboard", color: HDColor.textSecondary, dot: false)
        }
    }

    private func indicatorPill(text: String, systemImage: String, color: Color, dot: Bool) -> some View {
        HStack(spacing: HDSpacing.xs) {
            if dot {
                Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
            }
            Label(text, systemImage: systemImage)
                .font(.hd(.caption, .semibold))
        }
        .foregroundStyle(color)
        .padding(.horizontal, HDSpacing.md)
        .padding(.vertical, HDSpacing.xs)
        .background(color.opacity(0.12), in: Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var statusColor: Color {
        switch service.state {
        case .error: return HDColor.danger
        case .reconnecting, .connecting, .requestingPermission: return HDColor.warning
        case .idle, .disconnected: return HDColor.textSecondary
        default: return HDColor.brandBlue
        }
    }

    // MARK: 本文

    @ViewBuilder
    private var content: some View {
        let items = service.transcript.displayItems
        VStack(spacing: 0) {
            notices
            if items.isEmpty {
                emptyState
            } else {
                HStack {
                    Spacer()
                    VoiceOrbView(state: service.state, size: 72)
                    Spacer()
                }
                .padding(.top, HDSpacing.sm)
                VoiceTranscriptView(items: items)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var notices: some View {
        VStack(spacing: HDSpacing.sm) {
            if let error = service.state.error {
                VStack(alignment: .leading, spacing: HDSpacing.xs) {
                    Label(error.title, systemImage: "exclamationmark.triangle.fill")
                        .font(.hd(.headline, .bold))
                        .foregroundStyle(HDColor.danger)
                    Text(error.userMessage)
                        .font(.hd(.subheadline))
                        .foregroundStyle(HDColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(HDSpacing.md)
                .background(HDColor.danger.opacity(0.10), in: RoundedRectangle(cornerRadius: HDRadius.button, style: .continuous))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("voiceErrorNotice")
            }
            if service.microphonePermission == .denied {
                VStack(alignment: .leading, spacing: HDSpacing.sm) {
                    NoticeBox(kind: .warning, text: VoiceError.microphoneDenied.userMessage)
                    Button("設定を開く") { SystemSettings.open() }
                        .buttonStyle(.hdSecondary)
                        .accessibilityIdentifier("voiceOpenSettingsButton")
                }
            }
            if let notice = service.notice, service.state.error == nil {
                NoticeBox(kind: .info, text: notice)
            }
        }
        .padding(.horizontal, HDSpacing.lg)
        .padding(.top, HDSpacing.sm)
    }

    private var emptyState: some View {
        ScrollView {
            VStack(spacing: HDSpacing.lg) {
                VoiceOrbView(state: service.state, size: 168)
                    .padding(.top, HDSpacing.xl)
                Text(service.isTextMode ? "知りたいことを入力してください" : "今日の配送や案件、報酬について話しかけてください")
                    .font(.hd(.title3, .bold))
                    .foregroundStyle(HDColor.textPrimary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if service.state.isConnected {
                    VStack(spacing: HDSpacing.sm) {
                        Text("たとえば")
                            .font(.hd(.subheadline))
                            .foregroundStyle(HDColor.textSecondary)
                        FlowSuggestions(suggestions: Self.suggestions) { text in
                            service.sendText(text)
                        }
                    }
                }
                Label("運転中は画面を見ずに、音声でご利用ください。", systemImage: "car.fill")
                    .font(.hd(.footnote))
                    .foregroundStyle(HDColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(HDSpacing.lg)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

/// 話しかけ方の例（押すと文字で送る）
private struct FlowSuggestions: View {
    let suggestions: [String]
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: HDSpacing.sm) {
            ForEach(suggestions, id: \.self) { text in
                Button {
                    onSelect(text)
                } label: {
                    Text("「\(text)」")
                        .font(.hd(.subheadline, .semibold))
                        .foregroundStyle(HDColor.brandBlue)
                        .padding(.horizontal, HDSpacing.lg)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(HDColor.brandBlueSoft, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityHint("この内容を送信します")
            }
        }
    }
}
