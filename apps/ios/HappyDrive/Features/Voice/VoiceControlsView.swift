import SwiftUI
import HappyDriveCore

/// 音声会話の操作（マイク・スピーカー・文字入力の切り替え、テキスト送信、終了）
struct VoiceControlsView: View {
    let service: RealtimeVoiceService
    @Binding var draft: String
    var textFieldFocused: FocusState<Bool>.Binding

    private var connected: Bool { service.state.isConnected }
    private var micDenied: Bool { service.microphonePermission == .denied }

    var body: some View {
        VStack(spacing: HDSpacing.md) {
            if service.isTextMode && service.state.isActive {
                textInput
            }
            HStack(alignment: .top, spacing: HDSpacing.lg) {
                micButton
                speakerButton
                keyboardButton
            }
            .frame(maxWidth: .infinity)
            primaryAction
        }
        .padding(.horizontal, HDSpacing.lg)
        .padding(.top, HDSpacing.md)
        .padding(.bottom, HDSpacing.sm)
        .background(HDColor.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            Rectangle().fill(HDColor.border).frame(height: 1)
        }
    }

    // MARK: 切り替えボタン

    private var micButton: some View {
        let muted = service.isMicrophoneMuted || micDenied
        let title: String
        let hint: String
        if micDenied {
            title = "マイクを許可"
            hint = "設定アプリを開いてマイクを許可します"
        } else if service.isMicrophoneMuted {
            title = "マイクをオン"
            hint = "マイクをオンにして音声で話せるようにします"
        } else {
            title = "マイクをオフ"
            hint = "マイクをオフにします。AIには音が届かなくなります"
        }
        return VoiceToggleButton(
            title: title,
            systemImage: muted ? "mic.slash.fill" : "mic.fill",
            isOn: !muted,
            tint: muted ? HDColor.danger : HDColor.brandBlue,
            filledWhenOff: true
        ) {
            if micDenied {
                SystemSettings.open()
            } else {
                service.toggleMute()
            }
        }
        .disabled(!micDenied && service.isTextMode)
        .accessibilityIdentifier("voiceMuteButton")
        .accessibilityLabel("マイク")
        .accessibilityValue(micDenied ? "許可されていません" : (service.isMicrophoneMuted ? "オフ" : "オン"))
        .accessibilityHint(hint)
    }

    private var speakerButton: some View {
        let builtIn = service.audioRoute.isBuiltIn
        return VoiceToggleButton(
            title: builtIn ? (service.isSpeakerOn ? "スピーカー" : "受話口") : service.audioRoute.label,
            systemImage: builtIn ? (service.isSpeakerOn ? "speaker.wave.3.fill" : "iphone") : "headphones",
            isOn: service.isSpeakerOn,
            tint: HDColor.brandBlue,
            filledWhenOff: false
        ) {
            service.toggleSpeaker()
        }
        .accessibilityIdentifier("voiceSpeakerButton")
        .accessibilityLabel("音声の出力先")
        .accessibilityValue(builtIn ? (service.isSpeakerOn ? "スピーカー" : "受話口") : service.audioRoute.label)
        .accessibilityHint("スピーカーと受話口を切り替えます")
    }

    private var keyboardButton: some View {
        VoiceToggleButton(
            title: service.isTextMode ? "音声で話す" : "文字で入力",
            systemImage: service.isTextMode ? "waveform" : "keyboard",
            isOn: service.isTextMode,
            tint: HDColor.brandBlue,
            filledWhenOff: false
        ) {
            let next = !service.isTextMode
            service.setTextMode(next)
            textFieldFocused.wrappedValue = next
        }
        .disabled(micDenied && service.isTextMode)
        .accessibilityIdentifier("voiceKeyboardButton")
        .accessibilityLabel(service.isTextMode ? "音声で話す" : "文字で入力")
        .accessibilityHint(service.isTextMode ? "音声での会話に切り替えます" : "キーボードで文字を入力して送ります。回答も文字で表示されます")
    }

    // MARK: 文字入力

    private var textInput: some View {
        HStack(spacing: HDSpacing.sm) {
            TextField("メッセージを入力", text: $draft, axis: .vertical)
                .font(.hd(.body))
                .lineLimit(1...4)
                .focused(textFieldFocused)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, HDSpacing.md)
                .padding(.vertical, HDSpacing.sm + 2)
                .frame(minHeight: 44)
                .background(HDColor.background, in: RoundedRectangle(cornerRadius: HDRadius.button, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: HDRadius.button, style: .continuous).stroke(HDColor.border, lineWidth: 1))
                .accessibilityIdentifier("voiceTextField")
                .accessibilityLabel("AIアシスタントへのメッセージ")
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(canSend ? HDColor.brandBlue : HDColor.textSecondary.opacity(0.5))
                    .frame(width: 44, height: 44)
            }
            .disabled(!canSend)
            .accessibilityIdentifier("voiceSendButton")
            .accessibilityLabel("送信")
        }
    }

    private var canSend: Bool {
        connected && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend else { return }
        if service.sendText(draft) {
            draft = ""
        }
    }

    // MARK: 主ボタン（終了 / 再開）

    @ViewBuilder
    private var primaryAction: some View {
        if service.state.isActive {
            Button(role: .destructive) {
                textFieldFocused.wrappedValue = false
                service.end(reason: .user_ended)
            } label: {
                Label("音声会話を終了", systemImage: "phone.down.fill")
            }
            .buttonStyle(.hdDanger)
            .accessibilityIdentifier("voiceEndButton")
        } else if let error = service.state.error {
            if error.isRetryable {
                Button {
                    service.start()
                } label: {
                    Label("もう一度試す", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.hdPrimary)
                .accessibilityIdentifier("voiceRetryButton")
            }
        } else {
            Button {
                service.start()
            } label: {
                Label("もう一度話す", systemImage: "mic.fill")
            }
            .buttonStyle(.hdPrimary)
            .accessibilityIdentifier("voiceRestartButton")
        }
    }
}

/// アイコン＋文字の丸い切り替えボタン（44pt 以上）
struct VoiceToggleButton: View {
    let title: String
    let systemImage: String
    let isOn: Bool
    let tint: Color
    /// オフ（ミュート等）のときに塗りつぶして強調する
    let filledWhenOff: Bool
    let action: () -> Void

    @Environment(\.isEnabled) private var isEnabled

    private var filled: Bool { filledWhenOff ? !isOn : isOn }

    var body: some View {
        Button(action: action) {
            VStack(spacing: HDSpacing.xs) {
                Image(systemName: systemImage)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(filled ? HDColor.onBrand : tint)
                    .frame(width: 60, height: 60)
                    .background(filled ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.12)), in: Circle())
                    .accessibilityHidden(true)
                Text(title)
                    .font(.hd(.caption, .semibold))
                    .foregroundStyle(filledWhenOff && !isOn ? tint : HDColor.textPrimary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }
            .frame(minWidth: 72, minHeight: 44)
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
