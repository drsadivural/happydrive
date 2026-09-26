import Foundation

/// 再接続の方針：上限回数つきの指数バックオフ（上限あり）＋ジッター。
public struct ReconnectPolicy: Sendable, Hashable {
    public var maxAttempts: Int
    public var baseDelay: TimeInterval
    public var maxDelay: TimeInterval

    public init(maxAttempts: Int = 3, baseDelay: TimeInterval = 0.5, maxDelay: TimeInterval = 8) {
        self.maxAttempts = max(0, maxAttempts)
        self.baseDelay = max(0, baseDelay)
        self.maxDelay = max(self.baseDelay, maxDelay)
    }

    /// 指数部分（ジッターなし）。attempt は 1 始まり。
    public func ceilingDelay(forAttempt attempt: Int) -> TimeInterval {
        let exponent = Double(max(0, attempt - 1))
        return min(maxDelay, baseDelay * pow(2, exponent))
    }

    /// attempt 回目（1 始まり）の待ち時間。上限を超えたら nil（再接続をあきらめる）。
    /// ジッターは「半分固定＋半分ランダム」（equal jitter）。`random` は 0...1 の値（テストで固定できる）。
    public func delay(forAttempt attempt: Int, random: Double = Double.random(in: 0...1)) -> TimeInterval? {
        guard attempt >= 1, attempt <= maxAttempts else { return nil }
        let ceiling = ceilingDelay(forAttempt: attempt)
        let r = min(max(random, 0), 1)
        return ceiling / 2 + (ceiling / 2) * r
    }

    public func canRetry(afterAttempt attempt: Int) -> Bool {
        attempt < maxAttempts
    }
}

/// 音声会話の設定値（一か所に集約）。アイドル時間・最大時間はサーバーの値で上書きする。
public struct VoiceConfiguration: Sendable, Hashable {
    public var reconnect: ReconnectPolicy
    /// 資格情報の発行から WebRTC のデータチャネルが開くまでの上限
    public var connectTimeout: TimeInterval
    /// 1 回のツール実行の上限
    public var toolTimeout: TimeInterval
    /// 双方とも発話がない状態がこの秒数続いたら終了
    public var idleTimeout: TimeInterval
    /// 1 回の会話の最大時間
    public var maxDuration: TimeInterval
    /// 再接続・再開時にモデルへ渡し直す直近の発話数
    public var contextReplayTurns: Int
    /// 文脈として渡し直す 1 発話あたりの最大文字数
    public var contextReplayMaxCharacters: Int
    /// ICE が「切断」になってから再接続を始めるまでの猶予
    public var disconnectGracePeriod: TimeInterval
    /// 画面で送れるテキストの最大文字数
    public var maxTextMessageLength: Int

    public init(
        reconnect: ReconnectPolicy = ReconnectPolicy(),
        connectTimeout: TimeInterval = 15,
        toolTimeout: TimeInterval = 8,
        idleTimeout: TimeInterval = 120,
        maxDuration: TimeInterval = 900,
        contextReplayTurns: Int = 12,
        contextReplayMaxCharacters: Int = 600,
        disconnectGracePeriod: TimeInterval = 3,
        maxTextMessageLength: Int = 500
    ) {
        self.reconnect = reconnect
        self.connectTimeout = connectTimeout
        self.toolTimeout = toolTimeout
        self.idleTimeout = idleTimeout
        self.maxDuration = maxDuration
        self.contextReplayTurns = contextReplayTurns
        self.contextReplayMaxCharacters = contextReplayMaxCharacters
        self.disconnectGracePeriod = disconnectGracePeriod
        self.maxTextMessageLength = maxTextMessageLength
    }

    public static let `default` = VoiceConfiguration()

    /// サーバーが返した上限（正の値のみ）で上書きした設定
    public func applying(_ session: VoiceSession) -> VoiceConfiguration {
        var copy = self
        if session.idleTimeoutSeconds > 0 { copy.idleTimeout = TimeInterval(session.idleTimeoutSeconds) }
        if session.maxDurationSeconds > 0 { copy.maxDuration = TimeInterval(session.maxDurationSeconds) }
        return copy
    }
}
