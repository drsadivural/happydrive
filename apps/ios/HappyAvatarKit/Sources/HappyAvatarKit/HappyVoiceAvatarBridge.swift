import Foundation

/// 音声会話の出来事（Realtime / WebRTC 側の状態をアバター向けにまとめたもの）
public enum HappyVoiceConversationEvent: Sendable, Equatable {
    case idle
    case connecting
    case userSpeechStarted
    case userSpeechEnded
    case assistantThinking
    case assistantSpeechStarted
    /// 回答音声の音量（0〜1 に正規化済み）。30〜60Hz 以下に間引いて送る
    case assistantAudioLevel(Double)
    case assistantInterrupted
    case reconnecting
    case connectionRecovered
    case failed
    case ended
}

/// 会話の出来事・HappyDrive の業務イベントをアバターの状態に変換する（状態機械は持たない）
@MainActor
public final class HappyVoiceAvatarBridge {
    private let controller: HappyAvatarController

    public init(controller: HappyAvatarController) {
        self.controller = controller
    }

    public func handle(_ event: HappyVoiceConversationEvent) {
        switch event {
        case .idle:
            controller.setIdle()
        case .connecting:
            // 前回のエラー表示などを残さず、落ち着いた待機の姿に戻す
            controller.setIdle()
        case .userSpeechStarted:
            controller.interruptAssistant()
        case .userSpeechEnded, .assistantThinking:
            controller.setThinking()
        case .assistantSpeechStarted:
            controller.setSpeaking()
        case let .assistantAudioLevel(level):
            controller.updateAssistantAudioLevel(CGFloat(level))
        case .assistantInterrupted:
            controller.interruptAssistant()
        case .reconnecting:
            controller.setReconnecting()
        case .connectionRecovered:
            // 待機に戻してから喜ぶ（setIdle は感情を neutral に戻すため順番が重要）
            controller.setIdle()
            controller.setEmotion(.happy)
        case .failed:
            controller.setError()
        case .ended:
            controller.reset()
        }
    }

    public func handleHappyDriveEvent(_ event: HappyDriveAvatarEvent) {
        controller.setEmotion(event.emotion)
    }
}

/// HappyDrive の業務イベント（アバターの感情だけを変える）
public enum HappyDriveAvatarEvent: Sendable, CaseIterable, Equatable {
    case nearbyJob
    case jobAccepted
    case deliveryCompleted
    case routeRecalculation
    case destinationApproaching
    case connectionProblem

    /// イベントに対応する感情
    public var emotion: HappyAvatarEmotion {
        switch self {
        case .nearbyJob: return .excited
        case .jobAccepted, .deliveryCompleted: return .happy
        case .routeRecalculation: return .thinking
        case .destinationApproaching: return .surprised
        case .connectionProblem: return .concerned
        }
    }
}
