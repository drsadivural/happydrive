import SwiftUI
import HappyDriveCore

/// 音声スペクトラム。話している側（あなた／AI）の実際の音量に合わせて中央の棒が大きく動く。
/// 音量は WebRTC の統計（audioLevel）から取得し、音声データそのものは解析・保存しない。
/// 「視差効果を減らす」がオンのときは揺らさず、音量に合わせて高さだけ変える。
struct VoiceSpectrumView: View {
    let state: VoiceConversationState
    let inputLevel: Double
    let outputLevel: Double
    var barCount = 29
    var height: CGFloat = 150

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// 表示に使う音量（0〜1）。線形振幅を -50dB〜0dB の範囲で見た目の大きさに変換する。
    private var level: Double {
        let raw: Double
        switch state {
        case .assistantSpeaking: raw = outputLevel
        case .userSpeaking, .listening: raw = inputLevel
        default: raw = max(inputLevel, outputLevel)
        }
        guard raw > 0.0001 else { return 0 }
        return min(1, max(0, (20 * log10(raw) + 50) / 50))
    }

    /// 音がないときの待機中の動き（考え中・接続中はゆっくり流れる波）
    private var idleWave: Double {
        switch state {
        case .thinking: return 0.35
        case .connecting, .requestingPermission, .reconnecting: return 0.22
        case .listening: return 0.08
        default: return 0
        }
    }

    var body: some View {
        let color = VoiceStateStyle.color(for: state)
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: 4) {
                ForEach(0..<barCount, id: \.self) { i in
                    Capsule()
                        .fill(
                            LinearGradient(colors: [color.opacity(0.55), color], startPoint: .bottom, endPoint: .top)
                        )
                        .frame(width: 6, height: barHeight(index: i, time: t))
                }
            }
            .frame(height: height)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.08), value: level)
        }
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }

    private func barHeight(index i: Int, time t: TimeInterval) -> CGFloat {
        let minH: CGFloat = 6
        let x = (Double(i) / Double(barCount - 1)) * 2 - 1           // -1 … 1
        let envelope = 0.3 + 0.7 * exp(-(x * x) / 0.22)              // 中央ほど高い
        let wobble: Double
        if reduceMotion {
            wobble = 1
        } else {
            // 帯域ごとに位相の違う揺れで、スペクトラムらしい動きにする
            let phase = Double(i) * 1.7 + sin(t * 1.3 + Double(i) * 0.9) * 0.8
            wobble = 0.55 + 0.45 * sin(t * 9 + phase)
        }
        let voice = level * envelope * wobble
        let idle = reduceMotion ? 0 : idleWave * envelope * (0.5 + 0.5 * sin(t * 2.4 - Double(i) * 0.45))
        let value = max(voice, idle)
        return minH + (height - minH) * CGFloat(min(1, value))
    }
}

#if DEBUG
#Preview("スペクトラム") {
    VStack(spacing: 32) {
        VoiceSpectrumView(state: .userSpeaking, inputLevel: 0.2, outputLevel: 0)
        VoiceSpectrumView(state: .assistantSpeaking, inputLevel: 0, outputLevel: 0.1)
        VoiceSpectrumView(state: .thinking, inputLevel: 0, outputLevel: 0)
    }
    .padding()
}
#endif
