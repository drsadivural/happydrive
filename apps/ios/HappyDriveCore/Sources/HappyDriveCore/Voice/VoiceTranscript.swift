import Foundation

public enum VoiceTranscriptRole: String, Sendable, Hashable, Codable {
    case user, assistant

    /// 画面のラベル
    public var label: String {
        switch self {
        case .user: return "あなた"
        case .assistant: return "AI"
        }
    }
}

/// 会話の 1 発話（メモリ上のみ。端末・サーバーに保存しない）
public struct VoiceTranscriptItem: Identifiable, Sendable, Hashable {
    public enum Source: String, Sendable, Hashable {
        case voice, text
    }

    /// Realtime の item_id（テキスト送信はローカル ID）
    public let id: String
    public let role: VoiceTranscriptRole
    public var text: String
    /// 確定済み（ストリーミングが終わった）
    public var isFinal: Bool
    /// 利用者の割り込みで回答が途中で止まった
    public var interrupted: Bool
    public let source: Source
    public let createdAt: Date

    public init(id: String, role: VoiceTranscriptRole, text: String, isFinal: Bool, interrupted: Bool = false, source: Source, createdAt: Date) {
        self.id = id
        self.role = role
        self.text = text
        self.isFinal = isFinal
        self.interrupted = interrupted
        self.source = source
        self.createdAt = createdAt
    }

    /// 画面に出すか（音声の区切りだけで文字が無いものは出さない）
    public var isDisplayable: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (role == .user && !isFinal)
    }
}

/// 文脈の復元に使う発話
public struct VoiceContextTurn: Sendable, Hashable {
    public var role: VoiceTranscriptRole
    public var text: String

    public init(role: VoiceTranscriptRole, text: String) {
        self.role = role
        self.text = text
    }
}

/// ストリーミングの差分（item_id ごと）から会話記録を組み立てる。
/// - 利用者の発話は「話し始め」の時点で枠を作り、後から届く文字起こしで埋める（順序が入れ替わらない）
/// - アシスタントの発話は応答の文字起こし/テキストの差分で作る（文脈復元で入れ直した発話は二重に作らない）
public struct TranscriptAssembler: Sendable, Hashable {
    public private(set) var items: [VoiceTranscriptItem] = []
    /// 1 セッションで保持する最大件数（古いものから捨てる）
    public var maxItems: Int
    static let staleEmptyUserItemSeconds: TimeInterval = 10

    public init(maxItems: Int = 200) {
        self.maxItems = max(1, maxItems)
    }

    public var isEmpty: Bool { items.isEmpty }

    public var displayItems: [VoiceTranscriptItem] {
        items.filter(\.isDisplayable)
    }

    public func item(id: String) -> VoiceTranscriptItem? {
        items.first { $0.id == id }
    }

    /// サーバーイベントを反映する。表示が変わったら true。
    @discardableResult
    public mutating func apply(_ event: RealtimeServerEvent, now: Date = Date()) -> Bool {
        switch event {
        case .speechStarted(let itemId, _):
            // 文字起こしが届かなかった古い空の枠（雑音の誤検出など）を片付ける
            let staleBefore = now.addingTimeInterval(-Self.staleEmptyUserItemSeconds)
            let before = items.count
            items.removeAll { $0.role == .user && !$0.isFinal && $0.text.isEmpty && $0.id != itemId && $0.createdAt < staleBefore }
            let removed = items.count != before
            guard let itemId else { return removed }
            return ensure(id: itemId, role: .user, source: .voice, now: now) || removed

        case .inputAudioCommitted(let itemId):
            guard let itemId else { return false }
            return ensure(id: itemId, role: .user, source: .voice, now: now)

        case .inputTranscriptionDelta(let itemId, let delta):
            ensure(id: itemId, role: .user, source: .voice, now: now)
            return update(itemId) { item in
                guard !item.isFinal else { return false }
                item.text += delta
                return !delta.isEmpty
            }

        case .inputTranscriptionCompleted(let itemId, let transcript):
            let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return remove(itemId)
            }
            ensure(id: itemId, role: .user, source: .voice, now: now)
            return update(itemId) { item in
                item.text = trimmed
                item.isFinal = true
                return true
            }

        case .inputTranscriptionFailed(let itemId):
            return remove(itemId)

        case .outputAudioTranscriptDelta(let itemId, _, let delta), .outputTextDelta(let itemId, _, let delta):
            ensure(id: itemId, role: .assistant, source: .voice, now: now)
            return update(itemId) { item in
                guard !item.isFinal else { return false }
                item.text += delta
                return !delta.isEmpty
            }

        case .outputAudioTranscriptDone(let itemId, _, let text), .outputTextDone(let itemId, _, let text):
            ensure(id: itemId, role: .assistant, source: .voice, now: now)
            return update(itemId) { item in
                // 割り込まれた回答は聞こえた所までの差分を残し、全文で上書きしない
                if !item.interrupted, !text.isEmpty { item.text = text }
                let changed = !item.isFinal
                item.isFinal = true
                return changed || !text.isEmpty
            }

        case .responseDone:
            // 応答が終わった（取り消し・失敗を含む）ら、流れていたアシスタントの発話を確定させる
            var changed = false
            for index in items.indices where items[index].role == .assistant && !items[index].isFinal {
                items[index].isFinal = true
                changed = true
            }
            return changed

        default:
            return false
        }
    }

    /// 利用者がテキストで送った発話
    public mutating func addUserText(_ text: String, id: String = "local-" + UUID().uuidString.lowercased(), now: Date = Date()) {
        append(VoiceTranscriptItem(id: id, role: .user, text: text, isFinal: true, source: .text, createdAt: now))
    }

    /// 割り込みで止めたアシスタントの発話に印を付ける
    @discardableResult
    public mutating func markInterrupted(itemId: String) -> Bool {
        update(itemId) { item in
            guard item.role == .assistant, !item.interrupted else { return false }
            item.interrupted = true
            item.isFinal = true
            return true
        }
    }

    /// まだ流れているアシスタントの発話（割り込み対象）
    public var streamingAssistantItemId: String? {
        items.last { $0.role == .assistant && !$0.isFinal }?.id
    }

    /// 文脈復元用の直近の発話（空・未確定は除く。長い発話は切り詰める）
    public func contextTurns(limit: Int, maxCharacters: Int = 600) -> [VoiceContextTurn] {
        guard limit > 0 else { return [] }
        let usable = items.compactMap { item -> VoiceContextTurn? in
            let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            // 利用者の未確定の文字起こしは不正確なため除く（アシスタントは途中まででも文脈として有効）
            if item.role == .user && !item.isFinal { return nil }
            let clipped = text.count > maxCharacters ? String(text.prefix(maxCharacters)) + "…" : text
            return VoiceContextTurn(role: item.role, text: item.interrupted ? clipped + "（途中で中断）" : clipped)
        }
        return Array(usable.suffix(limit))
    }

    public mutating func removeAll() {
        items.removeAll()
    }

    // MARK: - 内部

    @discardableResult
    private mutating func ensure(id: String, role: VoiceTranscriptRole, source: VoiceTranscriptItem.Source, now: Date) -> Bool {
        if items.contains(where: { $0.id == id }) { return false }
        append(VoiceTranscriptItem(id: id, role: role, text: "", isFinal: false, source: source, createdAt: now))
        return true
    }

    private mutating func append(_ item: VoiceTranscriptItem) {
        items.append(item)
        if items.count > maxItems {
            items.removeFirst(items.count - maxItems)
        }
    }

    private mutating func update(_ id: String, _ change: (inout VoiceTranscriptItem) -> Bool) -> Bool {
        guard let index = items.lastIndex(where: { $0.id == id }) else { return false }
        return change(&items[index])
    }

    private mutating func remove(_ id: String) -> Bool {
        let before = items.count
        items.removeAll { $0.id == id }
        return items.count != before
    }
}
