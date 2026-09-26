import Foundation

/// 音声会話の状態（画面表示・操作可否の唯一の根拠）
public enum VoiceConversationState: Sendable, Hashable {
    case idle
    case requestingPermission
    case connecting
    /// 接続済みで、利用者の発話を待っている
    case listening
    case userSpeaking
    case thinking
    case assistantSpeaking
    case reconnecting(attempt: Int)
    case disconnected
    case error(VoiceError)

    /// Realtime セッションが確立している（送信できる）
    public var isConnected: Bool {
        switch self {
        case .listening, .userSpeaking, .thinking, .assistantSpeaking: return true
        default: return false
        }
    }

    /// 会話を進行中（開始処理・再接続を含む）。終了ボタンを出す。
    public var isActive: Bool {
        switch self {
        case .requestingPermission, .connecting, .listening, .userSpeaking, .thinking, .assistantSpeaking, .reconnecting: return true
        default: return false
        }
    }

    public var isBusyConnecting: Bool {
        switch self {
        case .requestingPermission, .connecting, .reconnecting: return true
        default: return false
        }
    }

    public var error: VoiceError? {
        if case .error(let e) = self { return e }
        return nil
    }

    /// 状態表示の文言（色だけに頼らず文字とアイコンで示す）
    public var statusText: String {
        switch self {
        case .idle: return "準備中"
        case .requestingPermission: return "マイクの確認中…"
        case .connecting: return "接続中…"
        case .listening: return "お話しください"
        case .userSpeaking: return "聞いています"
        case .thinking: return "考えています…"
        case .assistantSpeaking: return "回答中"
        case .reconnecting: return "再接続中…"
        case .disconnected: return "会話を終了しました"
        case .error(let e): return e == .connectionLost ? "通信が切れました" : "接続できませんでした"
        }
    }

    /// SF Symbols 名
    public var symbol: String {
        switch self {
        case .idle, .disconnected: return "mic.slash"
        case .requestingPermission: return "mic.badge.plus"
        case .connecting, .reconnecting: return "antenna.radiowaves.left.and.right"
        case .listening: return "ear"
        case .userSpeaking: return "waveform"
        case .thinking: return "ellipsis.bubble"
        case .assistantSpeaking: return "speaker.wave.2.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }
}

/// 状態遷移のきっかけ
public enum VoiceEvent: Sendable, Hashable {
    case startRequested
    case permissionGranted
    /// マイク拒否でもテキストで会話できるよう接続は続ける
    case permissionDenied
    case sessionIssued
    case connected
    case speechStarted
    case speechStopped
    case responseCreated
    case assistantAudioStarted
    case assistantAudioStopped
    case responseDone
    case networkLost
    case reconnectSucceeded
    case reconnectFailed(exhausted: Bool)
    case endRequested
    case fatal(VoiceError)
}

/// 決定的な状態遷移。想定外の組み合わせでは状態を変えない。
public enum VoiceStateMachine {
    public static func reduce(_ state: VoiceConversationState, _ event: VoiceEvent) -> VoiceConversationState {
        switch event {
        case .startRequested:
            switch state {
            case .idle, .disconnected, .error: return .requestingPermission
            default: return state
            }

        case .permissionGranted, .permissionDenied:
            return state == .requestingPermission ? .connecting : state

        case .sessionIssued:
            return state == .connecting ? .connecting : state

        case .connected:
            switch state {
            case .connecting, .reconnecting: return .listening
            default: return state
            }

        case .speechStarted:
            // 回答中に話し始めたら割り込み（バージイン）
            switch state {
            case .listening, .thinking, .assistantSpeaking, .userSpeaking: return .userSpeaking
            default: return state
            }

        case .speechStopped:
            return state == .userSpeaking ? .thinking : state

        case .responseCreated:
            switch state {
            case .listening, .thinking: return .thinking
            default: return state
            }

        case .assistantAudioStarted:
            switch state {
            case .listening, .thinking, .assistantSpeaking: return .assistantSpeaking
            default: return state
            }

        case .assistantAudioStopped:
            return state == .assistantSpeaking ? .listening : state

        case .responseDone:
            // WebRTC では再生が response.done より後まで続くため、回答中はそのまま（再生終了で listening に戻る）
            return state == .thinking ? .listening : state

        case .networkLost:
            switch state {
            case .listening, .userSpeaking, .thinking, .assistantSpeaking: return .reconnecting(attempt: 1)
            case .connecting: return .error(.connectionFailed)
            default: return state
            }

        case .reconnectSucceeded:
            if case .reconnecting = state { return .listening }
            return state

        case .reconnectFailed(let exhausted):
            guard case .reconnecting(let attempt) = state else { return state }
            return exhausted ? .error(.connectionLost) : .reconnecting(attempt: attempt + 1)

        case .endRequested:
            switch state {
            case .idle, .error: return state
            default: return .disconnected
            }

        case .fatal(let error):
            return state == .idle ? state : .error(error)
        }
    }
}
