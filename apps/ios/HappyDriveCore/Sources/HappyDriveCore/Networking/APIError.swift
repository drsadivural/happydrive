import Foundation

/// API 呼び出しの失敗。画面には `userMessage`（日本語）を表示する。
public enum APIError: Error, Sendable, Hashable {
    /// サーバーがエラー応答を返した（status と契約 Error 本文）
    case server(status: Int, body: APIErrorBody?)
    /// 通信できなかった（圏外・タイムアウト等）
    case network(description: String)
    /// ログインの有効期限切れ（リフレッシュも失敗）
    case sessionExpired
    /// 応答の形式が契約と異なる
    case decoding(description: String)
    /// 送信前の検証エラー（画面に表示する日本語）
    case invalidInput(message: String)
    case cancelled

    public var status: Int? {
        if case .server(let status, _) = self { return status }
        return nil
    }

    /// 契約 Error.code（例 capacity_full / not_eligible / terms_changed）
    public var code: String? {
        if case .server(_, let body) = self { return body?.code }
        return nil
    }

    public var requestId: String? {
        if case .server(_, let body) = self { return body?.requestId }
        return nil
    }

    public var details: [String: JSONValue]? {
        if case .server(_, let body) = self { return body?.details }
        return nil
    }

    public var isNetworkError: Bool {
        if case .network = self { return true }
        return false
    }

    /// 再送すれば成功する可能性がある失敗（オフラインキューで保持する）
    public var isRetryable: Bool {
        switch self {
        case .network: return true
        case .sessionExpired: return true // 再ログイン後に再送する
        case .server(let status, _): return Self.isRetryableStatus(status)
        default: return false
        }
    }

    public static func isRetryableStatus(_ status: Int) -> Bool {
        status == 408 || status == 429 || status >= 500
    }

    /// 利用者に表示する日本語メッセージ。サーバーの日本語 message を優先する。
    public var userMessage: String {
        switch self {
        case .server(let status, let body):
            if let message = body?.message, !message.isEmpty { return message }
            return Self.fallbackMessage(status: status)
        case .network:
            return "通信できませんでした。電波の良い場所で再度お試しください。"
        case .sessionExpired:
            return "ログインの有効期限が切れました。もう一度ログインしてください。"
        case .decoding:
            return "サーバーの応答を読み取れませんでした。アプリを最新版に更新してください。"
        case .invalidInput(let message):
            return message
        case .cancelled:
            return "操作を中止しました。"
        }
    }

    public static func fallbackMessage(status: Int) -> String {
        switch status {
        case 400: return "入力内容を確認してください。"
        case 401: return "ログインが必要です。"
        case 403: return "この操作を行う権限がありません。"
        case 404: return "対象が見つかりませんでした。"
        case 408: return "通信がタイムアウトしました。再度お試しください。"
        case 409: return "他の操作と競合しました。最新の情報を読み込んでください。"
        case 410: return "保管期限が過ぎたため表示できません。"
        case 413: return "ファイルが大きすぎます。"
        case 422: return "入力内容または業務の条件を満たしていません。"
        case 429: return "操作回数の上限に達しました。しばらく待ってから再度お試しください。"
        case 500...599: return "サーバーで問題が発生しました。時間をおいて再度お試しください。"
        default: return "エラーが発生しました（\(status)）。"
        }
    }
}

extension APIError: LocalizedError {
    public var errorDescription: String? { userMessage }
}

extension Error {
    /// 任意のエラーを利用者向け日本語に変換
    public var hdUserMessage: String {
        if let api = self as? APIError { return api.userMessage }
        if self is CancellationError { return APIError.cancelled.userMessage }
        return "エラーが発生しました。再度お試しください。"
    }
}
