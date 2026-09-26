import Foundation

/// 音声会話の失敗。画面には `userMessage`（日本語）を表示する。
public enum VoiceError: Error, Sendable, Hashable {
    /// マイクの使用が拒否されている（テキスト入力は利用可能）
    case microphoneDenied
    /// 接続を確立できなかった（資格情報の発行後、WebRTC の確立に失敗・タイムアウト）
    case connectionFailed
    /// 会話中に通信が切れ、再接続もできなかった
    case connectionLost
    /// 端末が圏外
    case offline
    /// サーバーで音声機能が無効（503 voice_unavailable 等）。message はサーバーの日本語。
    case unavailable(message: String?)
    /// 利用回数・同時利用の上限（429）
    case rateLimited(message: String?)
    /// ログインの有効期限切れ（401）
    case authExpired
    /// 利用できないアカウント（403）
    case forbidden(message: String?)
    /// 音声会話の最大時間に達した
    case maxDurationReached
    /// Realtime サーバーのエラーで会話を続けられない
    case server(code: String?)
    /// その他
    case unknown

    public var userMessage: String {
        switch self {
        case .microphoneDenied:
            return "マイクの使用が許可されていません。設定アプリで「マイク」をオンにすると音声で話せます。文字での入力はこのまま使えます。"
        case .connectionFailed:
            return "接続できませんでした。電波の良い場所でもう一度お試しください。"
        case .connectionLost:
            return "通信が切れました。電波の良い場所でもう一度お試しください。"
        case .offline:
            return "圏外のため接続できません。通信が回復してからもう一度お試しください。"
        case .unavailable(let message):
            return Self.nonEmpty(message) ?? "音声機能は現在ご利用いただけません。しばらくしてから再度お試しください。"
        case .rateLimited(let message):
            return Self.nonEmpty(message) ?? "利用回数の上限に達しました。しばらく待ってから再度お試しください。"
        case .authExpired:
            return "ログインの有効期限が切れました。アプリを開き直してください。"
        case .forbidden(let message):
            return Self.nonEmpty(message) ?? "このアカウントでは音声アシスタントを利用できません。"
        case .maxDurationReached:
            return "1回の会話の上限時間に達したため終了しました。続けるには「もう一度話す」を押してください。"
        case .server:
            return "音声アシスタントでエラーが発生しました。もう一度お試しください。"
        case .unknown:
            return "エラーが発生しました。もう一度お試しください。"
        }
    }

    /// 短い見出し（状態表示用）
    public var title: String {
        switch self {
        case .microphoneDenied: return "マイクが使えません"
        case .connectionFailed, .offline: return "接続できませんでした"
        case .connectionLost: return "通信が切れました"
        case .unavailable: return "現在ご利用いただけません"
        case .rateLimited: return "利用回数の上限です"
        case .authExpired: return "ログインが必要です"
        case .forbidden: return "ご利用いただけません"
        case .maxDurationReached: return "会話を終了しました"
        case .server, .unknown: return "エラーが発生しました"
        }
    }

    /// 「もう一度試す」を出すか（権限・アカウントの問題は再試行しても直らない）
    public var isRetryable: Bool {
        switch self {
        case .authExpired, .forbidden, .microphoneDenied: return false
        default: return true
        }
    }

    /// サーバーへ送る終了理由
    public var endReason: VoiceEndReason {
        switch self {
        case .authExpired: return .auth_expired
        case .connectionLost: return .reconnect_exhausted
        case .maxDurationReached: return .max_duration
        default: return .error
        }
    }

    /// 指標に記録するコード（本文を含めない）
    public var metricCode: String {
        switch self {
        case .microphoneDenied: return "microphone_denied"
        case .connectionFailed: return "connection_failed"
        case .connectionLost: return "connection_lost"
        case .offline: return "offline"
        case .unavailable: return "voice_unavailable"
        case .rateLimited: return "rate_limited"
        case .authExpired: return "auth_expired"
        case .forbidden: return "forbidden"
        case .maxDurationReached: return "max_duration"
        case .server(let code): return "realtime_" + (code ?? "error")
        case .unknown: return "unknown"
        }
    }

    /// 任意のエラー（APIError 等）を音声会話のエラーに変換する
    public static func from(_ error: Error) -> VoiceError {
        if let voice = error as? VoiceError { return voice }
        if let api = error as? APIError { return from(api) }
        return .unknown
    }

    public static func from(_ error: APIError) -> VoiceError {
        switch error {
        case .sessionExpired:
            return .authExpired
        case .network:
            return .connectionFailed
        case .server(let status, let body):
            let message = body?.message
            if body?.code == "voice_unavailable" { return .unavailable(message: message) }
            switch status {
            case 401: return .authExpired
            case 403: return .forbidden(message: message)
            case 429: return .rateLimited(message: message)
            case 503: return .unavailable(message: message)
            case 408, 500...599: return .connectionFailed
            default: return .server(code: body?.code)
            }
        case .decoding, .invalidInput:
            return .unknown
        case .cancelled:
            return .connectionFailed
        }
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }
}

extension VoiceError: LocalizedError {
    public var errorDescription: String? { userMessage }
}
