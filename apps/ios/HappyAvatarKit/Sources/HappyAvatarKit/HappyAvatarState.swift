import Foundation

public enum HappyAvatarState: Equatable, Sendable {
    case idle
    case listening
    case thinking
    case speaking
    case reconnecting
    case error

    /// 日本語の状態表示（画面の文言・読み上げに使う）
    public var statusText: String {
        switch self {
        case .idle: return "お話しください"
        case .listening: return "聞いています"
        case .thinking: return "考えています…"
        case .speaking: return "回答中"
        case .reconnecting: return "再接続中…"
        case .error: return "接続できませんでした"
        }
    }

    /// VoiceOver 用のラベル
    public var accessibilityLabel: String {
        switch self {
        case .idle: return "Happy AI"
        case .listening: return "Happy AI、聞いています"
        case .thinking: return "Happy AI、考えています"
        case .speaking: return "Happy AI、回答中"
        case .reconnecting: return "Happy AI、再接続中"
        case .error: return "Happy AI、接続エラー"
        }
    }
}

public enum HappyAvatarEmotion: Int, CaseIterable, Sendable {
    case neutral = 0
    case happy = 1
    case excited = 2
    case thinking = 3
    case concerned = 4
    case sleepy = 5
    case surprised = 6
}

public enum HappyAvatarPresentationMode: Sendable {
    /// 全画面の音声モード
    case full
    /// 地図・ナビの上に重ねる小さな吹き出し
    case mini
    /// 運転中（動きを控えめにし、少し大きく表示）
    case driving
}
