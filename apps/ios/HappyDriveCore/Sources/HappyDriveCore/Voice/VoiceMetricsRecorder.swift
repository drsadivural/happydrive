import Foundation

/// 会話の品質指標を集計する（時刻は呼び出し側から渡すのでテストで固定できる）。
/// 本文・音声は扱わない。
public struct VoiceMetricsRecorder: Sendable, Hashable {
    public private(set) var startedAt: Date?
    public private(set) var connectMs: Int?
    public private(set) var reconnectCount = 0
    public private(set) var userTurns = 0
    public private(set) var firstAudioLatenciesMs: [Int] = []
    public private(set) var interruptionStopMs: [Int] = []
    public private(set) var toolLatenciesMs: [Int] = []
    public private(set) var toolCalls = 0
    public private(set) var toolFailures = 0
    public private(set) var errorCount = 0
    public private(set) var lastErrorCode: String?

    private var connectStartedAt: Date?
    /// 利用者の発話終了（またはテキスト送信）から最初の音声までを測る起点
    private var awaitingFirstAudioSince: Date?
    private var interruptionStartedAt: Date?

    public init() {}

    public mutating func sessionStarted(at date: Date) {
        if startedAt == nil { startedAt = date }
    }

    public mutating func connectStarted(at date: Date) {
        connectStartedAt = date
    }

    /// 最初の接続時間だけ記録する（再接続は reconnectCount で数える）
    public mutating func connected(at date: Date) {
        guard let start = connectStartedAt else { return }
        if connectMs == nil { connectMs = Self.ms(from: start, to: date) }
        connectStartedAt = nil
    }

    public mutating func reconnected() {
        reconnectCount += 1
    }

    /// 利用者の 1 発話が終わった（音声の区切り・テキスト送信）
    public mutating func userTurnEnded(at date: Date) {
        userTurns += 1
        awaitingFirstAudioSince = date
    }

    public mutating func assistantAudioStarted(at date: Date) {
        if let since = awaitingFirstAudioSince {
            firstAudioLatenciesMs.append(Self.ms(from: since, to: date))
            awaitingFirstAudioSince = nil
        }
    }

    /// 割り込み（再生中に利用者が話し始めた）
    public mutating func interruptionStarted(at date: Date) {
        if interruptionStartedAt == nil { interruptionStartedAt = date }
    }

    /// 再生が止まった（cleared / stopped）
    public mutating func assistantAudioStopped(at date: Date) {
        if let start = interruptionStartedAt {
            interruptionStopMs.append(Self.ms(from: start, to: date))
            interruptionStartedAt = nil
        }
    }

    public mutating func toolFinished(latencyMs: Int, succeeded: Bool) {
        toolCalls += 1
        toolLatenciesMs.append(max(0, latencyMs))
        if !succeeded { toolFailures += 1 }
    }

    public mutating func recordError(code: String) {
        errorCount += 1
        lastErrorCode = String(code.prefix(VoiceSessionMetrics.lastErrorCodeMaxLength))
    }

    public func summary(endReason: VoiceEndReason, endedAt: Date) -> VoiceSessionMetrics {
        let duration = startedAt.map { Int(endedAt.timeIntervalSince($0).rounded()) } ?? 0
        return VoiceSessionMetrics(
            endReason: endReason,
            durationSeconds: duration,
            connectMs: connectMs,
            reconnectCount: reconnectCount,
            userTurns: userTurns,
            firstAudioLatencyMsP50: Self.percentile(firstAudioLatenciesMs, 50),
            firstAudioLatencyMsP95: Self.percentile(firstAudioLatenciesMs, 95),
            interruptionStopMsP50: Self.percentile(interruptionStopMs, 50),
            toolCalls: toolCalls,
            toolFailures: toolFailures,
            toolLatencyMsP50: Self.percentile(toolLatenciesMs, 50),
            errorCount: errorCount,
            lastErrorCode: lastErrorCode
        )
    }

    /// 最近傍順位法（nearest-rank）のパーセンタイル。空なら nil。
    public static func percentile(_ values: [Int], _ p: Double) -> Int? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let clamped = min(max(p, 0), 100)
        let rank = Int((clamped / 100 * Double(sorted.count)).rounded(.up))
        return sorted[min(max(rank, 1), sorted.count) - 1]
    }

    static func ms(from start: Date, to end: Date) -> Int {
        max(0, Int((end.timeIntervalSince(start) * 1000).rounded()))
    }
}
