import XCTest
@testable import HappyAvatarKit

/// Linux の XCTest でも実行できるよう、メインアクターのテストは async にしている
final class HappyAvatarControllerTests: XCTestCase {
    @MainActor func testSpeakingAudioDrivesMouth() async {
        let c = HappyAvatarController()
        c.setSpeaking()
        c.updateAssistantAudioLevel(0.8)
        XCTAssertGreaterThan(c.mouthLevel, 0)
    }

    @MainActor func testSilenceClosesMouth() async {
        let c = HappyAvatarController()
        c.setSpeaking()
        c.updateAssistantAudioLevel(0.01)
        XCTAssertEqual(c.mouthLevel, 0)
    }

    @MainActor func testNoiseFloorIsTreatedAsSilence() async {
        let c = HappyAvatarController()
        c.setSpeaking()
        for _ in 0..<20 { c.updateAssistantAudioLevel(HappyAvatarController.noiseFloor) }
        XCTAssertEqual(c.mouthLevel, 0)
    }

    @MainActor func testAudioIgnoredWhenNotSpeaking() async {
        let c = HappyAvatarController()
        c.setListening()
        c.updateAssistantAudioLevel(1)
        XCTAssertEqual(c.mouthLevel, 0)
        c.setThinking()
        c.updateAssistantAudioLevel(1)
        XCTAssertEqual(c.mouthLevel, 0)
    }

    @MainActor func testSmoothingRisesGraduallyAndConverges() async {
        let c = HappyAvatarController()
        c.setSpeaking()
        c.updateAssistantAudioLevel(1)
        let first = c.mouthLevel
        // 低域通過：最初の 1 回では最大まで開かない
        XCTAssertEqual(first, 1 - HappyAvatarController.smoothing, accuracy: 0.0001)
        c.updateAssistantAudioLevel(1)
        XCTAssertGreaterThan(c.mouthLevel, first)
        for _ in 0..<60 { c.updateAssistantAudioLevel(1) }
        XCTAssertEqual(c.mouthLevel, 1, accuracy: 0.001)
        XCTAssertLessThanOrEqual(c.mouthLevel, 1)
    }

    @MainActor func testSmoothingDecaysToClosed() async {
        let c = HappyAvatarController()
        c.setSpeaking()
        for _ in 0..<30 { c.updateAssistantAudioLevel(1) }
        c.updateAssistantAudioLevel(0)
        XCTAssertGreaterThan(c.mouthLevel, 0, "一気に閉じず、なめらかに閉じる")
        for _ in 0..<30 { c.updateAssistantAudioLevel(0) }
        XCTAssertEqual(c.mouthLevel, 0)
    }

    @MainActor func testOutOfRangeAndNonFiniteLevelsAreClamped() async {
        let c = HappyAvatarController()
        c.setSpeaking()
        for _ in 0..<60 { c.updateAssistantAudioLevel(5) }
        XCTAssertEqual(c.mouthLevel, 1, accuracy: 0.001)
        let d = HappyAvatarController()
        d.setSpeaking()
        d.updateAssistantAudioLevel(-3)
        XCTAssertEqual(d.mouthLevel, 0)
        d.updateAssistantAudioLevel(.nan)
        XCTAssertEqual(d.mouthLevel, 0)
        d.updateAssistantAudioLevel(.infinity)
        XCTAssertEqual(d.mouthLevel, 0)
    }

    @MainActor func testInterruptionReturnsToListeningAndClosesMouth() async {
        let c = HappyAvatarController()
        c.setSpeaking()
        c.updateAssistantAudioLevel(0.8)
        c.interruptAssistant()
        XCTAssertEqual(c.state, .listening)
        XCTAssertEqual(c.mouthLevel, 0)
        // 次の回答は平滑化の履歴を持ち越さない
        c.setSpeaking()
        c.updateAssistantAudioLevel(1)
        XCTAssertEqual(c.mouthLevel, 1 - HappyAvatarController.smoothing, accuracy: 0.0001)
    }

    @MainActor func testThinkingLooksUpAndSpeakingClearsThinkingEmotion() async {
        let c = HappyAvatarController()
        c.setThinking()
        XCTAssertEqual(c.emotion, .thinking)
        XCTAssertLessThan(c.lookY, 0)
        c.setSpeaking()
        XCTAssertEqual(c.emotion, .neutral)
        XCTAssertEqual(c.lookY, 0)
    }

    @MainActor func testSpeakingKeepsDomainEmotion() async {
        let c = HappyAvatarController()
        c.setEmotion(.excited)
        c.setSpeaking()
        XCTAssertEqual(c.emotion, .excited)
    }

    @MainActor func testLookAtClamps() async {
        let c = HappyAvatarController()
        c.lookAt(x: 3, y: -3)
        XCTAssertEqual(c.lookX, 1)
        XCTAssertEqual(c.lookY, -1)
    }

    @MainActor func testBlinkEndsWithEyesOpen() async {
        let c = HappyAvatarController()
        await c.blink()
        XCTAssertEqual(c.eyeOpen, 1)
    }

    @MainActor func testReset() async {
        let c = HappyAvatarController()
        c.setSpeaking()
        c.updateAssistantAudioLevel(1)
        c.lookAt(x: 0.5, y: 0.5)
        c.setError()
        c.reset()
        XCTAssertEqual(c.state, .idle)
        XCTAssertEqual(c.emotion, .neutral)
        XCTAssertEqual(c.mouthLevel, 0)
        XCTAssertEqual(c.eyeOpen, 1)
        XCTAssertEqual(c.lookX, 0)
        XCTAssertEqual(c.lookY, 0)
        XCTAssertEqual(c.tailMotion, 0.18)
        XCTAssertEqual(c.bodyBounce, 0.08)
    }

    @MainActor func testStatusTextsAreJapanese() async {
        XCTAssertEqual(HappyAvatarState.idle.statusText, "お話しください")
        XCTAssertEqual(HappyAvatarState.speaking.statusText, "回答中")
        XCTAssertEqual(HappyAvatarState.speaking.accessibilityLabel, "Happy AI、回答中")
        XCTAssertEqual(HappyAvatarState.error.statusText, "接続できませんでした")
    }
}

final class HappyVoiceAvatarBridgeTests: XCTestCase {
    @MainActor private func make() -> (HappyAvatarController, HappyVoiceAvatarBridge) {
        let c = HappyAvatarController()
        return (c, HappyVoiceAvatarBridge(controller: c))
    }

    @MainActor func testIdle() async {
        let (c, b) = make()
        c.setError()
        b.handle(.idle)
        XCTAssertEqual(c.state, .idle)
        XCTAssertEqual(c.emotion, .neutral)
    }

    @MainActor func testConnectingClearsPreviousError() async {
        let (c, b) = make()
        b.handle(.failed)
        b.handle(.connecting)
        XCTAssertEqual(c.state, .idle)
        XCTAssertEqual(c.emotion, .neutral)
    }

    @MainActor func testUserSpeechStartedListens() async {
        let (c, b) = make()
        b.handle(.assistantSpeechStarted)
        b.handle(.assistantAudioLevel(0.9))
        b.handle(.userSpeechStarted)
        XCTAssertEqual(c.state, .listening)
        XCTAssertEqual(c.mouthLevel, 0)
    }

    @MainActor func testUserSpeechEndedAndAssistantThinkingThink() async {
        let (c, b) = make()
        b.handle(.userSpeechEnded)
        XCTAssertEqual(c.state, .thinking)
        b.handle(.idle)
        b.handle(.assistantThinking)
        XCTAssertEqual(c.state, .thinking)
        XCTAssertEqual(c.emotion, .thinking)
    }

    @MainActor func testAssistantSpeechAndAudioLevel() async {
        let (c, b) = make()
        b.handle(.assistantSpeechStarted)
        XCTAssertEqual(c.state, .speaking)
        b.handle(.assistantAudioLevel(0.9))
        XCTAssertGreaterThan(c.mouthLevel, 0)
    }

    @MainActor func testAudioLevelBeforeSpeechDoesNotOpenMouth() async {
        let (c, b) = make()
        b.handle(.assistantAudioLevel(0.9))
        XCTAssertEqual(c.mouthLevel, 0)
    }

    @MainActor func testInterruptionResetsMouthImmediately() async {
        let (c, b) = make()
        b.handle(.assistantSpeechStarted)
        for _ in 0..<10 { b.handle(.assistantAudioLevel(1)) }
        XCTAssertGreaterThan(c.mouthLevel, 0.5)
        b.handle(.assistantInterrupted)
        XCTAssertEqual(c.mouthLevel, 0)
        XCTAssertEqual(c.state, .listening)
        // 割り込み後に遅れて届いた音量では口が開かない
        b.handle(.assistantAudioLevel(1))
        XCTAssertEqual(c.mouthLevel, 0)
    }

    @MainActor func testReconnectingAndRecovered() async {
        let (c, b) = make()
        b.handle(.reconnecting)
        XCTAssertEqual(c.state, .reconnecting)
        XCTAssertEqual(c.emotion, .concerned)
        b.handle(.connectionRecovered)
        XCTAssertEqual(c.state, .idle)
        XCTAssertEqual(c.emotion, .happy, "回復したら喜ぶ（setIdle で打ち消されない）")
    }

    @MainActor func testFailed() async {
        let (c, b) = make()
        b.handle(.assistantSpeechStarted)
        b.handle(.assistantAudioLevel(1))
        b.handle(.failed)
        XCTAssertEqual(c.state, .error)
        XCTAssertEqual(c.emotion, .concerned)
        XCTAssertEqual(c.mouthLevel, 0)
    }

    @MainActor func testEndedResets() async {
        let (c, b) = make()
        b.handle(.assistantSpeechStarted)
        b.handle(.assistantAudioLevel(1))
        b.handleHappyDriveEvent(.nearbyJob)
        b.handle(.ended)
        XCTAssertEqual(c.state, .idle)
        XCTAssertEqual(c.emotion, .neutral)
        XCTAssertEqual(c.mouthLevel, 0)
    }

    @MainActor func testDomainEventEmotions() async {
        let expected: [HappyDriveAvatarEvent: HappyAvatarEmotion] = [
            .nearbyJob: .excited,
            .jobAccepted: .happy,
            .deliveryCompleted: .happy,
            .routeRecalculation: .thinking,
            .destinationApproaching: .surprised,
            .connectionProblem: .concerned,
        ]
        XCTAssertEqual(Set(expected.keys), Set(HappyDriveAvatarEvent.allCases))
        for (event, emotion) in expected {
            let (c, b) = make()
            b.handleHappyDriveEvent(event)
            XCTAssertEqual(c.emotion, emotion, "\(event)")
            XCTAssertEqual(event.emotion, emotion)
            XCTAssertEqual(c.state, .idle, "業務イベントは会話の状態を変えない")
        }
    }

    @MainActor func testDomainEmotionClearedWhenListeningAgain() async {
        let (c, b) = make()
        b.handleHappyDriveEvent(.jobAccepted)
        b.handle(.userSpeechStarted)
        XCTAssertEqual(c.emotion, .neutral)
    }
}
