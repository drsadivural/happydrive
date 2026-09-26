#if canImport(SwiftUI)
import SwiftUI

/// HappyDrive のマスコット（ピンクの鳥）を SwiftUI で描くアバター。
/// - 口は `HappyAvatarController.mouthLevel`（回答音声の音量）で開閉する
/// - 呼吸・しっぽの揺れは状態が変わっても止まらない位相アニメーション（毎フレームの再描画はしない）
/// - まばたきは画面に表示されている間だけ。消えたら止め、コントローラーを保持し続けない
/// - 「視差効果を減らす」がオンなら揺れ・まばたきを止め、口の開閉だけを即時に反映する
/// Rive 等に置き換える場合も、このビューだけを差し替えれば良い（コントローラーの API は変えない）。
public struct HappyAvatarView: View {
    private let controller: HappyAvatarController
    private let mode: HappyAvatarPresentationMode

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var blinkTask: Task<Void, Never>?

    public init(
        controller: HappyAvatarController,
        mode: HappyAvatarPresentationMode = .full
    ) {
        self.controller = controller
        self.mode = mode
    }

    public var body: some View {
        ZStack {
            tail
            bodyShape
            feet
            face
            bow
        }
        .aspectRatio(1.02, contentMode: .fit)
        .scaleEffect(scaleForMode)
        .modifier(BreathingModifier(amplitude: breathingAmplitude, enabled: !reduceMotion))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(controller.state.accessibilityLabel)
        .accessibilityAddTraits(.updatesFrequently)
        .onAppear { updateBlinking() }
        .onDisappear { stopBlinking() }
        .onChange(of: reduceMotion) { _, _ in updateBlinking() }
        .onChange(of: ObjectIdentifier(controller)) { _, _ in updateBlinking() }
    }

    // MARK: モード

    private var scaleForMode: CGFloat {
        switch mode {
        case .full: return 1.0
        case .mini: return 0.92
        case .driving: return 1.04
        }
    }

    /// 呼吸の上下幅（pt）。運転中は視線を引かないよう控えめにする
    private var breathingAmplitude: CGFloat {
        let base = controller.bodyBounce * 20
        switch mode {
        case .full: return base
        case .mini: return base * 0.6
        case .driving: return base * 0.5
        }
    }

    // MARK: 感情の表現（マスコットの形・色は変えない）

    private var eyeHeightScale: CGFloat {
        switch controller.emotion {
        case .surprised: return 1.2
        case .sleepy: return 0.45
        case .happy, .excited: return 0.8
        default: return 1
        }
    }

    private var blushOpacity: Double {
        switch controller.emotion {
        case .happy: return 0.45
        case .excited: return 0.65
        default: return 0
        }
    }

    private var showsWorryBrows: Bool {
        controller.emotion == .concerned
    }

    // MARK: 部品

    private var bodyShape: some View {
        GeometryReader { g in
            let w = g.size.width
            let h = g.size.height
            RoundedRectangle(cornerRadius: w * 0.22, style: .continuous)
                .fill(MascotColor.body)
                .frame(width: w * 0.82, height: h * 0.78)
                .overlay(
                    RoundedRectangle(cornerRadius: w * 0.22, style: .continuous)
                        .stroke(.white.opacity(0.22), lineWidth: 2)
                )
                .position(x: w * 0.5, y: h * 0.53)
        }
    }

    private var face: some View {
        GeometryReader { g in
            let w = g.size.width
            let h = g.size.height
            let mouth = controller.mouthLevel

            ZStack {
                Capsule()
                    .fill(.white)
                    .frame(width: w * 0.55, height: h * 0.34)
                    .position(x: w * 0.50, y: h * 0.40)

                // ほっぺ（嬉しい・わくわく）
                ForEach([0.33, 0.67], id: \.self) { x in
                    Ellipse()
                        .fill(MascotColor.blush)
                        .frame(width: w * 0.08, height: h * 0.04)
                        .position(x: w * x, y: h * 0.45)
                        .opacity(blushOpacity)
                }

                eye(x: w * 0.39, y: h * 0.39, size: w * 0.095)
                eye(x: w * 0.61, y: h * 0.36, size: w * 0.095)

                if showsWorryBrows {
                    brow(x: w * 0.39, y: h * 0.31, width: w * 0.08, angle: 14)
                    brow(x: w * 0.61, y: h * 0.28, width: w * 0.08, angle: -14)
                }

                Ellipse()
                    .fill(MascotColor.beak)
                    .frame(width: w * 0.16, height: h * 0.085 + h * 0.038 * mouth)
                    .scaleEffect(y: 1 + mouth * 0.55)
                    .position(x: w * 0.50, y: h * (0.46 + mouth * 0.015))
                    .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
                    .animation(reduceMotion ? nil : .linear(duration: 0.06), value: mouth)
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: controller.emotion)
        }
    }

    private func eye(x: CGFloat, y: CGFloat, size: CGFloat) -> some View {
        let open = controller.eyeOpen
        return ZStack {
            Ellipse()
                .fill(.white)
                .frame(width: size * 1.45, height: max(size * 1.45 * open, 2))

            Circle()
                .fill(MascotColor.pupil)
                .frame(width: size * 0.53, height: size * 0.53)
                .scaleEffect(x: 1, y: eyeHeightScale)
                .offset(
                    x: controller.lookX * size * 0.14,
                    y: controller.lookY * size * 0.12
                )
                .opacity(open > 0.25 ? 1 : 0)
        }
        .position(x: x, y: y)
    }

    private func brow(x: CGFloat, y: CGFloat, width: CGFloat, angle: Double) -> some View {
        Capsule()
            .fill(MascotColor.pupil)
            .frame(width: width, height: max(width * 0.18, 2))
            .rotationEffect(.degrees(angle))
            .position(x: x, y: y)
    }

    private var bow: some View {
        GeometryReader { g in
            let w = g.size.width
            let h = g.size.height
            ZStack {
                Ellipse()
                    .fill(MascotColor.bow)
                    .frame(width: w * 0.18, height: h * 0.105)
                    .rotationEffect(.degrees(-14))
                    .position(x: w * 0.42, y: h * 0.60)

                Ellipse()
                    .fill(MascotColor.bow)
                    .frame(width: w * 0.18, height: h * 0.105)
                    .rotationEffect(.degrees(14))
                    .position(x: w * 0.58, y: h * 0.60)

                Circle()
                    .fill(MascotColor.bowKnot)
                    .frame(width: w * 0.105)
                    .position(x: w * 0.50, y: h * 0.60)
            }
        }
    }

    private var feet: some View {
        GeometryReader { g in
            let w = g.size.width
            let h = g.size.height
            ZStack {
                Ellipse()
                    .fill(MascotColor.feet)
                    .frame(width: w * 0.16, height: h * 0.095)
                    .rotationEffect(.degrees(-12))
                    .position(x: w * 0.34, y: h * 0.80)

                Ellipse()
                    .fill(MascotColor.feet)
                    .frame(width: w * 0.16, height: h * 0.095)
                    .rotationEffect(.degrees(12))
                    .position(x: w * 0.68, y: h * 0.78)
            }
        }
    }

    private var tail: some View {
        GeometryReader { g in
            let w = g.size.width
            let h = g.size.height
            HStack(spacing: -w * 0.035) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(index == 1 ? Color.white.opacity(0.95) : MascotColor.tail)
                        .frame(width: w * 0.15)
                        .offset(y: index == 1 ? h * 0.035 : 0)
                }
            }
            .modifier(SwingModifier(degrees: 32 * controller.tailMotion, enabled: !reduceMotion && mode != .driving))
            .position(x: w * 0.14, y: h * 0.66)
        }
    }

    // MARK: まばたき

    private func updateBlinking() {
        if reduceMotion {
            stopBlinking()
        } else {
            startBlinkLoop()
        }
    }

    private func stopBlinking() {
        blinkTask?.cancel()
        blinkTask = nil
    }

    /// コントローラーは弱参照で持つ（会話終了で解放されたらループも終わる）
    private func startBlinkLoop() {
        blinkTask?.cancel()
        let target = controller
        blinkTask = Task { [weak target] in
            while !Task.isCancelled {
                let nanos = UInt64.random(in: 2_500_000_000...6_000_000_000)
                try? await Task.sleep(nanoseconds: nanos)
                guard !Task.isCancelled, let avatar = target else { return }
                await avatar.blink()

                if Int.random(in: 0..<8) == 0 {
                    try? await Task.sleep(nanoseconds: 120_000_000)
                    guard !Task.isCancelled else { return }
                    await avatar.blink()
                }
            }
        }
    }
}

// MARK: - 位相アニメーション（状態が変わっても止まらない）

/// ゆっくり上下する（呼吸）
private struct BreathingModifier: ViewModifier {
    let amplitude: CGFloat
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content.phaseAnimator([false, true]) { view, up in
                view.offset(y: up ? -amplitude : amplitude)
            } animation: { _ in
                .easeInOut(duration: 1.9)
            }
        } else {
            content
        }
    }
}

/// しっぽを左右に振る
private struct SwingModifier: ViewModifier {
    let degrees: CGFloat
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content.phaseAnimator([false, true]) { view, right in
                view.rotationEffect(.degrees(Double(right ? degrees : -degrees)), anchor: .trailing)
            } animation: { _ in
                .easeInOut(duration: 0.45)
            }
        } else {
            content
        }
    }
}

// MARK: - マスコットの色（キャラクターの見た目なので固定。アプリのテーマ色では変えない）

enum MascotColor {
    static let body = Color(red: 1.00, green: 0.45, blue: 0.68)
    static let tail = Color(red: 1.00, green: 0.55, blue: 0.72)
    static let beak = Color(red: 1.00, green: 0.55, blue: 0.02)
    static let pupil = Color(red: 0.20, green: 0.08, blue: 0.04)
    static let bow = Color(red: 0.37, green: 0.70, blue: 0.96)
    static let bowKnot = Color(red: 0.42, green: 0.73, blue: 0.97)
    static let feet = Color(red: 0.98, green: 0.91, blue: 0.50)
    static let blush = Color(red: 1.00, green: 0.62, blue: 0.74)
}
#endif
