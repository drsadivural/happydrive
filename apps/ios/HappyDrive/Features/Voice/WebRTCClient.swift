import Foundation
import os
import WebRTC
import HappyDriveCore

/// WebRTC 層から RealtimeVoiceService へ渡す出来事
enum WebRTCClientEvent: Sendable {
    case dataChannelOpened
    case dataChannelClosed
    case message(Data)
    case connectionState(WebRTCConnectionState)
}

enum WebRTCConnectionState: Sendable, Equatable {
    case connecting, connected, disconnected, failed, closed
}

/// OpenAI Realtime（WebRTC）への音声のみの接続。
/// - マイクの音声トラック 1 本 + データチャネル "oai-events"
/// - SDP は `callUrl` へ一時キー（Bearer）で POST し、応答本文を answer として設定
/// - 相手の音声は WebRTC の音声スタック（RTCAudioSession）で再生される
/// - WebRTC のコールバックは内部スレッドで届くため、状態は lock で守り、出来事は AsyncStream で渡す
final class WebRTCClient: NSObject, @unchecked Sendable {
    static let dataChannelLabel = "oai-events"

    /// ファクトリはプロセスで 1 つ（生成コストが高く、音声デバイスを共有するため）
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    let events: AsyncStream<WebRTCClientEvent>
    private let continuation: AsyncStream<WebRTCClientEvent>.Continuation
    private let urlSession: URLSession
    private let lock = NSLock()

    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var localAudioTrack: RTCAudioTrack?
    private var isClosed = false
    private var dataChannelOpenWaiter: CheckedContinuation<Void, Error>?
    private var gatheringWaiter: CheckedContinuation<Void, Never>?

    override init() {
        var buffered: AsyncStream<WebRTCClientEvent>.Continuation!
        events = AsyncStream(bufferingPolicy: .bufferingNewest(512)) { buffered = $0 }
        continuation = buffered
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = VoiceConfiguration.default.connectTimeout
        configuration.timeoutIntervalForResource = VoiceConfiguration.default.connectTimeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        urlSession = URLSession(configuration: configuration)
        super.init()
    }

    deinit {
        urlSession.invalidateAndCancel()
    }

    // MARK: - 接続

    /// 接続してデータチャネルが開くまで待つ。timeout を超えたら VoiceError.connectionFailed。
    /// clientSecret はこの呼び出しの中でだけ使い、保持・ログ出力しない。
    func connect(callURL: URL, clientSecret: String, microphoneEnabled: Bool, timeout: TimeInterval) async throws {
        let timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(1, timeout) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.failPendingWaiters(VoiceError.connectionFailed)
        }
        defer { timeoutTask.cancel() }
        do {
            try await performConnect(callURL: callURL, clientSecret: clientSecret, microphoneEnabled: microphoneEnabled)
        } catch let error as VoiceError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            HDLog.voice.error("webrtc connect failed: \(String(describing: type(of: error)), privacy: .public)")
            throw VoiceError.connectionFailed
        }
    }

    private func performConnect(callURL: URL, clientSecret: String, microphoneEnabled: Bool) async throws {
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        // OpenAI 側が公開アドレスの候補を持つため STUN/TURN は不要（ブラウザの公式例と同じ）
        configuration.iceServers = []
        configuration.bundlePolicy = .maxBundle
        configuration.rtcpMuxPolicy = .require
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["DtlsSrtpKeyAgreement": kRTCMediaConstraintsValueTrue])

        guard let pc = Self.factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            throw VoiceError.connectionFailed
        }

        // マイク（音声のみ）。拒否・ミュート時はトラックを無効にして無音を送る（テキストでの会話は続けられる）
        let audioConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let source = Self.factory.audioSource(with: audioConstraints)
        let track = Self.factory.audioTrack(with: source, trackId: "hd-mic")
        track.isEnabled = microphoneEnabled
        pc.add(track, streamIds: ["hd-local"])

        let channelConfig = RTCDataChannelConfiguration()
        channelConfig.isOrdered = true
        guard let channel = pc.dataChannel(forLabel: Self.dataChannelLabel, configuration: channelConfig) else {
            pc.close()
            throw VoiceError.connectionFailed
        }
        channel.delegate = self

        let stored: Bool = lock.withLock {
            guard !isClosed else { return false }
            peerConnection = pc
            dataChannel = channel
            localAudioTrack = track
            return true
        }
        guard stored else {
            channel.delegate = nil
            pc.close()
            throw CancellationError()
        }

        let offerConstraints = RTCMediaConstraints(
            mandatoryConstraints: [kRTCMediaConstraintsOfferToReceiveAudio: kRTCMediaConstraintsValueTrue],
            optionalConstraints: nil
        )
        let offer = try await createOffer(pc, constraints: offerConstraints)
        try await setLocalDescription(pc, offer)
        // 候補の収集を短時間だけ待つ（ICE-lite の相手には候補なしの offer でも接続できる）
        await waitForIceGathering(pc, timeout: 1.0)
        let sdp = pc.localDescription?.sdp ?? offer.sdp

        let answer = try await exchangeSDP(sdp, callURL: callURL, clientSecret: clientSecret)
        try Task.checkCancellation()
        try await setRemoteDescription(pc, RTCSessionDescription(type: .answer, sdp: answer))
        try await waitForDataChannelOpen()
    }

    private func createOffer(_ pc: RTCPeerConnection, constraints: RTCMediaConstraints) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<RTCSessionDescription, Error>) in
            pc.offer(for: constraints, completionHandler: { sdp, error in
                if let sdp {
                    cont.resume(returning: sdp)
                } else {
                    cont.resume(throwing: error ?? VoiceError.connectionFailed)
                }
            })
        }
    }

    private func setLocalDescription(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(sdp, completionHandler: { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            })
        }
    }

    private func setRemoteDescription(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(sdp, completionHandler: { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            })
        }
    }

    private func waitForIceGathering(_ pc: RTCPeerConnection, timeout: TimeInterval) async {
        if pc.iceGatheringState == .complete { return }
        let timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            self?.resumeGatheringWaiter()
        }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let resumeNow: Bool = lock.withLock {
                if isClosed || pc.iceGatheringState == .complete { return true }
                gatheringWaiter = cont
                return false
            }
            if resumeNow { cont.resume() }
        }
        timer.cancel()
    }

    private func resumeGatheringWaiter() {
        let waiter: CheckedContinuation<Void, Never>? = lock.withLock {
            let w = gatheringWaiter
            gatheringWaiter = nil
            return w
        }
        waiter?.resume()
    }

    private func waitForDataChannelOpen() async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            let result: Result<Bool, Error> = lock.withLock {
                if isClosed { return .failure(CancellationError()) }
                if dataChannel?.readyState == .open { return .success(true) }
                dataChannelOpenWaiter = cont
                return .success(false)
            }
            switch result {
            case .success(true): cont.resume()
            case .success(false): break
            case .failure(let error): cont.resume(throwing: error)
            }
        }
    }

    /// 待機中の処理を失敗させる（タイムアウト・切断）
    private func failPendingWaiters(_ error: Error) {
        let (openWaiter, gathering): (CheckedContinuation<Void, Error>?, CheckedContinuation<Void, Never>?) = lock.withLock {
            let o = dataChannelOpenWaiter
            let g = gatheringWaiter
            dataChannelOpenWaiter = nil
            gatheringWaiter = nil
            return (o, g)
        }
        gathering?.resume()
        openWaiter?.resume(throwing: error)
    }

    /// SDP の交換（application/sdp）。応答の SDP 以外は記録しない。
    private func exchangeSDP(_ offer: String, callURL: URL, clientSecret: String) async throws -> String {
        guard callURL.scheme == "https" else { throw VoiceError.connectionFailed }
        var request = URLRequest(url: callURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: VoiceConfiguration.default.connectTimeout)
        request.httpMethod = "POST"
        request.setValue("Bearer \(clientSecret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.setValue("application/sdp", forHTTPHeaderField: "Accept")
        request.httpBody = Data(offer.utf8)
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            if (error as? URLError)?.code == .cancelled || Task.isCancelled { throw CancellationError() }
            HDLog.voice.error("sdp exchange network error")
            throw VoiceError.connectionFailed
        }
        guard let http = response as? HTTPURLResponse else { throw VoiceError.connectionFailed }
        guard (200..<300).contains(http.statusCode), let answer = String(data: data, encoding: .utf8), answer.hasPrefix("v=") else {
            HDLog.voice.error("sdp exchange failed status=\(http.statusCode, privacy: .public)")
            throw VoiceError.connectionFailed
        }
        return answer
    }

    // MARK: - 送信・操作

    /// データチャネルへ JSON を送る。開いていなければ false。
    @discardableResult
    func send(_ data: Data) -> Bool {
        let channel: RTCDataChannel? = lock.withLock { isClosed ? nil : dataChannel }
        guard let channel, channel.readyState == .open else { return false }
        return channel.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    func setMicrophoneEnabled(_ enabled: Bool) {
        let track: RTCAudioTrack? = lock.withLock { localAudioTrack }
        track?.isEnabled = enabled
    }

    /// 接続を閉じる（何度呼んでもよい）。トラック停止 → データチャネル → PeerConnection の順に解放。
    func close() {
        let (pc, channel, track): (RTCPeerConnection?, RTCDataChannel?, RTCAudioTrack?) = lock.withLock {
            guard !isClosed else { return (nil, nil, nil) }
            isClosed = true
            let result = (peerConnection, dataChannel, localAudioTrack)
            peerConnection = nil
            dataChannel = nil
            localAudioTrack = nil
            return result
        }
        failPendingWaiters(CancellationError())
        track?.isEnabled = false
        channel?.delegate = nil
        channel?.close()
        pc?.delegate = nil
        pc?.close()
        continuation.finish()
    }

    private func emit(_ event: WebRTCClientEvent) {
        let closed = lock.withLock { isClosed }
        guard !closed else { return }
        continuation.yield(event)
    }
}

// MARK: - RTCPeerConnectionDelegate

extension WebRTCClient: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete { resumeGatheringWaiter() }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let mapped: WebRTCConnectionState
        switch newState {
        case .new, .connecting: mapped = .connecting
        case .connected: mapped = .connected
        case .disconnected: mapped = .disconnected
        case .failed: mapped = .failed
        case .closed: mapped = .closed
        @unknown default: return
        }
        if mapped == .failed || mapped == .closed {
            failPendingWaiters(VoiceError.connectionFailed)
        }
        emit(.connectionState(mapped))
    }
}

// MARK: - RTCDataChannelDelegate

extension WebRTCClient: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        switch dataChannel.readyState {
        case .open:
            let waiter: CheckedContinuation<Void, Error>? = lock.withLock {
                let w = dataChannelOpenWaiter
                dataChannelOpenWaiter = nil
                return w
            }
            waiter?.resume()
            emit(.dataChannelOpened)
        case .closed:
            failPendingWaiters(VoiceError.connectionFailed)
            emit(.dataChannelClosed)
        default:
            break
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary else { return }
        emit(.message(buffer.data))
    }
}
