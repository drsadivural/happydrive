import SwiftUI
import HappyDriveCore

/// 会話の状態を表す控えめなアニメーション（状態は必ず文字とアイコンでも表示する）。
/// 「視差効果を減らす」がオンなら動かさない。
struct VoiceOrbView: View {
    let state: VoiceConversationState
    var size: CGFloat = 160

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var color: Color {
        switch state {
        case .listening, .assistantSpeaking: return HDColor.brandBlue
        case .userSpeaking: return HDColor.jobGreen
        case .thinking: return HDColor.corporatePurple
        case .connecting, .requestingPermission, .reconnecting: return HDColor.warning
        case .error: return HDColor.danger
        case .idle, .disconnected: return HDColor.textSecondary
        }
    }

    /// 揺れの大きさと速さ（状態ごと）
    private var motion: (amplitude: Double, speed: Double) {
        switch state {
        case .userSpeaking: return (1.0, 7)
        case .assistantSpeaking: return (0.8, 5)
        case .thinking: return (0.5, 3)
        case .listening: return (0.35, 1.6)
        case .connecting, .requestingPermission, .reconnecting: return (0.4, 2.4)
        default: return (0, 0)
        }
    }

    private var isAnimating: Bool {
        !reduceMotion && motion.amplitude > 0
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !isAnimating)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let pulse = isAnimating ? (sin(t * motion.speed) + 1) / 2 : 0
            let amplitude = motion.amplitude
            ZStack {
                Circle()
                    .fill(color.opacity(0.10))
                    .scaleEffect(1 + 0.16 * pulse * amplitude)
                Circle()
                    .fill(color.opacity(0.20))
                    .padding(size * 0.11)
                    .scaleEffect(1 + 0.09 * pulse * amplitude)
                Circle()
                    .fill(
                        LinearGradient(colors: [color.opacity(0.85), color], startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .padding(size * 0.22)
                    .shadow(color: color.opacity(0.35), radius: 12, y: 4)
                Image(systemName: state.symbol)
                    .font(.system(size: size * 0.2, weight: .semibold))
                    .foregroundStyle(HDColor.onBrand)
            }
            .frame(width: size, height: size)
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: state)
        .accessibilityHidden(true)
    }
}

#if DEBUG
#Preview("状態") {
    VStack(spacing: 24) {
        HStack { VoiceOrbView(state: .listening, size: 100); VoiceOrbView(state: .userSpeaking, size: 100) }
        HStack { VoiceOrbView(state: .thinking, size: 100); VoiceOrbView(state: .assistantSpeaking, size: 100) }
        HStack { VoiceOrbView(state: .reconnecting(attempt: 1), size: 100); VoiceOrbView(state: .error(.connectionFailed), size: 100) }
    }
    .padding()
}
#endif
