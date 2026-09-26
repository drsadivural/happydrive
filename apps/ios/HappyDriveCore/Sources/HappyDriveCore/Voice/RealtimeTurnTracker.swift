import Foundation

/// 追跡器が求める操作（実行は RealtimeVoiceService が行う）
public enum RealtimeTurnAction: Sendable, Hashable {
    /// データチャネルへ送る
    case send(RealtimeClientEvent)
    /// 割り込みで止めた発話に印を付ける
    case markInterrupted(itemId: String)
    /// 再生中の割り込みが起きた（停止までの時間を測る）
    case bargeIn
    /// ツールを実行する（同じ call_id は 1 回だけ）
    case dispatchTool(RealtimeFunctionCall)
}

/// 応答・再生・ツール呼び出しの進行を追跡し、割り込み（バージイン）とツール結果の返送を決める。
/// UI・通信に依存しない純粋なロジック。
public struct RealtimeTurnTracker: Sendable, Hashable {
    public private(set) var activeResponseId: String?
    public private(set) var isResponseActive = false
    public private(set) var isAssistantAudioPlaying = false
    public private(set) var currentAssistantItemId: String?

    private var dispatchedCallIds: Set<String> = []
    private var completedCallIds: Set<String> = []
    private var callsByResponse: [String: Set<String>] = [:]
    private var responseOfCall: [String: String] = [:]
    private var finishedResponses: Set<String> = []
    private var cancelledResponses: Set<String> = []
    private var followUpRequested: Set<String> = []

    private static let unknownResponseKey = "_unknown"

    public init() {}

    /// ツールの実行待ち（結果を返していない）件数
    public var pendingToolCount: Int {
        dispatchedCallIds.subtracting(completedCallIds).count
    }

    public mutating func handle(_ event: RealtimeServerEvent, textOnly: Bool) -> [RealtimeTurnAction] {
        switch event {
        case .responseCreated(let responseId):
            isResponseActive = true
            activeResponseId = responseId
            return []

        case .outputAudioTranscriptDelta(let itemId, _, _), .outputTextDelta(let itemId, _, _):
            currentAssistantItemId = itemId
            return []

        case .outputAudioStarted:
            isAssistantAudioPlaying = true
            return []

        case .outputAudioStopped, .outputAudioCleared:
            isAssistantAudioPlaying = false
            return []

        case .speechStarted:
            var actions: [RealtimeTurnAction] = []
            if isAssistantAudioPlaying {
                // サーバーの interrupt_response に加え、端末側でも再生を即座に止める
                actions.append(.bargeIn)
                actions.append(.send(.outputAudioBufferClear))
                if let itemId = currentAssistantItemId {
                    actions.append(.markInterrupted(itemId: itemId))
                }
            }
            if isResponseActive {
                actions.append(.send(.responseCancel(responseId: activeResponseId)))
            }
            return actions

        case .functionCallArgumentsDone(let call):
            // name が無い場合は response.done の output で補う
            guard !call.name.isEmpty else { return [] }
            return register(call)

        case .responseDone(let summary):
            isResponseActive = false
            activeResponseId = nil
            let key = summary.id ?? Self.unknownResponseKey
            if summary.status == "cancelled" { cancelledResponses.insert(key) }
            var actions: [RealtimeTurnAction] = []
            for call in summary.functionCalls {
                var c = call
                c.responseId = c.responseId ?? summary.id
                actions += register(c)
            }
            finishedResponses.insert(key)
            actions += followUpIfReady(responseKey: key, textOnly: textOnly)
            return actions

        default:
            return []
        }
    }

    /// ツールの結果が出た。結果を返送し、その応答の全ツールが終わっていれば続きの応答を 1 回だけ依頼する。
    public mutating func toolCompleted(callId: String, output: String, textOnly: Bool) -> [RealtimeTurnAction] {
        guard dispatchedCallIds.contains(callId), !completedCallIds.contains(callId) else { return [] }
        completedCallIds.insert(callId)
        var actions: [RealtimeTurnAction] = [.send(.functionCallOutput(callId: callId, output: output))]
        if let key = responseOfCall[callId] {
            actions += followUpIfReady(responseKey: key, textOnly: textOnly)
        }
        return actions
    }

    /// 自分から応答を止めた（テキスト送信前など）
    public mutating func noteLocalCancel() {
        isAssistantAudioPlaying = false
    }

    /// 接続し直したら応答・再生の状態は引き継がない（ツールの重複防止の記録は残す）
    public mutating func resetForNewConnection() {
        isResponseActive = false
        activeResponseId = nil
        isAssistantAudioPlaying = false
        currentAssistantItemId = nil
    }

    // MARK: - 内部

    private mutating func register(_ call: RealtimeFunctionCall) -> [RealtimeTurnAction] {
        guard !dispatchedCallIds.contains(call.callId) else { return [] }
        dispatchedCallIds.insert(call.callId)
        let key = call.responseId ?? activeResponseId ?? Self.unknownResponseKey
        responseOfCall[call.callId] = key
        callsByResponse[key, default: []].insert(call.callId)
        return [.dispatchTool(call)]
    }

    private mutating func followUpIfReady(responseKey key: String, textOnly: Bool) -> [RealtimeTurnAction] {
        guard finishedResponses.contains(key),
              !cancelledResponses.contains(key),
              !followUpRequested.contains(key),
              let calls = callsByResponse[key], !calls.isEmpty,
              calls.isSubset(of: completedCallIds) else { return [] }
        followUpRequested.insert(key)
        return [.send(.responseCreate(textOnly: textOnly))]
    }
}
