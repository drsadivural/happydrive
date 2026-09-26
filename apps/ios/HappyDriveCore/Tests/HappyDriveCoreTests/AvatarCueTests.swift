import XCTest
@testable import HappyDriveCore

final class AvatarCueTests: XCTestCase {
    private func cue(_ old: VoiceConversationState, _ new: VoiceConversationState) -> AvatarCue? {
        AvatarCue.transition(from: old, to: new)
    }

    func testStartingMapsToConnectingOnce() {
        XCTAssertEqual(cue(.idle, .requestingPermission), .connecting)
        XCTAssertEqual(cue(.disconnected, .requestingPermission), .connecting)
        XCTAssertEqual(cue(.error(.connectionFailed), .requestingPermission), .connecting)
        // 権限確認 → 接続は同じ「接続中」
        XCTAssertNil(cue(.requestingPermission, .connecting))
        XCTAssertNil(cue(.connecting, .connecting))
    }

    func testListeningMapsToIdle() {
        XCTAssertEqual(cue(.connecting, .listening), .idle)
        XCTAssertEqual(cue(.assistantSpeaking, .listening), .idle)
        XCTAssertEqual(cue(.thinking, .listening), .idle)
        XCTAssertNil(cue(.listening, .listening))
    }

    func testConversationStates() {
        XCTAssertEqual(cue(.listening, .userSpeaking), .userSpeechStarted)
        XCTAssertEqual(cue(.assistantSpeaking, .userSpeaking), .userSpeechStarted)
        XCTAssertEqual(cue(.userSpeaking, .thinking), .assistantThinking)
        XCTAssertEqual(cue(.listening, .thinking), .assistantThinking)
        XCTAssertEqual(cue(.thinking, .assistantSpeaking), .assistantSpeechStarted)
        XCTAssertEqual(cue(.listening, .assistantSpeaking), .assistantSpeechStarted)
        XCTAssertNil(cue(.userSpeaking, .userSpeaking))
        XCTAssertNil(cue(.thinking, .thinking))
        XCTAssertNil(cue(.assistantSpeaking, .assistantSpeaking))
    }

    func testReconnectAndRecovery() {
        XCTAssertEqual(cue(.assistantSpeaking, .reconnecting(attempt: 1)), .reconnecting)
        XCTAssertNil(cue(.reconnecting(attempt: 1), .reconnecting(attempt: 2)), "試行回数の変化では繰り返さない")
        XCTAssertEqual(cue(.reconnecting(attempt: 2), .listening), .connectionRecovered)
    }

    func testErrorAndEnd() {
        XCTAssertEqual(cue(.connecting, .error(.connectionFailed)), .failed)
        XCTAssertEqual(cue(.reconnecting(attempt: 3), .error(.connectionLost)), .failed)
        XCTAssertNil(cue(.error(.connectionLost), .error(.connectionFailed)))
        XCTAssertEqual(cue(.listening, .disconnected), .ended)
        XCTAssertEqual(cue(.assistantSpeaking, .idle), .ended)
        XCTAssertEqual(cue(.error(.connectionLost), .idle), .ended)
        XCTAssertNil(cue(.disconnected, .idle))
        XCTAssertNil(cue(.idle, .idle))
    }

    /// 状態機械が出すすべての遷移で、同じ状態への遷移はキューを出さない
    func testSameStateNeverEmitsCue() {
        let all: [VoiceConversationState] = [
            .idle, .requestingPermission, .connecting, .listening, .userSpeaking, .thinking, .assistantSpeaking,
            .reconnecting(attempt: 1), .disconnected, .error(.connectionLost),
        ]
        for s in all {
            XCTAssertNil(cue(s, s), "\(s)")
        }
    }

    /// 実際の会話の流れ（状態機械 → キュー）
    func testFullConversationSequence() {
        let events: [VoiceEvent] = [
            .startRequested, .permissionGranted, .sessionIssued, .connected,
            .speechStarted, .speechStopped, .responseCreated, .assistantAudioStarted,
            .speechStarted, // バージイン
            .speechStopped, .assistantAudioStarted, .assistantAudioStopped,
            .networkLost, .reconnectFailed(exhausted: false), .reconnectSucceeded,
            .endRequested,
        ]
        var state = VoiceConversationState.idle
        var cues: [AvatarCue] = []
        for event in events {
            let next = VoiceStateMachine.reduce(state, event)
            if let c = AvatarCue.transition(from: state, to: next) { cues.append(c) }
            state = next
        }
        XCTAssertEqual(cues, [
            .connecting, .idle,
            .userSpeechStarted, .assistantThinking, .assistantSpeechStarted,
            .userSpeechStarted,
            .assistantThinking, .assistantSpeechStarted, .idle,
            .reconnecting, .connectionRecovered,
            .ended,
        ])
    }
}

final class VoiceLevelMeterTests: XCTestCase {
    func testNormalizationMatchesSpectrumMapping() {
        XCTAssertEqual(VoiceLevelMeter.normalized(1), 1, accuracy: 1e-9)
        XCTAssertEqual(VoiceLevelMeter.normalized(0.1), 0.6, accuracy: 1e-9)       // -20dB
        XCTAssertEqual(VoiceLevelMeter.normalized(0.01), 0.2, accuracy: 1e-9)      // -40dB
        XCTAssertEqual(VoiceLevelMeter.normalized(0.00316227766), 0, accuracy: 1e-6) // -50dB
    }

    func testNormalizationClampsAndRejectsInvalid() {
        XCTAssertEqual(VoiceLevelMeter.normalized(0), 0)
        XCTAssertEqual(VoiceLevelMeter.normalized(0.00005), 0)
        XCTAssertEqual(VoiceLevelMeter.normalized(0.001), 0, "-60dB は下限で 0")
        XCTAssertEqual(VoiceLevelMeter.normalized(-1), 0)
        XCTAssertEqual(VoiceLevelMeter.normalized(4), 1)
        XCTAssertEqual(VoiceLevelMeter.normalized(.nan), 0)
        XCTAssertEqual(VoiceLevelMeter.normalized(.infinity), 0)
    }

    func testNormalizationIsMonotonic() {
        var previous = -1.0
        for i in 0...1000 {
            let v = VoiceLevelMeter.normalized(Double(i) / 1000)
            XCTAssertGreaterThanOrEqual(v, previous)
            previous = v
        }
    }

    func testPollIntervalFasterOnlyWhileAssistantSpeaks() {
        XCTAssertEqual(VoiceLevelMeter.pollInterval(for: .assistantSpeaking), 33_000_000)
        for s: VoiceConversationState in [.listening, .userSpeaking, .thinking, .connecting, .reconnecting(attempt: 1), .idle] {
            XCTAssertEqual(VoiceLevelMeter.pollInterval(for: s), 80_000_000, "\(s)")
        }
    }

    func testPollIntervalNeverExceeds60Hz() {
        let all: [VoiceConversationState] = [.idle, .listening, .userSpeaking, .thinking, .assistantSpeaking, .disconnected]
        for s in all {
            XCTAssertGreaterThanOrEqual(VoiceLevelMeter.pollInterval(for: s), VoiceLevelMeter.minimumIntervalNanos)
        }
        XCTAssertGreaterThanOrEqual(VoiceLevelMeter.minimumIntervalNanos, 1_000_000_000 / 60)
    }
}

final class AvatarDomainSignalTests: XCTestCase {
    func testSearchJobsWithResults() {
        XCTAssertTrue(AvatarDomainSignal.containsJobs(toolName: "search_jobs", output: #"{"count":2,"hasMore":false,"jobs":[{},{}]}"#))
        XCTAssertTrue(AvatarDomainSignal.containsJobs(toolName: "search_jobs", output: #"{"jobs":[{"jobId":"a"}]}"#))
    }

    func testSearchJobsEmptyOrError() {
        XCTAssertFalse(AvatarDomainSignal.containsJobs(toolName: "search_jobs", output: #"{"count":0,"hasMore":false,"jobs":[]}"#))
        XCTAssertFalse(AvatarDomainSignal.containsJobs(toolName: "search_jobs", output: #"{"error":{"code":"timeout","message":"x"}}"#))
        XCTAssertFalse(AvatarDomainSignal.containsJobs(toolName: "search_jobs", output: "not json"))
    }

    func testTodayOverviewNearbyJobs() {
        XCTAssertTrue(AvatarDomainSignal.containsJobs(toolName: "get_today_overview", output: #"{"date":"2026-09-26","nearbyJobs":[{"jobId":"a"}]}"#))
        XCTAssertFalse(AvatarDomainSignal.containsJobs(toolName: "get_today_overview", output: #"{"date":"2026-09-26","nearbyJobs":[]}"#))
        XCTAssertFalse(AvatarDomainSignal.containsJobs(toolName: "get_today_overview", output: #"{"date":"2026-09-26"}"#))
    }

    func testOtherToolsNeverSignal() {
        XCTAssertFalse(AvatarDomainSignal.containsJobs(toolName: "get_job_details", output: #"{"count":3,"jobs":[{}]}"#))
        XCTAssertFalse(AvatarDomainSignal.containsJobs(toolName: "unknown_tool", output: #"{"count":3}"#))
    }

    /// 実際の出力形式（VoiceToolDispatcher が返す JSON）で判定できる
    func testRealDispatcherOutputShape() throws {
        struct Out: Encodable { let count: Int; let jobs: [String]; let hasMore: Bool }
        let json = try VoiceToolDispatcher.encode(Out(count: 1, jobs: ["x"], hasMore: false))
        XCTAssertTrue(AvatarDomainSignal.containsJobs(toolName: VoiceToolName.search_jobs.rawValue, output: json))
    }
}

final class DestinationApproachTrackerTests: XCTestCase {
    private let destination = GeoPoint(latitude: 35.6812, longitude: 139.7671)

    private func stop(_ id: String, _ status: StopStatus, _ location: GeoPoint?) -> Stop {
        Stop(id: id, status: status, address: "東京都千代田区丸の内1-1", scheduledDate: "2026-09-26", location: location, hasLocation: location != nil)
    }

    /// 緯度方向に約 `meters` 離れた点
    private func point(northOf p: GeoPoint, meters: Double) -> GeoPoint {
        GeoPoint(latitude: p.latitude + meters / 111_195, longitude: p.longitude)
    }

    func testFiresOnceWithin200m() {
        var tracker = DestinationApproachTracker()
        let stops = [stop("s1", .en_route, destination)]
        XCTAssertNil(tracker.update(stops: stops, current: point(northOf: destination, meters: 500), routeInProgress: true))
        XCTAssertEqual(tracker.update(stops: stops, current: point(northOf: destination, meters: 150), routeInProgress: true), "s1")
        XCTAssertNil(tracker.update(stops: stops, current: point(northOf: destination, meters: 50), routeInProgress: true), "同じ配送先では 1 回だけ")
        XCTAssertNil(tracker.update(stops: stops, current: point(northOf: destination, meters: 500), routeInProgress: true))
        XCTAssertNil(tracker.update(stops: stops, current: point(northOf: destination, meters: 100), routeInProgress: true), "離れて戻っても繰り返さない")
    }

    func testBoundaryAt200m() {
        var tracker = DestinationApproachTracker()
        let stops = [stop("s1", .en_route, destination)]
        XCTAssertNil(tracker.update(stops: stops, current: point(northOf: destination, meters: 205), routeInProgress: true))
        XCTAssertEqual(tracker.update(stops: stops, current: point(northOf: destination, meters: 195), routeInProgress: true), "s1")
    }

    func testOnlyEnRouteStopsWhileRouteInProgress() {
        var tracker = DestinationApproachTracker()
        let near = point(northOf: destination, meters: 10)
        XCTAssertNil(tracker.update(stops: [stop("s1", .en_route, destination)], current: near, routeInProgress: false))
        for status: StopStatus in [.draft, .ready, .arrived, .delivered, .failed, .deferred, .unknown] {
            XCTAssertNil(tracker.update(stops: [stop("x-\(status)", status, destination)], current: near, routeInProgress: true), "\(status)")
        }
        XCTAssertNil(tracker.update(stops: [stop("nolocation", .en_route, nil)], current: near, routeInProgress: true))
    }

    func testEachStopFiresSeparatelyAndResetAllowsAgain() {
        var tracker = DestinationApproachTracker()
        let second = point(northOf: destination, meters: 2_000)
        let stops = [stop("s1", .en_route, destination), stop("s2", .en_route, second)]
        XCTAssertEqual(tracker.update(stops: stops, current: destination, routeInProgress: true), "s1")
        XCTAssertEqual(tracker.update(stops: stops, current: second, routeInProgress: true), "s2")
        XCTAssertNil(tracker.update(stops: stops, current: second, routeInProgress: true))
        tracker.reset()
        XCTAssertEqual(tracker.update(stops: stops, current: second, routeInProgress: true), "s2")
    }
}
