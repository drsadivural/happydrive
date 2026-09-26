import SwiftUI
import HappyDriveCore
import HappyAvatarKit

/// HappyDrive AIアシスタント（音声が主、文字入力も同じ会話で使える）
/// - 音声モード：アバター（HappyAvatarKit）＋小さなスペクトラム＋状態。話した内容の文字は出さない
/// - 運転中：状態の文字だけ・大きなマイク/終了ボタン・候補や文字入力の切り替えは出さない
/// - 「最小化」で会話を続けたまま閉じ、地図などの上にミニアバターを出す（✕ は会話を終了して閉じる）
struct VoiceConversationView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var textFieldFocused: Bool
    /// 会話が終わった後など、会話ごとのアバターが無いときに表示する待機中のアバター
    @State private var restingAvatar = HappyAvatarController()

    private var service: RealtimeVoiceService { env.voice }
    private var isDriving: Bool { env.location.isDriving }

    private static let suggestions = ["今日の予定を教えて", "近くの案件を探して", "今月の報酬はいくら？", "未読のお知らせはある？"]

    var body: some View {
        VStack(spacing: 0) {
            header
            content
            VoiceControlsView(service: service, draft: $draft, textFieldFocused: $textFieldFocused, isDriving: isDriving)
        }
        .hdScreenBackground()
        // 画面が閉じても会話は終了しない（最小化してミニアバターで続ける）。
        // 終了するのは ✕・「音声会話を終了」・バックグラウンド移行・無操作・最大時間のとき（RealtimeVoiceService 側で処理）
        .task {
            // 開くたびに接続（会話記録は残っているので文脈を引き継ぐ）。
            // 最小化から戻ったとき・エラー表示を閉じていないときは接続し直さない
            if !service.hasOngoingSession { service.start() }
        }
        .onChange(of: isDriving, initial: true) { _, driving in
            // 運転中は文字入力をやめて音声に戻す（マイクが使えない場合は文字のまま）
            if driving && service.isTextMode && service.microphonePermission == .granted {
                textFieldFocused = false
                service.setTextMode(false)
            }
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
                if service.hasOngoingSession {
                    Button {
                        textFieldFocused = false
                        dismiss()
                    } label: {
                        Label("最小化", systemImage: "chevron.down")
                            .labelStyle(.iconOnly)
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(HDColor.textPrimary)
                            .frame(width: 44, height: 44)
                            .background(HDColor.border.opacity(0.6), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("voiceMinimizeButton")
                    .accessibilityLabel("最小化")
                    .accessibilityHint("会話を続けたまま画面を閉じ、小さなアバターを表示します")
                }
                Button {
                    textFieldFocused = false
                    service.close()
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

    /// 音声モードでは文字起こしを表示せず、スペクトラムと状態だけを見せる。
    /// 文字入力モードに切り替えたときだけ、会話を文字で表示する。
    @ViewBuilder
    private var content: some View {
        let items = service.transcript.displayItems
        VStack(spacing: 0) {
            notices
            if service.isTextMode {
                if items.isEmpty { emptyState } else { VoiceTranscriptView(items: items) }
            } else {
                voiceStage(hasConversation: !items.isEmpty)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func voiceStage(hasConversation: Bool) -> some View {
        GeometryReader { geo in
            let size = Self.avatarSize(for: geo.size, driving: isDriving)
            ScrollView {
                VStack(spacing: isDriving ? HDSpacing.xl : HDSpacing.lg) {
                    Spacer(minLength: 0)
                    avatarStage(size: size)
                    VoiceSpectrumView(state: service.state, inputLevel: service.inputLevel, outputLevel: service.outputLevel, height: 56)
                        .padding(.horizontal, HDSpacing.lg)
                        .accessibilityIdentifier("voiceSpectrum")
                    Label(service.statusText, systemImage: service.state.symbol)
                        .font(.hd(isDriving ? .title2 : .title3, .bold))
                        .foregroundStyle(VoiceStateStyle.color(for: service.state))
                        .multilineTextAlignment(.center)
                        .accessibilityHidden(true) // 見出しの状態ラベルで読み上げ済み
                    if !isDriving {
                        if !hasConversation {
                            Text("今日の配送や案件、報酬について話しかけてください")
                                .font(.hd(.body))
                                .foregroundStyle(HDColor.textSecondary)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                            if service.state.isConnected {
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
                    Spacer(minLength: 0)
                }
                .padding(HDSpacing.lg)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
        }
    }

    /// アバターの大きさ：画面の空きに合わせて 220〜260pt 前後（小さい画面では縮め、運転中は少し大きく）
    static func avatarSize(for available: CGSize, driving: Bool) -> CGFloat {
        let byWidth = available.width - HDSpacing.xl * 2
        let byHeight = available.height * (driving ? 0.55 : 0.45)
        let upper: CGFloat = driving ? 280 : 260
        return max(120, min(upper, byWidth, byHeight))
    }

    /// アバター（状態の色の淡い円の上に表示）
    private func avatarStage(size: CGFloat) -> some View {
        let color = VoiceStateStyle.color(for: service.state)
        return HappyAvatarView(controller: service.avatar ?? restingAvatar, mode: isDriving ? .driving : .full)
            .padding(size * 0.08)
            .frame(width: size, height: size)
            .background(Circle().fill(color.opacity(0.10)))
            .overlay(Circle().stroke(color.opacity(0.35), lineWidth: 2))
            .accessibilityIdentifier("voiceAvatar")
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
