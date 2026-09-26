import Foundation
import Observation

/// アバターの状態・感情・口の開き・まばたき・視線を持つ（描画エンジンに依存しない）。
/// 見た目（`HappyAvatarView`）を Rive 等に差し替えても、このクラスと `HappyVoiceAvatarBridge` はそのまま使える。
@MainActor
@Observable
public final class HappyAvatarController {
    public private(set) var state: HappyAvatarState = .idle
    public private(set) var emotion: HappyAvatarEmotion = .neutral
    /// 口の開き（0〜1）。回答中の音量から決まる
    public private(set) var mouthLevel: CGFloat = 0
    public private(set) var eyeOpen: CGFloat = 1
    public private(set) var lookX: CGFloat = 0
    public private(set) var lookY: CGFloat = 0
    public private(set) var tailMotion: CGFloat = 0.18
    public private(set) var bodyBounce: CGFloat = 0.08

    /// これ以下の音量は無音として扱う（回線・再生のノイズで口が動かないように）
    public static let noiseFloor: CGFloat = 0.045
    /// 平滑化後にこれ未満なら口を閉じる
    public static let closeThreshold: CGFloat = 0.035
    /// 低域通過の係数（前回値の重み）。大きいほど滑らかで遅い
    public static let smoothing: CGFloat = 0.65

    @ObservationIgnored private var previousAudioLevel: CGFloat = 0

    public init() {}

    public func setIdle() {
        state = .idle
        emotion = .neutral
        closeMouth()
        lookY = 0
        tailMotion = 0.18
        bodyBounce = 0.08
    }

    public func setListening() {
        state = .listening
        emotion = .neutral
        closeMouth()
        lookY = 0
        tailMotion = 0.08
        bodyBounce = 0.04
    }

    public func setThinking() {
        state = .thinking
        emotion = .thinking
        closeMouth()
        lookY = -0.18
        tailMotion = 0.05
        bodyBounce = 0.03
    }

    public func setSpeaking() {
        state = .speaking
        if emotion == .thinking { emotion = .neutral }
        lookY = 0
        tailMotion = 0.24
        bodyBounce = 0.12
    }

    public func setReconnecting() {
        state = .reconnecting
        emotion = .concerned
        closeMouth()
        tailMotion = 0.03
    }

    public func setError() {
        state = .error
        emotion = .concerned
        closeMouth()
        tailMotion = 0
    }

    public func setEmotion(_ emotion: HappyAvatarEmotion) {
        self.emotion = emotion
    }

    public func lookAt(x: CGFloat, y: CGFloat) {
        lookX = min(max(x, -1), 1)
        lookY = min(max(y, -1), 1)
    }

    /// 1 回まばたきする（取り消されても必ず目を開いた状態で終わる）
    public func blink() async {
        eyeOpen = 1
        try? await Task.sleep(nanoseconds: 40_000_000)
        guard !Task.isCancelled else { return }
        eyeOpen = 0
        try? await Task.sleep(nanoseconds: 90_000_000)
        eyeOpen = 1
    }

    /// 回答の音量（0〜1 に正規化済み）から口の開きを決める。回答中以外は口を閉じる。
    /// ノイズフロア → 正規化 → 低域通過 → 小さければ閉じる、の順に処理する。
    public func updateAssistantAudioLevel(_ rawLevel: CGFloat) {
        guard state == .speaking else {
            closeMouth()
            return
        }
        let clamped = rawLevel.isFinite ? min(max(rawLevel, 0), 1) : 0
        let floor = Self.noiseFloor
        let normalized = clamped <= floor ? 0 : min((clamped - floor) / (1 - floor), 1)

        let smoothed = previousAudioLevel * Self.smoothing + normalized * (1 - Self.smoothing)
        previousAudioLevel = smoothed
        let next = smoothed < Self.closeThreshold ? 0 : smoothed
        if next != mouthLevel { mouthLevel = next }
    }

    /// 利用者が割り込んだ：口をすぐ閉じて聞く姿勢に戻る
    public func interruptAssistant() {
        setListening()
    }

    public func reset() {
        previousAudioLevel = 0
        state = .idle
        emotion = .neutral
        mouthLevel = 0
        eyeOpen = 1
        lookX = 0
        lookY = 0
        tailMotion = 0.18
        bodyBounce = 0.08
    }

    private func closeMouth() {
        previousAudioLevel = 0
        if mouthLevel != 0 { mouthLevel = 0 }
    }
}
