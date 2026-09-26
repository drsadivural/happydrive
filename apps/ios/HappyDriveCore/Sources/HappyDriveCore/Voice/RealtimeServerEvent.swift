import Foundation

/// Realtime のファンクション呼び出し（引数は JSON 文字列のまま）
public struct RealtimeFunctionCall: Sendable, Hashable {
    public var callId: String
    public var name: String
    public var arguments: String
    public var itemId: String?
    public var responseId: String?

    public init(callId: String, name: String, arguments: String, itemId: String? = nil, responseId: String? = nil) {
        self.callId = callId
        self.name = name
        self.arguments = arguments
        self.itemId = itemId
        self.responseId = responseId
    }
}

/// 会話アイテムの概要（conversation.item.added / done・response.output_item.done）
public struct RealtimeItemInfo: Sendable, Hashable {
    public var id: String?
    public var type: String
    public var role: String?
    public var status: String?
    /// type == function_call のとき
    public var callId: String?
    public var name: String?
    public var arguments: String?

    public init(id: String?, type: String, role: String? = nil, status: String? = nil, callId: String? = nil, name: String? = nil, arguments: String? = nil) {
        self.id = id
        self.type = type
        self.role = role
        self.status = status
        self.callId = callId
        self.name = name
        self.arguments = arguments
    }

    public var functionCall: RealtimeFunctionCall? {
        guard type == "function_call", let callId, let name else { return nil }
        return RealtimeFunctionCall(callId: callId, name: name, arguments: arguments ?? "{}", itemId: id)
    }
}

/// response.done の概要
public struct RealtimeResponseSummary: Sendable, Hashable {
    public var id: String?
    /// completed / cancelled / failed / incomplete
    public var status: String?
    public var statusReason: String?
    public var functionCalls: [RealtimeFunctionCall]

    public init(id: String?, status: String?, statusReason: String? = nil, functionCalls: [RealtimeFunctionCall] = []) {
        self.id = id
        self.status = status
        self.statusReason = statusReason
        self.functionCalls = functionCalls
    }
}

/// error イベントの内容（message は英語のことが多いので画面には出さない）
public struct RealtimeErrorInfo: Sendable, Hashable {
    public var type: String?
    public var code: String?
    public var message: String?
    public var eventId: String?

    public init(type: String?, code: String?, message: String?, eventId: String?) {
        self.type = type
        self.code = code
        self.message = message
        self.eventId = eventId
    }

    /// 会話を続けられる軽微なエラー（取り消し対象の応答がない等）
    public var isBenign: Bool {
        guard let code else { return false }
        return ["response_cancel_not_active", "conversation_already_has_active_response"].contains(code)
    }

    /// セッションの期限切れ（最大時間に達した）
    public var isSessionExpired: Bool {
        code == "session_expired"
    }
}

/// サーバー（OpenAI Realtime）からデータチャネルで届くイベント
public enum RealtimeServerEvent: Sendable, Hashable {
    case sessionCreated
    case sessionUpdated
    case speechStarted(itemId: String?, audioStartMs: Int?)
    case speechStopped(itemId: String?, audioEndMs: Int?)
    case inputAudioCommitted(itemId: String?)
    case inputTranscriptionDelta(itemId: String, delta: String)
    case inputTranscriptionCompleted(itemId: String, transcript: String)
    case inputTranscriptionFailed(itemId: String)
    case itemAdded(RealtimeItemInfo)
    case itemDone(RealtimeItemInfo)
    case responseCreated(responseId: String?)
    case outputAudioTranscriptDelta(itemId: String, responseId: String?, delta: String)
    case outputAudioTranscriptDone(itemId: String, responseId: String?, transcript: String)
    case outputTextDelta(itemId: String, responseId: String?, delta: String)
    case outputTextDone(itemId: String, responseId: String?, text: String)
    case functionCallArgumentsDelta(callId: String, delta: String)
    case functionCallArgumentsDone(RealtimeFunctionCall)
    case outputItemDone(RealtimeItemInfo, responseId: String?)
    case responseDone(RealtimeResponseSummary)
    case outputAudioStarted(responseId: String?)
    case outputAudioStopped(responseId: String?)
    case outputAudioCleared
    case rateLimitsUpdated
    case error(RealtimeErrorInfo)
    /// 未対応の種類（type 名のみ記録して無視する）
    case unknown(type: String)
    /// JSON として解釈できない・必須項目がない
    case malformed(type: String?)

    public var typeName: String {
        switch self {
        case .sessionCreated: return "session.created"
        case .sessionUpdated: return "session.updated"
        case .speechStarted: return "input_audio_buffer.speech_started"
        case .speechStopped: return "input_audio_buffer.speech_stopped"
        case .inputAudioCommitted: return "input_audio_buffer.committed"
        case .inputTranscriptionDelta: return "conversation.item.input_audio_transcription.delta"
        case .inputTranscriptionCompleted: return "conversation.item.input_audio_transcription.completed"
        case .inputTranscriptionFailed: return "conversation.item.input_audio_transcription.failed"
        case .itemAdded: return "conversation.item.added"
        case .itemDone: return "conversation.item.done"
        case .responseCreated: return "response.created"
        case .outputAudioTranscriptDelta: return "response.output_audio_transcript.delta"
        case .outputAudioTranscriptDone: return "response.output_audio_transcript.done"
        case .outputTextDelta: return "response.output_text.delta"
        case .outputTextDone: return "response.output_text.done"
        case .functionCallArgumentsDelta: return "response.function_call_arguments.delta"
        case .functionCallArgumentsDone: return "response.function_call_arguments.done"
        case .outputItemDone: return "response.output_item.done"
        case .responseDone: return "response.done"
        case .outputAudioStarted: return "output_audio_buffer.started"
        case .outputAudioStopped: return "output_audio_buffer.stopped"
        case .outputAudioCleared: return "output_audio_buffer.cleared"
        case .rateLimitsUpdated: return "rate_limits.updated"
        case .error: return "error"
        case .unknown(let type): return type
        case .malformed(let type): return type ?? "malformed"
        }
    }
}

/// データチャネルの JSON を型付きイベントに変換する。例外は投げない（UI に波及させない）。
public enum RealtimeEventParser {
    public static func parse(_ data: Data) -> RealtimeServerEvent {
        guard let raw = try? JSONSerialization.jsonObject(with: data, options: []),
              let object = raw as? [String: Any] else {
            return .malformed(type: nil)
        }
        guard let type = object["type"] as? String, !type.isEmpty else {
            return .malformed(type: nil)
        }
        return parse(type: type, object) ?? .malformed(type: type)
    }

    public static func parse(_ text: String) -> RealtimeServerEvent {
        parse(Data(text.utf8))
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private static func parse(type: String, _ o: [String: Any]) -> RealtimeServerEvent? {
        switch type {
        case "session.created":
            return .sessionCreated
        case "session.updated":
            return .sessionUpdated
        case "input_audio_buffer.speech_started":
            return .speechStarted(itemId: string(o, "item_id"), audioStartMs: int(o, "audio_start_ms"))
        case "input_audio_buffer.speech_stopped":
            return .speechStopped(itemId: string(o, "item_id"), audioEndMs: int(o, "audio_end_ms"))
        case "input_audio_buffer.committed":
            return .inputAudioCommitted(itemId: string(o, "item_id"))
        case "conversation.item.input_audio_transcription.delta":
            guard let itemId = string(o, "item_id") else { return nil }
            return .inputTranscriptionDelta(itemId: itemId, delta: string(o, "delta") ?? "")
        case "conversation.item.input_audio_transcription.completed":
            guard let itemId = string(o, "item_id") else { return nil }
            return .inputTranscriptionCompleted(itemId: itemId, transcript: string(o, "transcript") ?? "")
        case "conversation.item.input_audio_transcription.failed":
            guard let itemId = string(o, "item_id") else { return nil }
            return .inputTranscriptionFailed(itemId: itemId)
        case "conversation.item.added", "conversation.item.created":
            guard let item = itemInfo(o["item"]) else { return nil }
            return .itemAdded(item)
        case "conversation.item.done":
            guard let item = itemInfo(o["item"]) else { return nil }
            return .itemDone(item)
        case "response.created":
            let response = o["response"] as? [String: Any]
            return .responseCreated(responseId: response.flatMap { string($0, "id") })
        case "response.output_audio_transcript.delta", "response.audio_transcript.delta":
            guard let itemId = string(o, "item_id") else { return nil }
            return .outputAudioTranscriptDelta(itemId: itemId, responseId: string(o, "response_id"), delta: string(o, "delta") ?? "")
        case "response.output_audio_transcript.done", "response.audio_transcript.done":
            guard let itemId = string(o, "item_id") else { return nil }
            return .outputAudioTranscriptDone(itemId: itemId, responseId: string(o, "response_id"), transcript: string(o, "transcript") ?? "")
        case "response.output_text.delta", "response.text.delta":
            guard let itemId = string(o, "item_id") else { return nil }
            return .outputTextDelta(itemId: itemId, responseId: string(o, "response_id"), delta: string(o, "delta") ?? "")
        case "response.output_text.done", "response.text.done":
            guard let itemId = string(o, "item_id") else { return nil }
            return .outputTextDone(itemId: itemId, responseId: string(o, "response_id"), text: string(o, "text") ?? "")
        case "response.function_call_arguments.delta":
            guard let callId = string(o, "call_id") else { return nil }
            return .functionCallArgumentsDelta(callId: callId, delta: string(o, "delta") ?? "")
        case "response.function_call_arguments.done":
            guard let callId = string(o, "call_id") else { return nil }
            // GA では name が含まれる。無い場合は response.done の output から補う（name 空は呼び出し側で保留）。
            return .functionCallArgumentsDone(RealtimeFunctionCall(
                callId: callId,
                name: string(o, "name") ?? "",
                arguments: string(o, "arguments") ?? "{}",
                itemId: string(o, "item_id"),
                responseId: string(o, "response_id")
            ))
        case "response.output_item.done":
            guard let item = itemInfo(o["item"]) else { return nil }
            return .outputItemDone(item, responseId: string(o, "response_id"))
        case "response.done":
            guard let response = o["response"] as? [String: Any] else { return nil }
            let responseId = string(response, "id")
            let output = (response["output"] as? [Any]) ?? []
            let calls: [RealtimeFunctionCall] = output.compactMap { raw in
                guard var call = itemInfo(raw)?.functionCall else { return nil }
                call.responseId = responseId
                return call
            }
            let details = response["status_details"] as? [String: Any]
            return .responseDone(RealtimeResponseSummary(
                id: responseId,
                status: string(response, "status"),
                statusReason: details.flatMap { string($0, "reason") },
                functionCalls: calls
            ))
        case "output_audio_buffer.started", "output_audio_buffer.speech_started":
            return .outputAudioStarted(responseId: string(o, "response_id"))
        case "output_audio_buffer.stopped", "output_audio_buffer.speech_stopped":
            return .outputAudioStopped(responseId: string(o, "response_id"))
        case "output_audio_buffer.cleared":
            return .outputAudioCleared
        case "rate_limits.updated":
            return .rateLimitsUpdated
        case "error":
            let e = o["error"] as? [String: Any] ?? [:]
            return .error(RealtimeErrorInfo(
                type: string(e, "type"),
                code: string(e, "code"),
                message: string(e, "message"),
                eventId: string(e, "event_id") ?? string(o, "event_id")
            ))
        default:
            return .unknown(type: type)
        }
    }

    private static func string(_ o: [String: Any], _ key: String) -> String? {
        o[key] as? String
    }

    private static func int(_ o: [String: Any], _ key: String) -> Int? {
        if let i = o[key] as? Int { return i }
        if let d = o[key] as? Double, d.isFinite { return Int(d) }
        return nil
    }

    private static func itemInfo(_ raw: Any?) -> RealtimeItemInfo? {
        guard let item = raw as? [String: Any], let type = item["type"] as? String else { return nil }
        return RealtimeItemInfo(
            id: string(item, "id"),
            type: type,
            role: string(item, "role"),
            status: string(item, "status"),
            callId: string(item, "call_id"),
            name: string(item, "name"),
            arguments: string(item, "arguments")
        )
    }
}
