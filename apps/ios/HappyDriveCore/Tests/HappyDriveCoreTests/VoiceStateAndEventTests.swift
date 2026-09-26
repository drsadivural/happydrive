import XCTest
@testable import HappyDriveCore

final class VoiceStateMachineTests: XCTestCase {
    private func run(_ events: [VoiceEvent], from state: VoiceConversationState = .idle) -> [VoiceConversationState] {
        var s = state
        var out: [VoiceConversationState] = []
        for e in events {
            s = VoiceStateMachine.reduce(s, e)
            out.append(s)
        }
        return out
    }

    func testHappyPathVoiceTurn() {
        let states = run([.startRequested, .permissionGranted, .sessionIssued, .connected, .speechStarted, .speechStopped, .responseCreated, .assistantAudioStarted, .responseDone, .assistantAudioStopped])
        XCTAssertEqual(states, [.requestingPermission, .connecting, .connecting, .listening, .userSpeaking, .thinking, .thinking, .assistantSpeaking, .assistantSpeaking, .listening])
    }

    func testPermissionDeniedStillConnectsForTextMode() {
        XCTAssertEqual(run([.startRequested, .permissionDenied, .connected]), [.requestingPermission, .connecting, .listening])
    }

    func testBargeInWhileAssistantSpeaking() {
        let s = run([.speechStarted, .assistantAudioStopped, .speechStopped], from: .assistantSpeaking)
        XCTAssertEqual(s, [.userSpeaking, .userSpeaking, .thinking], "割り込みで userSpeaking に移り、再生停止では戻らない")
        XCTAssertEqual(VoiceStateMachine.reduce(.thinking, .speechStarted), .userSpeaking)
    }

    func testTextOnlyResponseReturnsToListening() {
        XCTAssertEqual(run([.responseCreated, .responseDone], from: .listening), [.thinking, .listening])
    }

    func testReconnectSucceeds() {
        XCTAssertEqual(run([.networkLost, .reconnectFailed(exhausted: false), .reconnectSucceeded], from: .assistantSpeaking),
                       [.reconnecting(attempt: 1), .reconnecting(attempt: 2), .listening])
        XCTAssertEqual(VoiceStateMachine.reduce(.reconnecting(attempt: 2), .connected), .listening)
    }

    func testReconnectExhaustedIsConnectionLost() {
        let s = run([.networkLost, .reconnectFailed(exhausted: false), .reconnectFailed(exhausted: false), .reconnectFailed(exhausted: true)], from: .listening)
        XCTAssertEqual(s.last, .error(.connectionLost))
        XCTAssertEqual(s.last?.error?.endReason, .reconnect_exhausted)
    }

    func testNetworkLostWhileConnectingIsConnectionFailed() {
        XCTAssertEqual(VoiceStateMachine.reduce(.connecting, .networkLost), .error(.connectionFailed))
    }

    func testEndFromAnyActiveStateDisconnects() {
        for state: VoiceConversationState in [.requestingPermission, .connecting, .listening, .userSpeaking, .thinking, .assistantSpeaking, .reconnecting(attempt: 2)] {
            let next = VoiceStateMachine.reduce(state, .endRequested)
            XCTAssertEqual(next, .disconnected, "\(state)")
            XCTAssertFalse(next.isActive)
            XCTAssertFalse(next.isConnected)
        }
        XCTAssertEqual(VoiceStateMachine.reduce(.idle, .endRequested), .idle)
        XCTAssertEqual(VoiceStateMachine.reduce(.error(.connectionFailed), .endRequested), .error(.connectionFailed))
    }

    func testRestartAfterEndOrError() {
        XCTAssertEqual(VoiceStateMachine.reduce(.disconnected, .startRequested), .requestingPermission)
        XCTAssertEqual(VoiceStateMachine.reduce(.error(.unavailable(message: nil)), .startRequested), .requestingPermission)
        XCTAssertEqual(VoiceStateMachine.reduce(.listening, .startRequested), .listening, "会話中の再開始は無視")
    }

    func testFatalAndIgnoredTransitions() {
        XCTAssertEqual(VoiceStateMachine.reduce(.thinking, .fatal(.rateLimited(message: nil))), .error(.rateLimited(message: nil)))
        XCTAssertEqual(VoiceStateMachine.reduce(.idle, .fatal(.unknown)), .idle)
        XCTAssertEqual(VoiceStateMachine.reduce(.disconnected, .speechStarted), .disconnected)
        XCTAssertEqual(VoiceStateMachine.reduce(.connecting, .speechStarted), .connecting)
        XCTAssertEqual(VoiceStateMachine.reduce(.listening, .reconnectSucceeded), .listening)
        XCTAssertEqual(VoiceStateMachine.reduce(.listening, .reconnectFailed(exhausted: true)), .listening)
    }

    func testStatusTextIsJapaneseForEveryState() {
        XCTAssertEqual(VoiceConversationState.connecting.statusText, "接続中…")
        XCTAssertEqual(VoiceConversationState.listening.statusText, "お話しください")
        XCTAssertEqual(VoiceConversationState.userSpeaking.statusText, "聞いています")
        XCTAssertEqual(VoiceConversationState.thinking.statusText, "考えています…")
        XCTAssertEqual(VoiceConversationState.assistantSpeaking.statusText, "回答中")
        XCTAssertEqual(VoiceConversationState.reconnecting(attempt: 1).statusText, "再接続中…")
        XCTAssertEqual(VoiceConversationState.error(.connectionFailed).statusText, "接続できませんでした")
    }
}

final class RealtimeEventParserTests: XCTestCase {
    private func p(_ s: String) -> RealtimeServerEvent { RealtimeEventParser.parse(s) }

    func testSessionAndInputEvents() {
        XCTAssertEqual(p(#"{"type":"session.created","session":{}}"#), .sessionCreated)
        XCTAssertEqual(p(#"{"type":"session.updated"}"#), .sessionUpdated)
        XCTAssertEqual(p(#"{"type":"input_audio_buffer.speech_started","item_id":"u1","audio_start_ms":1}"#), .speechStarted(itemId: "u1", audioStartMs: 1))
        XCTAssertEqual(p(#"{"type":"input_audio_buffer.speech_stopped","item_id":"u1","audio_end_ms":2300}"#), .speechStopped(itemId: "u1", audioEndMs: 2300))
        XCTAssertEqual(p(#"{"type":"input_audio_buffer.committed","item_id":"u1","previous_item_id":null}"#), .inputAudioCommitted(itemId: "u1"))
        XCTAssertEqual(p(#"{"type":"conversation.item.input_audio_transcription.delta","item_id":"u1","delta":"今日の"}"#), .inputTranscriptionDelta(itemId: "u1", delta: "今日の"))
        XCTAssertEqual(p(#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"u1","transcript":"今日の予定は？"}"#), .inputTranscriptionCompleted(itemId: "u1", transcript: "今日の予定は？"))
        XCTAssertEqual(p(#"{"type":"conversation.item.input_audio_transcription.failed","item_id":"u1"}"#), .inputTranscriptionFailed(itemId: "u1"))
    }

    func testConversationItemEvents() {
        XCTAssertEqual(p(#"{"type":"conversation.item.added","item":{"id":"i1","type":"message","role":"user","status":"completed"}}"#),
                       .itemAdded(RealtimeItemInfo(id: "i1", type: "message", role: "user", status: "completed")))
        XCTAssertEqual(p(#"{"type":"conversation.item.done","item":{"id":"i2","type":"function_call","call_id":"c1","name":"search_jobs","arguments":"{}"}}"#),
                       .itemDone(RealtimeItemInfo(id: "i2", type: "function_call", callId: "c1", name: "search_jobs", arguments: "{}")))
    }

    func testResponseEvents() {
        XCTAssertEqual(p(#"{"type":"response.created","response":{"id":"r1","status":"in_progress"}}"#), .responseCreated(responseId: "r1"))
        XCTAssertEqual(p(#"{"type":"response.output_audio_transcript.delta","response_id":"r1","item_id":"a1","delta":"はい"}"#), .outputAudioTranscriptDelta(itemId: "a1", responseId: "r1", delta: "はい"))
        XCTAssertEqual(p(#"{"type":"response.output_audio_transcript.done","response_id":"r1","item_id":"a1","transcript":"はい、どうぞ"}"#), .outputAudioTranscriptDone(itemId: "a1", responseId: "r1", transcript: "はい、どうぞ"))
        XCTAssertEqual(p(#"{"type":"response.output_text.delta","item_id":"a2","delta":"本日"}"#), .outputTextDelta(itemId: "a2", responseId: nil, delta: "本日"))
        XCTAssertEqual(p(#"{"type":"response.output_text.done","item_id":"a2","text":"本日は3件です"}"#), .outputTextDone(itemId: "a2", responseId: nil, text: "本日は3件です"))
        XCTAssertEqual(p(#"{"type":"response.function_call_arguments.delta","call_id":"c1","delta":"{\"da"}"#), .functionCallArgumentsDelta(callId: "c1", delta: #"{"da"#))
        XCTAssertEqual(p(#"{"type":"response.function_call_arguments.done","response_id":"r1","item_id":"f1","call_id":"c1","name":"list_delivery_stops","arguments":"{\"date\":\"2026-09-26\"}"}"#),
                       .functionCallArgumentsDone(RealtimeFunctionCall(callId: "c1", name: "list_delivery_stops", arguments: #"{"date":"2026-09-26"}"#, itemId: "f1", responseId: "r1")))
        XCTAssertEqual(p(#"{"type":"response.output_item.done","response_id":"r1","item":{"id":"a1","type":"message","role":"assistant"}}"#),
                       .outputItemDone(RealtimeItemInfo(id: "a1", type: "message", role: "assistant"), responseId: "r1"))
    }

    func testResponseDoneIncludesFunctionCalls() {
        let json = #"{"type":"response.done","response":{"id":"r9","status":"completed","output":[{"id":"f1","type":"function_call","call_id":"c1","name":"get_today_overview","arguments":"{}"},{"id":"m1","type":"message","role":"assistant"}]}}"#
        XCTAssertEqual(p(json), .responseDone(RealtimeResponseSummary(id: "r9", status: "completed", functionCalls: [
            RealtimeFunctionCall(callId: "c1", name: "get_today_overview", arguments: "{}", itemId: "f1", responseId: "r9"),
        ])))
        let cancelled = #"{"type":"response.done","response":{"id":"r2","status":"cancelled","status_details":{"type":"cancelled","reason":"turn_detected"},"output":[]}}"#
        XCTAssertEqual(p(cancelled), .responseDone(RealtimeResponseSummary(id: "r2", status: "cancelled", statusReason: "turn_detected")))
    }

    func testOutputAudioBufferEventsBothSpellings() {
        XCTAssertEqual(p(#"{"type":"output_audio_buffer.started","response_id":"r1"}"#), .outputAudioStarted(responseId: "r1"))
        XCTAssertEqual(p(#"{"type":"output_audio_buffer.speech_started","response_id":"r1"}"#), .outputAudioStarted(responseId: "r1"))
        XCTAssertEqual(p(#"{"type":"output_audio_buffer.stopped","response_id":"r1"}"#), .outputAudioStopped(responseId: "r1"))
        XCTAssertEqual(p(#"{"type":"output_audio_buffer.speech_stopped","response_id":"r1"}"#), .outputAudioStopped(responseId: "r1"))
        XCTAssertEqual(p(#"{"type":"output_audio_buffer.cleared"}"#), .outputAudioCleared)
        XCTAssertEqual(p(#"{"type":"rate_limits.updated","rate_limits":[]}"#), .rateLimitsUpdated)
    }

    func testErrorEvent() {
        let e = p(#"{"type":"error","event_id":"ev1","error":{"type":"invalid_request_error","code":"response_cancel_not_active","message":"no active response","event_id":"client-1"}}"#)
        guard case .error(let info) = e else { return XCTFail("\(e)") }
        XCTAssertEqual(info.type, "invalid_request_error")
        XCTAssertEqual(info.code, "response_cancel_not_active")
        XCTAssertEqual(info.eventId, "client-1")
        XCTAssertTrue(info.isBenign)
        XCTAssertFalse(RealtimeErrorInfo(type: nil, code: "session_expired", message: nil, eventId: nil).isBenign)
        XCTAssertTrue(RealtimeErrorInfo(type: nil, code: "session_expired", message: nil, eventId: nil).isSessionExpired)
    }

    func testUnknownAndMalformed() {
        XCTAssertEqual(p(#"{"type":"response.content_part.added","part":{}}"#), .unknown(type: "response.content_part.added"))
        XCTAssertEqual(p("not json"), .malformed(type: nil))
        XCTAssertEqual(p("[1,2]"), .malformed(type: nil))
        XCTAssertEqual(p(#"{"no_type":true}"#), .malformed(type: nil))
        XCTAssertEqual(p(#"{"type":""}"#), .malformed(type: nil))
        XCTAssertEqual(p(#"{"type":"conversation.item.input_audio_transcription.delta"}"#), .malformed(type: "conversation.item.input_audio_transcription.delta"), "必須の item_id が無い")
        XCTAssertEqual(p(#"{"type":"response.done"}"#), .malformed(type: "response.done"))
        XCTAssertEqual(RealtimeEventParser.parse(Data()), .malformed(type: nil))
    }
}

final class RealtimeClientEventTests: XCTestCase {
    private func obj(_ e: RealtimeClientEvent) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: e.encoded()) as? NSDictionary)
    }

    func testUserTextItem() throws {
        let d = try obj(.userText("明日の案件は？"))
        XCTAssertEqual(d, [
            "type": "conversation.item.create",
            "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": "明日の案件は？"]]],
        ] as NSDictionary)
    }

    func testContextMessagesUseRoleSpecificContentTypes() throws {
        XCTAssertEqual(try obj(.contextMessage(role: .assistant, text: "3件です")), [
            "type": "conversation.item.create",
            "item": ["type": "message", "role": "assistant", "content": [["type": "output_text", "text": "3件です"]]],
        ] as NSDictionary)
        XCTAssertEqual(try obj(.contextMessage(role: .user, text: "こんにちは")), [
            "type": "conversation.item.create",
            "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": "こんにちは"]]],
        ] as NSDictionary)
    }

    func testFunctionCallOutput() throws {
        XCTAssertEqual(try obj(.functionCallOutput(callId: "c1", output: #"{"count":2}"#)), [
            "type": "conversation.item.create",
            "item": ["type": "function_call_output", "call_id": "c1", "output": #"{"count":2}"#],
        ] as NSDictionary)
    }

    func testResponseCreateAndTextOnly() throws {
        XCTAssertEqual(try obj(.responseCreate(textOnly: false)), ["type": "response.create"] as NSDictionary)
        XCTAssertEqual(try obj(.responseCreate(textOnly: true)), ["type": "response.create", "response": ["output_modalities": ["text"]]] as NSDictionary)
        XCTAssertEqual(String(decoding: try RealtimeClientEvent.responseCreate(textOnly: true).encoded(), as: UTF8.self),
                       #"{"response":{"output_modalities":["text"]},"type":"response.create"}"#)
    }

    func testCancelClearTruncate() throws {
        XCTAssertEqual(try obj(.responseCancel(responseId: nil)), ["type": "response.cancel"] as NSDictionary)
        XCTAssertEqual(try obj(.responseCancel(responseId: "r1")), ["type": "response.cancel", "response_id": "r1"] as NSDictionary)
        XCTAssertEqual(try obj(.outputAudioBufferClear), ["type": "output_audio_buffer.clear"] as NSDictionary)
        XCTAssertEqual(try obj(.conversationItemTruncate(itemId: "a1", audioEndMs: 1500)), ["type": "conversation.item.truncate", "item_id": "a1", "content_index": 0, "audio_end_ms": 1500] as NSDictionary)
    }

    func testSpecialCharactersAreEscapedByEncoder() throws {
        let text = "引用\"と\\改行\nと</script>"
        let d = try obj(.userText(text))
        let content = ((d["item"] as? NSDictionary)?["content"] as? [NSDictionary])?.first
        XCTAssertEqual(content?["text"] as? String, text)
    }
}

final class TranscriptAssemblerTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    func testUserPlaceholderKeepsOrderWhenTranscriptionArrivesLate() {
        var a = TranscriptAssembler()
        a.apply(.speechStarted(itemId: "u1", audioStartMs: 0), now: t0)
        a.apply(.inputAudioCommitted(itemId: "u1"), now: t0)
        // アシスタントの回答が文字起こしより先に届く
        a.apply(.outputAudioTranscriptDelta(itemId: "a1", responseId: "r1", delta: "本日は"), now: t0)
        a.apply(.outputAudioTranscriptDelta(itemId: "a1", responseId: "r1", delta: "12件です"), now: t0)
        a.apply(.inputTranscriptionDelta(itemId: "u1", delta: "今日の"), now: t0)
        a.apply(.inputTranscriptionCompleted(itemId: "u1", transcript: "今日の配送は？"), now: t0)
        a.apply(.outputAudioTranscriptDone(itemId: "a1", responseId: "r1", transcript: "本日は12件です。"), now: t0)

        XCTAssertEqual(a.items.map(\.id), ["u1", "a1"])
        XCTAssertEqual(a.items.map(\.text), ["今日の配送は？", "本日は12件です。"])
        XCTAssertEqual(a.items.map(\.role), [.user, .assistant])
        XCTAssertTrue(a.items.allSatisfy(\.isFinal))
    }

    func testInterleavedDeltasForDifferentItems() {
        var a = TranscriptAssembler()
        a.apply(.outputTextDelta(itemId: "a1", responseId: nil, delta: "A"))
        a.apply(.outputTextDelta(itemId: "a2", responseId: nil, delta: "X"))
        a.apply(.outputTextDelta(itemId: "a1", responseId: nil, delta: "B"))
        a.apply(.outputTextDone(itemId: "a2", responseId: nil, text: "XY"))
        XCTAssertEqual(a.items.map(\.text), ["AB", "XY"])
        XCTAssertEqual(a.items.map(\.isFinal), [false, true])
        XCTAssertEqual(a.streamingAssistantItemId, "a1")
        a.apply(.responseDone(RealtimeResponseSummary(id: "r", status: "completed")))
        XCTAssertNil(a.streamingAssistantItemId)
    }

    func testInterruptionKeepsHeardTextAndIgnoresLaterDeltas() {
        var a = TranscriptAssembler()
        a.apply(.outputAudioTranscriptDelta(itemId: "a1", responseId: "r1", delta: "今日の配送は"))
        XCTAssertTrue(a.markInterrupted(itemId: "a1"))
        XCTAssertFalse(a.markInterrupted(itemId: "a1"), "二重に印を付けない")
        a.apply(.outputAudioTranscriptDelta(itemId: "a1", responseId: "r1", delta: "12件で"))
        a.apply(.outputAudioTranscriptDone(itemId: "a1", responseId: "r1", transcript: "今日の配送は12件です。"))
        let item = try? XCTUnwrap(a.item(id: "a1"))
        XCTAssertEqual(item?.text, "今日の配送は")
        XCTAssertEqual(item?.interrupted, true)
        XCTAssertEqual(a.contextTurns(limit: 12).last, VoiceContextTurn(role: .assistant, text: "今日の配送は（途中で中断）"))
    }

    func testEmptyOrFailedTranscriptionIsRemoved() {
        var a = TranscriptAssembler()
        a.apply(.speechStarted(itemId: "u1", audioStartMs: nil))
        a.apply(.speechStarted(itemId: "u2", audioStartMs: nil))
        XCTAssertEqual(a.displayItems.count, 2, "聞き取り中の枠は表示する")
        a.apply(.inputTranscriptionCompleted(itemId: "u1", transcript: "  "))
        a.apply(.inputTranscriptionFailed(itemId: "u2"))
        XCTAssertTrue(a.items.isEmpty)
    }

    func testStaleEmptyPlaceholdersAreCleanedOnNextSpeech() {
        var a = TranscriptAssembler()
        a.apply(.speechStarted(itemId: "noise", audioStartMs: nil), now: t0)
        a.apply(.speechStarted(itemId: "u2", audioStartMs: nil), now: t0.addingTimeInterval(30))
        XCTAssertEqual(a.items.map(\.id), ["u2"])
    }

    func testLocalTextAndContextTurns() {
        var a = TranscriptAssembler()
        for i in 0..<10 {
            a.addUserText("質問\(i)", id: "local-\(i)")
            a.apply(.outputTextDone(itemId: "a\(i)", responseId: nil, text: "回答\(i)"))
        }
        a.apply(.speechStarted(itemId: "pending", audioStartMs: nil))
        a.apply(.inputTranscriptionDelta(itemId: "pending", delta: "未確定"))
        let turns = a.contextTurns(limit: 12)
        XCTAssertEqual(turns.count, 12)
        XCTAssertEqual(turns.first, VoiceContextTurn(role: .user, text: "質問4"))
        XCTAssertEqual(turns.last, VoiceContextTurn(role: .assistant, text: "回答9"), "未確定の利用者発話は含めない")
        XCTAssertEqual(a.contextTurns(limit: 0), [])
        let long = String(repeating: "あ", count: 700)
        a.addUserText(long)
        XCTAssertEqual(a.contextTurns(limit: 1, maxCharacters: 600).first?.text.count, 601)
    }

    func testIgnoresReplayedItemsAndCapsSize() {
        var a = TranscriptAssembler(maxItems: 3)
        a.apply(.itemAdded(RealtimeItemInfo(id: "x", type: "message", role: "assistant")))
        XCTAssertTrue(a.items.isEmpty, "文脈復元で入れ直した発話は二重に作らない")
        for i in 0..<5 { a.addUserText("\(i)", id: "l\(i)") }
        XCTAssertEqual(a.items.map(\.text), ["2", "3", "4"])
        a.removeAll()
        XCTAssertTrue(a.isEmpty)
    }
}

final class RealtimeTurnTrackerTests: XCTestCase {
    func testBargeInClearsAudioCancelsResponseAndMarksItem() {
        var t = RealtimeTurnTracker()
        XCTAssertEqual(t.handle(.responseCreated(responseId: "r1"), textOnly: false), [])
        _ = t.handle(.outputAudioTranscriptDelta(itemId: "a1", responseId: "r1", delta: "はい"), textOnly: false)
        _ = t.handle(.outputAudioStarted(responseId: "r1"), textOnly: false)
        let actions = t.handle(.speechStarted(itemId: "u2", audioStartMs: nil), textOnly: false)
        XCTAssertEqual(actions, [.bargeIn, .send(.outputAudioBufferClear), .markInterrupted(itemId: "a1"), .send(.responseCancel(responseId: "r1"))])
        _ = t.handle(.outputAudioCleared, textOnly: false)
        XCTAssertFalse(t.isAssistantAudioPlaying)
    }

    func testSpeechWithoutPlaybackOrResponseDoesNothing() {
        var t = RealtimeTurnTracker()
        XCTAssertEqual(t.handle(.speechStarted(itemId: "u1", audioStartMs: nil), textOnly: false), [])
        _ = t.handle(.responseCreated(responseId: "r1"), textOnly: false)
        _ = t.handle(.responseDone(RealtimeResponseSummary(id: "r1", status: "completed")), textOnly: false)
        XCTAssertEqual(t.handle(.speechStarted(itemId: "u2", audioStartMs: nil), textOnly: false), [], "応答が終わっていれば取り消さない")
    }

    func testFunctionCallsDedupedAndSingleFollowUpAfterAllComplete() {
        var t = RealtimeTurnTracker()
        _ = t.handle(.responseCreated(responseId: "r1"), textOnly: false)
        let c1 = RealtimeFunctionCall(callId: "c1", name: "get_today_overview", arguments: "{}", itemId: "f1", responseId: "r1")
        let c2 = RealtimeFunctionCall(callId: "c2", name: "list_unread_notifications", arguments: "{}", itemId: "f2", responseId: "r1")
        XCTAssertEqual(t.handle(.functionCallArgumentsDone(c1), textOnly: false), [.dispatchTool(c1)])
        XCTAssertEqual(t.handle(.functionCallArgumentsDone(c1), textOnly: false), [], "同じ call_id は 1 回")
        // c2 は args.done が来ず response.done の output だけに含まれる
        let done = t.handle(.responseDone(RealtimeResponseSummary(id: "r1", status: "completed", functionCalls: [c1, c2])), textOnly: false)
        XCTAssertEqual(done, [.dispatchTool(c2)])
        XCTAssertEqual(t.pendingToolCount, 2)
        XCTAssertEqual(t.toolCompleted(callId: "c2", output: "{}", textOnly: false), [.send(.functionCallOutput(callId: "c2", output: "{}"))])
        XCTAssertEqual(t.toolCompleted(callId: "c1", output: #"{"a":1}"#, textOnly: true), [
            .send(.functionCallOutput(callId: "c1", output: #"{"a":1}"#)),
            .send(.responseCreate(textOnly: true)),
        ])
        XCTAssertEqual(t.toolCompleted(callId: "c1", output: "{}", textOnly: false), [], "結果は 1 回だけ返す")
        XCTAssertEqual(t.toolCompleted(callId: "unknown", output: "{}", textOnly: false), [])
        XCTAssertEqual(t.pendingToolCount, 0)
    }

    func testToolFinishingBeforeResponseDoneRequestsFollowUpAtResponseDone() {
        var t = RealtimeTurnTracker()
        _ = t.handle(.responseCreated(responseId: "r1"), textOnly: false)
        let c1 = RealtimeFunctionCall(callId: "c1", name: "search_jobs", arguments: "{}", responseId: "r1")
        _ = t.handle(.functionCallArgumentsDone(c1), textOnly: false)
        XCTAssertEqual(t.toolCompleted(callId: "c1", output: "{}", textOnly: false), [.send(.functionCallOutput(callId: "c1", output: "{}"))])
        XCTAssertEqual(t.handle(.responseDone(RealtimeResponseSummary(id: "r1", status: "completed", functionCalls: [c1])), textOnly: false), [.send(.responseCreate(textOnly: false))])
    }

    func testCancelledResponseDoesNotRequestFollowUp() {
        var t = RealtimeTurnTracker()
        _ = t.handle(.responseCreated(responseId: "r1"), textOnly: false)
        let c1 = RealtimeFunctionCall(callId: "c1", name: "search_jobs", arguments: "{}", responseId: "r1")
        _ = t.handle(.functionCallArgumentsDone(c1), textOnly: false)
        _ = t.handle(.responseDone(RealtimeResponseSummary(id: "r1", status: "cancelled")), textOnly: false)
        XCTAssertEqual(t.toolCompleted(callId: "c1", output: "{}", textOnly: false), [.send(.functionCallOutput(callId: "c1", output: "{}"))])
    }

    func testArgumentsDoneWithoutNameWaitsForResponseDone() {
        var t = RealtimeTurnTracker()
        _ = t.handle(.responseCreated(responseId: "r1"), textOnly: false)
        XCTAssertEqual(t.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "c1", name: "", arguments: "{}")), textOnly: false), [])
        let full = RealtimeFunctionCall(callId: "c1", name: "get_earnings_summary", arguments: "{}", itemId: "f1", responseId: "r1")
        XCTAssertEqual(t.handle(.responseDone(RealtimeResponseSummary(id: "r1", status: "completed", functionCalls: [full])), textOnly: false), [.dispatchTool(full)])
    }

    func testResetForNewConnection() {
        var t = RealtimeTurnTracker()
        _ = t.handle(.responseCreated(responseId: "r1"), textOnly: false)
        _ = t.handle(.outputAudioStarted(responseId: "r1"), textOnly: false)
        t.resetForNewConnection()
        XCTAssertFalse(t.isResponseActive)
        XCTAssertFalse(t.isAssistantAudioPlaying)
        XCTAssertEqual(t.handle(.speechStarted(itemId: nil, audioStartMs: nil), textOnly: false), [])
    }
}
