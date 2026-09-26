import Foundation

/// クライアントからデータチャネルで送るイベント。JSON は必ず Encodable で組み立てる（文字列連結はしない）。
public enum RealtimeClientEvent: Sendable, Hashable {
    /// 利用者のテキスト（input_text）
    case userText(String)
    /// 文脈の復元用：過去の発話を会話に入れ直す（user → input_text / assistant → output_text）
    case contextMessage(role: VoiceTranscriptRole, text: String)
    /// ツールの実行結果（output は JSON 文字列）
    case functionCallOutput(callId: String, output: String)
    /// 応答の生成を依頼する。textOnly のときは文字だけの応答を求める。
    case responseCreate(textOnly: Bool)
    case responseCancel(responseId: String?)
    /// WebRTC：再生中のアシスタント音声を直ちに止める
    case outputAudioBufferClear
    case conversationItemTruncate(itemId: String, audioEndMs: Int)

    public var typeName: String {
        switch self {
        case .userText, .contextMessage, .functionCallOutput: return "conversation.item.create"
        case .responseCreate: return "response.create"
        case .responseCancel: return "response.cancel"
        case .outputAudioBufferClear: return "output_audio_buffer.clear"
        case .conversationItemTruncate: return "conversation.item.truncate"
        }
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        switch self {
        case .userText(let text):
            return try encoder.encode(ItemCreate(item: .message(role: "user", contentType: "input_text", text: text)))
        case .contextMessage(let role, let text):
            let item: Item = role == .user
                ? .message(role: "user", contentType: "input_text", text: text)
                : .message(role: "assistant", contentType: "output_text", text: text)
            return try encoder.encode(ItemCreate(item: item))
        case .functionCallOutput(let callId, let output):
            return try encoder.encode(ItemCreate(item: .functionCallOutput(callId: callId, output: output)))
        case .responseCreate(let textOnly):
            return try encoder.encode(ResponseCreate(response: textOnly ? ResponseOptions(outputModalities: ["text"]) : nil))
        case .responseCancel(let responseId):
            return try encoder.encode(ResponseCancel(responseId: responseId))
        case .outputAudioBufferClear:
            return try encoder.encode(TypeOnly(type: "output_audio_buffer.clear"))
        case .conversationItemTruncate(let itemId, let audioEndMs):
            return try encoder.encode(Truncate(itemId: itemId, contentIndex: 0, audioEndMs: max(0, audioEndMs)))
        }
    }

    // MARK: - JSON 形

    private struct TypeOnly: Encodable {
        let type: String
    }

    private struct ContentPart: Encodable {
        let type: String
        let text: String
    }

    private enum Item: Encodable {
        case message(role: String, contentType: String, text: String)
        case functionCallOutput(callId: String, output: String)

        enum CodingKeys: String, CodingKey {
            case type, role, content
            case callId = "call_id"
            case output
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .message(let role, let contentType, let text):
                try c.encode("message", forKey: .type)
                try c.encode(role, forKey: .role)
                try c.encode([ContentPart(type: contentType, text: text)], forKey: .content)
            case .functionCallOutput(let callId, let output):
                try c.encode("function_call_output", forKey: .type)
                try c.encode(callId, forKey: .callId)
                try c.encode(output, forKey: .output)
            }
        }
    }

    private struct ItemCreate: Encodable {
        let type = "conversation.item.create"
        let item: Item
    }

    private struct ResponseOptions: Encodable {
        let outputModalities: [String]
        enum CodingKeys: String, CodingKey {
            case outputModalities = "output_modalities"
        }
    }

    private struct ResponseCreate: Encodable {
        let type = "response.create"
        let response: ResponseOptions?
    }

    private struct ResponseCancel: Encodable {
        let type = "response.cancel"
        let responseId: String?
        enum CodingKeys: String, CodingKey {
            case type
            case responseId = "response_id"
        }
    }

    private struct Truncate: Encodable {
        let type = "conversation.item.truncate"
        let itemId: String
        let contentIndex: Int
        let audioEndMs: Int
        enum CodingKeys: String, CodingKey {
            case type
            case itemId = "item_id"
            case contentIndex = "content_index"
            case audioEndMs = "audio_end_ms"
        }
    }
}
