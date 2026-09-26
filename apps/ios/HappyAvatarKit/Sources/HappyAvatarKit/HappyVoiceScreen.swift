#if canImport(SwiftUI)
import SwiftUI

/// 操作ボタンなどに使う色（マスコット本体の色とは別。アプリのテーマに合わせて渡せる）
public struct HappyAvatarPalette: Sendable {
    public var accent: Color
    public var danger: Color

    public init(accent: Color, danger: Color) {
        self.accent = accent
        self.danger = danger
    }

    /// HappyDrive のデザイントークン（brandBlue / danger のライト値）
    public static let happyDrive = HappyAvatarPalette(
        accent: Color(red: 0.043, green: 0.435, blue: 0.941),
        danger: Color(red: 0.851, green: 0.227, blue: 0.227)
    )
}

/// 最小構成の全画面音声モード（アバター・状態・マイク・終了）。
/// HappyDrive アプリはより多機能な `VoiceConversationView` にアバターを組み込んで使う。
public struct HappyVoiceScreen: View {
    private let controller: HappyAvatarController
    private let onMuteToggle: () -> Void
    private let onEnd: () -> Void
    private let isMuted: Bool
    private let palette: HappyAvatarPalette

    public init(
        controller: HappyAvatarController,
        isMuted: Bool,
        palette: HappyAvatarPalette = .happyDrive,
        onMuteToggle: @escaping () -> Void,
        onEnd: @escaping () -> Void
    ) {
        self.controller = controller
        self.isMuted = isMuted
        self.palette = palette
        self.onMuteToggle = onMuteToggle
        self.onEnd = onEnd
    }

    public var body: some View {
        VStack(spacing: 20) {
            Spacer(minLength: 16)

            HappyAvatarView(controller: controller, mode: .full)
                .frame(maxWidth: 320, maxHeight: 320)

            Text(controller.state.statusText)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.updatesFrequently)

            Spacer(minLength: 12)

            HStack(spacing: 28) {
                Button(action: onMuteToggle) {
                    VStack(spacing: 8) {
                        Image(systemName: isMuted ? "mic.slash.fill" : "mic.fill")
                            .font(.system(size: 24, weight: .semibold))
                            .foregroundStyle(isMuted ? palette.danger : palette.accent)
                            .frame(width: 64, height: 64)
                            .background(.thinMaterial, in: Circle())
                        Text(isMuted ? "マイクをオン" : "マイクをオフ")
                            .font(.caption)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isMuted ? "マイクをオン" : "マイクをオフ")

                Button(role: .destructive, action: onEnd) {
                    VStack(spacing: 8) {
                        Image(systemName: "xmark")
                            .font(.system(size: 24, weight: .bold))
                            .foregroundStyle(palette.danger)
                            .frame(width: 64, height: 64)
                            .background(palette.danger.opacity(0.18), in: Circle())
                        Text("音声会話を終了")
                            .font(.caption)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("音声会話を終了")
            }

            Spacer(minLength: 24)
        }
        .padding()
    }
}
#endif
