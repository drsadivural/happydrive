import AVFoundation
import Foundation
import Observation
import os
import HappyDriveCore

/// マイクの権限
enum MicrophonePermission: Equatable {
    case unknown, granted, denied
}

/// HappyDrive AIアシスタントの音声会話（WebRTC + OpenAI Realtime）を進める。
/// - AppEnvironment が保持し、画面を閉じても会話記録（メモリのみ）は残る。再開時は直近の発話を文脈として渡し直す
/// - サーバーイベントの解析はメインスレッド外、状態の更新はメインスレッド
/// - 割り込み・ツール実行・アイドル/最大時間・再接続・バックグラウンド移行・指標の送信を扱う
@Observable
@MainActor
final class RealtimeVoiceService {
    // MARK: 画面に出す状態

    private(set) var state: VoiceConversationState = .idle
    /// 会話記録（端末・サーバーに保存しない。音声そのものは扱わない）
    private(set) var transcript = TranscriptAssembler()
    private(set) var microphonePermission: MicrophonePermission = .unknown
    private(set) var isMicrophoneMuted = false
    private(set) var isTextMode = false
    private(set) var isSpeakerOn = true
    private(set) var audioRoute: AudioSessionManager.Route = .speaker
    private(set) var pendingToolCount = 0
    /// 一時的なお知らせ（会話終了の理由など）
    var notice: String?

    /// 実際にマイクの音を送っている（常時表示のインジケーター用）
    var isMicrophoneCapturing: Bool {
        state.isConnected && microphoneShouldSend
    }

    /// 状態表示の文言（ツール実行中は「確認しています」）
    var statusText: String {
        if state == .listening && pendingToolCount > 0 { return "情報を確認しています…" }
        if state == .listening && isTextMode { return "メッセージを入力してください" }
        return state.statusText
    }

    // MARK: 依存

    @ObservationIgnored private let api: HappyDriveAPI
    @ObservationIgnored private let network: NetworkMonitor
    @ObservationIgnored private let locationProvider: @Sendable () async -> GeoPoint?
    @ObservationIgnored private let baseConfig: VoiceConfiguration
    @ObservationIgnored private let audio: AudioSessionManager

    // MARK: 会話中の内部状態

    @ObservationIgnored private var runConfig: VoiceConfiguration
    @ObservationIgnored private var webRTC: WebRTCClient?
    @ObservationIgnored private var dispatcher: VoiceToolDispatcher?
    @ObservationIgnored private var tracker = RealtimeTurnTracker()
    @ObservationIgnored private var metrics = VoiceMetricsRecorder()
    @ObservationIgnored private var sessionId: String?
    @ObservationIgnored private var runStartedAt = Date()
    @ObservationIgnored private var lastActivityAt = Date()
    /// 接続ごとの番号（古い接続・古いツール結果のイベントを捨てる）
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var connectTask: Task<Void, Never>?
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var timerTask: Task<Void, Never>?
    @ObservationIgnored private var graceTask: Task<Void, Never>?
    @ObservationIgnored private var toolTasks: [String: Task<Void, Never>] = [:]

    init(api: HappyDriveAPI, network: NetworkMonitor, configuration: VoiceConfiguration = .default, location: @escaping @Sendable () async -> GeoPoint?) {
        self.api = api
        self.network = network
        self.baseConfig = configuration
        self.runConfig = configuration
        self.locationProvider = location
        self.audio = AudioSessionManager()
        audio.onInterruptionBegan = { [weak self] in self?.handleAudioInterruption() }
        audio.onRouteChanged = { [weak self] route in self?.audioRoute = route }
        audio.onMediaServicesReset = { [weak self] in self?.handleConnectionLoss(code: "media_services_reset") }
        network.addObserver { [weak self] online in
            if !online { self?.handleConnectionLoss(code: "offline") }
        }
        microphonePermission = Self.currentPermission()
    }

    private var microphoneShouldSend: Bool {
        microphonePermission == .granted && !isMicrophoneMuted && !isTextMode
    }

    // MARK: - 開始・終了

    /// 会話を始める（接続中・会話中なら何もしない）
    func start() {
        guard !state.isActive else { return }
        notice = nil
        transition(.startRequested)
        tracker = RealtimeTurnTracker()
        metrics = VoiceMetricsRecorder()
        runStartedAt = Date()
        metrics.sessionStarted(at: runStartedAt)
        sessionId = nil
        connectTask = Task { [weak self] in await self?.runInitialConnection() }
    }

    /// 利用者が終了した / 画面を閉じた
    func end(reason: VoiceEndReason = .user_ended) {
        guard state.isActive || webRTC != nil else { return }
        let summary = metrics.summary(endReason: reason, endedAt: Date())
        let endedSessionId = sessionId
        teardown()
        transition(.endRequested)
        submit(summary, sessionId: endedSessionId)
    }

    /// サインアウト時：会話を止めて記録を消す
    func reset() {
        end(reason: .user_ended)
        transcript.removeAll()
        state = .idle
        notice = nil
        isTextMode = false
        isMicrophoneMuted = false
    }

    /// アプリがバックグラウンドへ（バックグラウンドでマイクを使わない）
    func handleEnteredBackground() {
        guard state.isActive else { return }
        end(reason: .background)
        notice = "アプリを離れたため、音声会話を終了しました。"
    }

    private func runInitialConnection() async {
        let granted = await resolveMicrophonePermission()
        guard state == .requestingPermission else { return }
        transition(granted ? .permissionGranted : .permissionDenied)
        if !granted { isTextMode = true }
        guard network.isOnline else {
            fail(.offline)
            return
        }
        do {
            try await connect(previousSessionId: nil)
            guard state == .connecting else { return }
            transition(.connected)
            startTimer()
        } catch is CancellationError {
            return
        } catch {
            guard state == .connecting else { return }
            fail(VoiceError.from(error))
        }
    }

    /// 資格情報の発行 → 音声セッション → WebRTC 接続 → 文脈の復元
    private func connect(previousSessionId: String?) async throws {
        metrics.connectStarted(at: Date())
        let issued = try await api.createVoiceSession(previousSessionId: previousSessionId)
        guard state.isActive, !Task.isCancelled else {
            // 取り消し中に発行された資格情報はすぐ終了扱いにする（同時利用の上限を占有しない）
            submit(VoiceSessionMetrics(endReason: .user_ended, durationSeconds: 0), sessionId: issued.sessionId)
            throw CancellationError()
        }
        sessionId = issued.sessionId
        runConfig = baseConfig.applying(issued)
        let location = locationProvider
        dispatcher = VoiceToolDispatcher(api: api, serverTools: issued.tools, timeout: runConfig.toolTimeout, location: location)
        transition(.sessionIssued)

        try audio.activate(speaker: isSpeakerOn)
        audioRoute = audio.currentRoute

        generation += 1
        let client = WebRTCClient()
        webRTC = client
        startEventLoop(client, generation: generation)
        do {
            try await client.connect(callURL: issued.callUrl, clientSecret: issued.clientSecret, microphoneEnabled: microphoneShouldSend, timeout: runConfig.connectTimeout)
        } catch {
            client.close()
            if webRTC === client { webRTC = nil }
            throw error
        }
        guard state.isActive, webRTC === client else {
            client.close()
            throw CancellationError()
        }
        metrics.connected(at: Date())
        tracker.resetForNewConnection()
        replayContext()
        lastActivityAt = Date()
    }

    /// 直近の発話を会話に入れ直す（画面の再表示・再接続で文脈を保つ）
    private func replayContext() {
        let turns = transcript.contextTurns(limit: runConfig.contextReplayTurns, maxCharacters: runConfig.contextReplayMaxCharacters)
        for turn in turns {
            send(.contextMessage(role: turn.role, text: turn.text))
        }
    }

    private func fail(_ error: VoiceError) {
        metrics.recordError(code: error.metricCode)
        let summary = metrics.summary(endReason: error.endReason, endedAt: Date())
        let failedSessionId = sessionId
        teardown()
        transition(.fatal(error))
        submit(summary, sessionId: failedSessionId)
    }

    /// 接続・タイマー・ツール・音声をすべて解放する
    private func teardown() {
        connectTask?.cancel()
        connectTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        timerTask?.cancel()
        timerTask = nil
        graceTask?.cancel()
        graceTask = nil
        eventTask?.cancel()
        eventTask = nil
        toolTasks.values.forEach { $0.cancel() }
        toolTasks.removeAll()
        pendingToolCount = 0
        webRTC?.close()
        webRTC = nil
        dispatcher = nil
        generation += 1
        tracker.resetForNewConnection()
        audio.deactivate()
        sessionId = nil
    }

    /// 終了の記録（ベストエフォート。画面の操作を待たせない）
    private func submit(_ summary: VoiceSessionMetrics, sessionId: String?) {
        guard let sessionId else { return }
        let api = api
        Task.detached(priority: .utility) {
            do {
                try await api.endVoiceSession(id: sessionId, metrics: summary)
            } catch {
                HDLog.error(HDLog.voice, "endVoiceSession", error)
            }
        }
    }

    // MARK: - 操作

    func toggleMute() {
        guard microphonePermission == .granted else { return }
        isMicrophoneMuted.toggle()
        applyMicrophoneState()
    }

    func setTextMode(_ on: Bool) {
        guard isTextMode != on else { return }
        // マイクが使えない場合は文字入力のまま
        if !on && microphonePermission != .granted { return }
        isTextMode = on
        applyMicrophoneState()
    }

    func toggleSpeaker() {
        isSpeakerOn.toggle()
        audio.setSpeaker(isSpeakerOn)
    }

    /// テキストで送る。回答中なら止めてから送る。送れたら true。
    @discardableResult
    func sendText(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, state.isConnected else { return false }
        let text = String(trimmed.prefix(runConfig.maxTextMessageLength))
        if tracker.isAssistantAudioPlaying {
            send(.outputAudioBufferClear)
            if let itemId = tracker.currentAssistantItemId { transcript.markInterrupted(itemId: itemId) }
            tracker.noteLocalCancel()
        }
        if tracker.isResponseActive {
            send(.responseCancel(responseId: tracker.activeResponseId))
        }
        guard send(.userText(text)) else {
            notice = "送信できませんでした。通信状態を確認してください。"
            return false
        }
        transcript.addUserText(text)
        send(.responseCreate(textOnly: isTextMode))
        let now = Date()
        metrics.userTurnEnded(at: now, expectsAudio: !isTextMode)
        lastActivityAt = now
        return true
    }

    private func applyMicrophoneState() {
        webRTC?.setMicrophoneEnabled(microphoneShouldSend)
    }

    // MARK: - 権限

    private static func currentPermission() -> MicrophonePermission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .unknown
        }
    }

    /// 未確認のときだけ許可ダイアログを出す（拒否後に何度も出さない）
    private func resolveMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            microphonePermission = .granted
        case .denied:
            microphonePermission = .denied
        case .undetermined:
            let granted = await AVAudioApplication.requestRecordPermission()
            microphonePermission = granted ? .granted : .denied
        @unknown default:
            microphonePermission = .denied
        }
        return microphonePermission == .granted
    }

    // MARK: - イベント処理

    private enum LoopEvent: Sendable {
        case server(RealtimeServerEvent)
        case transport(WebRTCClientEvent)
    }

    /// データチャネルの受信（解析はメインスレッド外で行い、反映だけメインへ）
    private func startEventLoop(_ client: WebRTCClient, generation: Int) {
        eventTask?.cancel()
        let stream = client.events
        eventTask = Task.detached(priority: .userInitiated) { [weak self] in
            for await event in stream {
                if Task.isCancelled { break }
                let loopEvent: LoopEvent
                if case .message(let data) = event {
                    loopEvent = .server(RealtimeEventParser.parse(data))
                } else {
                    loopEvent = .transport(event)
                }
                await self?.handle(loopEvent, generation: generation)
            }
        }
    }

    private func handle(_ event: LoopEvent, generation eventGeneration: Int) {
        guard eventGeneration == generation else { return }
        switch event {
        case .server(let serverEvent):
            handleServerEvent(serverEvent)
        case .transport(let transportEvent):
            handleTransportEvent(transportEvent)
        }
    }

    private func handleTransportEvent(_ event: WebRTCClientEvent) {
        switch event {
        case .connectionState(.connected):
            graceTask?.cancel()
            graceTask = nil
        case .connectionState(.disconnected):
            // 一時的な切断は少し待つ（Wi-Fi ↔ モバイル通信の切り替え等）
            guard state.isConnected, graceTask == nil else { return }
            let grace = runConfig.disconnectGracePeriod
            graceTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(grace * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.graceTask = nil
                self?.handleConnectionLoss(code: "ice_disconnected")
            }
        case .connectionState(.failed), .connectionState(.closed):
            handleConnectionLoss(code: "peer_connection_failed")
        case .dataChannelClosed:
            handleConnectionLoss(code: "data_channel_closed")
        case .connectionState(.connecting), .dataChannelOpened, .message:
            break
        }
    }

    private func handleServerEvent(_ event: RealtimeServerEvent) {
        let now = Date()
        transcript.apply(event, now: now)
        perform(tracker.handle(event, textOnly: isTextMode), now: now)

        switch event {
        case .speechStarted:
            lastActivityAt = now
            transition(.speechStarted)
        case .speechStopped:
            lastActivityAt = now
            metrics.userTurnEnded(at: now, expectsAudio: !isTextMode)
            transition(.speechStopped)
        case .responseCreated:
            lastActivityAt = now
            transition(.responseCreated)
        case .outputAudioStarted:
            lastActivityAt = now
            metrics.assistantAudioStarted(at: now)
            transition(.assistantAudioStarted)
        case .outputAudioStopped, .outputAudioCleared:
            lastActivityAt = now
            metrics.assistantAudioStopped(at: now)
            transition(.assistantAudioStopped)
        case .responseDone(let summary):
            lastActivityAt = now
            if summary.status == "failed" {
                metrics.recordError(code: "response_failed")
            }
            transition(.responseDone)
        case .outputTextDelta, .outputAudioTranscriptDelta, .inputTranscriptionDelta:
            lastActivityAt = now
        case .error(let info):
            handleRealtimeError(info)
        case .unknown(let type):
            HDLog.voice.debug("ignored realtime event \(type, privacy: .public)")
        case .malformed(let type):
            HDLog.voice.error("malformed realtime event \(type ?? "-", privacy: .public)")
            metrics.recordError(code: "malformed_event")
        default:
            break
        }
    }

    private func perform(_ actions: [RealtimeTurnAction], now: Date) {
        for action in actions {
            switch action {
            case .send(let event):
                send(event)
            case .markInterrupted(let itemId):
                transcript.markInterrupted(itemId: itemId)
            case .bargeIn:
                metrics.interruptionStarted(at: now)
            case .dispatchTool(let call):
                runTool(call)
            }
        }
    }

    private func handleRealtimeError(_ info: RealtimeErrorInfo) {
        // 本文（英語）は記録しない。種類とコードだけ
        HDLog.voice.error("realtime error type=\(info.type ?? "-", privacy: .public) code=\(info.code ?? "-", privacy: .public)")
        if info.isBenign { return }
        metrics.recordError(code: "realtime_" + (info.code ?? info.type ?? "error"))
        if info.isSessionExpired {
            fail(.maxDurationReached)
        }
    }

    @discardableResult
    private func send(_ event: RealtimeClientEvent) -> Bool {
        guard let client = webRTC else { return false }
        do {
            let ok = client.send(try event.encoded())
            if !ok { HDLog.voice.error("send failed type=\(event.typeName, privacy: .public)") }
            return ok
        } catch {
            HDLog.voice.error("encode failed type=\(event.typeName, privacy: .public)")
            return false
        }
    }

    // MARK: - ツール

    private func runTool(_ call: RealtimeFunctionCall) {
        guard let dispatcher else { return }
        let callGeneration = generation
        let started = Date()
        pendingToolCount = tracker.pendingToolCount
        HDLog.voice.info("tool call \(call.name, privacy: .public)")
        toolTasks[call.callId] = Task { [weak self] in
            let result = await dispatcher.execute(call)
            self?.finishTool(call, result: result, started: started, generation: callGeneration)
        }
    }

    private func finishTool(_ call: RealtimeFunctionCall, result: VoiceToolResult, started: Date, generation callGeneration: Int) {
        toolTasks[call.callId] = nil
        guard callGeneration == generation else { return }
        metrics.toolFinished(latencyMs: Int(Date().timeIntervalSince(started) * 1000), succeeded: result.succeeded)
        if let code = result.errorCode {
            HDLog.voice.error("tool \(call.name, privacy: .public) failed code=\(code, privacy: .public)")
        }
        perform(tracker.toolCompleted(callId: call.callId, output: result.output, textOnly: isTextMode), now: Date())
        pendingToolCount = tracker.pendingToolCount
        lastActivityAt = Date()
    }

    // MARK: - 時間の上限

    private func startTimer() {
        timerTask?.cancel()
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                self?.tick()
            }
        }
    }

    private func tick() {
        let now = Date()
        if state.isActive, now.timeIntervalSince(runStartedAt) >= runConfig.maxDuration {
            fail(.maxDurationReached)
            return
        }
        guard state == .listening, pendingToolCount == 0 else { return }
        if now.timeIntervalSince(lastActivityAt) >= runConfig.idleTimeout {
            end(reason: .idle_timeout)
            notice = "しばらく会話がなかったため、音声会話を終了しました。"
        }
    }

    // MARK: - 切断・再接続

    private func handleAudioInterruption() {
        guard state.isActive else { return }
        // 電話などで音声が奪われた。中途半端に続けず終了し、戻ってから再開してもらう
        end(reason: .background)
        notice = "通話などで音声が中断されたため、音声会話を終了しました。"
    }

    private func handleConnectionLoss(code: String) {
        guard state.isConnected else { return }
        HDLog.voice.error("connection lost code=\(code, privacy: .public)")
        metrics.recordError(code: code)
        transition(.networkLost)
        graceTask?.cancel()
        graceTask = nil
        eventTask?.cancel()
        eventTask = nil
        toolTasks.values.forEach { $0.cancel() }
        toolTasks.removeAll()
        pendingToolCount = 0
        webRTC?.close()
        webRTC = nil
        generation += 1
        tracker.resetForNewConnection()
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in await self?.reconnectLoop() }
    }

    private func reconnectLoop() async {
        let policy = baseConfig.reconnect
        var attempt = 1
        while !Task.isCancelled {
            guard case .reconnecting = state, let delay = policy.delay(forAttempt: attempt) else { return }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            await waitForNetwork(timeout: 10)
            if Task.isCancelled { return }
            if network.isOnline {
                do {
                    try await connect(previousSessionId: sessionId)
                    guard case .reconnecting = state else { return }
                    metrics.reconnected()
                    transition(.reconnectSucceeded)
                    return
                } catch is CancellationError {
                    return
                } catch {
                    let voiceError = VoiceError.from(error)
                    switch voiceError {
                    case .authExpired, .forbidden, .rateLimited, .unavailable:
                        // 再試行しても直らない
                        fail(voiceError)
                        return
                    default:
                        metrics.recordError(code: "reconnect_" + voiceError.metricCode)
                    }
                }
            }
            if !policy.canRetry(afterAttempt: attempt) {
                fail(.connectionLost)
                return
            }
            transition(.reconnectFailed(exhausted: false))
            attempt += 1
        }
    }

    private func waitForNetwork(timeout: TimeInterval) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !network.isOnline && Date() < deadline && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }

    // MARK: - 状態

    private func transition(_ event: VoiceEvent) {
        let next = VoiceStateMachine.reduce(state, event)
        guard next != state else { return }
        state = next
        applyMicrophoneState()
    }
}
