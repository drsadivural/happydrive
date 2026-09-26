import Foundation

// MARK: - POST /voice/realtime-session

/// 音声会話の資格情報（サーバーが OpenAI Realtime のセッション設定を済ませた一時キー）。
/// `clientSecret` は秘密情報。ログ・永続化・画面表示をしないこと（description では伏せ字にする）。
public struct VoiceSession: Codable, Sendable, Hashable {
    public var sessionId: String
    public var clientSecret: String
    public var expiresAt: Date
    public var model: String
    public var voice: String
    public var callUrl: URL
    public var maxDurationSeconds: Int
    public var idleTimeoutSeconds: Int
    public var tools: [String]

    public init(sessionId: String, clientSecret: String, expiresAt: Date, model: String, voice: String, callUrl: URL, maxDurationSeconds: Int, idleTimeoutSeconds: Int, tools: [String]) {
        self.sessionId = sessionId
        self.clientSecret = clientSecret
        self.expiresAt = expiresAt
        self.model = model
        self.voice = voice
        self.callUrl = callUrl
        self.maxDurationSeconds = maxDurationSeconds
        self.idleTimeoutSeconds = idleTimeoutSeconds
        self.tools = tools
    }
}

extension VoiceSession: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String {
        "VoiceSession(sessionId: \(sessionId), clientSecret: <redacted>, model: \(model), expiresAt: \(HDJSON.formatDateTime(expiresAt)))"
    }

    public var debugDescription: String { description }
}

public struct VoiceSessionRequest: Codable, Sendable, Hashable {
    public var previousSessionId: String?
    public init(previousSessionId: String?) {
        self.previousSessionId = previousSessionId
    }
}

// MARK: - POST /voice/sessions/{id}/end

/// 会話の終了理由（契約の endReason）
public enum VoiceEndReason: String, Codable, Sendable, CaseIterable {
    case user_ended, idle_timeout, max_duration, error, background, auth_expired, reconnect_exhausted
}

/// 会話の品質指標（本文・音声は含めない）。nil の項目は送信しない。
public struct VoiceSessionMetrics: Codable, Sendable, Hashable {
    public var endReason: VoiceEndReason
    public var durationSeconds: Int
    public var connectMs: Int?
    public var reconnectCount: Int?
    public var userTurns: Int?
    public var firstAudioLatencyMsP50: Int?
    public var firstAudioLatencyMsP95: Int?
    public var interruptionStopMsP50: Int?
    public var toolCalls: Int?
    public var toolFailures: Int?
    public var toolLatencyMsP50: Int?
    public var errorCount: Int?
    public var lastErrorCode: String?

    public static let lastErrorCodeMaxLength = 64

    public init(endReason: VoiceEndReason, durationSeconds: Int, connectMs: Int? = nil, reconnectCount: Int? = nil, userTurns: Int? = nil, firstAudioLatencyMsP50: Int? = nil, firstAudioLatencyMsP95: Int? = nil, interruptionStopMsP50: Int? = nil, toolCalls: Int? = nil, toolFailures: Int? = nil, toolLatencyMsP50: Int? = nil, errorCount: Int? = nil, lastErrorCode: String? = nil) {
        self.endReason = endReason
        self.durationSeconds = max(0, durationSeconds)
        self.connectMs = connectMs
        self.reconnectCount = reconnectCount
        self.userTurns = userTurns
        self.firstAudioLatencyMsP50 = firstAudioLatencyMsP50
        self.firstAudioLatencyMsP95 = firstAudioLatencyMsP95
        self.interruptionStopMsP50 = interruptionStopMsP50
        self.toolCalls = toolCalls
        self.toolFailures = toolFailures
        self.toolLatencyMsP50 = toolLatencyMsP50
        self.errorCount = errorCount
        self.lastErrorCode = lastErrorCode.map { String($0.prefix(Self.lastErrorCodeMaxLength)) }
    }
}

// MARK: - API

extension HappyDriveAPI {
    /// 音声会話の一時資格情報を発行する。再接続時は直前の sessionId を渡す。
    public func createVoiceSession(previousSessionId: String? = nil) async throws -> VoiceSession {
        try await client.send(try .json(.post, "/voice/realtime-session", body: VoiceSessionRequest(previousSessionId: previousSessionId)))
    }

    /// 会話の終了と品質指標を記録する（ベストエフォート）。
    public func endVoiceSession(id: String, metrics: VoiceSessionMetrics) async throws {
        let _: EmptyResponse = try await client.send(try .json(.post, "/voice/sessions/\(APIClient.pathComponent(id))/end", body: metrics))
    }
}
