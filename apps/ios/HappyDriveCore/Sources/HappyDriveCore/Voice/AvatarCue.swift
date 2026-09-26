import Foundation

/// アバター（HappyAvatarKit）へ伝える会話の出来事。
/// `VoiceConversationState` の遷移から決定的に導く（状態機械は VoiceStateMachine の 1 つだけ）。
/// アプリ側で `HappyVoiceConversationEvent` に 1 対 1 で変換する。
public enum AvatarCue: Sendable, Hashable {
    case idle
    case connecting
    case userSpeechStarted
    case assistantThinking
    case assistantSpeechStarted
    case assistantInterrupted
    case reconnecting
    case connectionRecovered
    case failed
    case ended

    /// 状態が `old` から `new` に変わったときのキュー。同じ種類の状態のまま（再接続の試行回数だけ変化など）は nil。
    public static func transition(from old: VoiceConversationState, to new: VoiceConversationState) -> AvatarCue? {
        switch new {
        case .requestingPermission, .connecting:
            return old.isBusyConnectingInitially ? nil : .connecting
        case .listening:
            if case .reconnecting = old { return .connectionRecovered }
            return old == .listening ? nil : .idle
        case .userSpeaking:
            return old == .userSpeaking ? nil : .userSpeechStarted
        case .thinking:
            return old == .thinking ? nil : .assistantThinking
        case .assistantSpeaking:
            return old == .assistantSpeaking ? nil : .assistantSpeechStarted
        case .reconnecting:
            if case .reconnecting = old { return nil }
            return .reconnecting
        case .error:
            if case .error = old { return nil }
            return .failed
        case .disconnected, .idle:
            switch old {
            case .disconnected, .idle: return nil
            default: return .ended
            }
        }
    }
}

private extension VoiceConversationState {
    /// 開始処理（権限確認 → 接続）の途中。権限確認から接続へ進んでも「接続中」を繰り返さない
    var isBusyConnectingInitially: Bool {
        self == .requestingPermission || self == .connecting
    }
}

/// 口の動き・スペクトラム用の音量計算（UI に依存しない）
public enum VoiceLevelMeter {
    /// 回答中の音量の取得間隔（約30Hz）。口の動きを音声に合わせる
    public static let speakingIntervalNanos: UInt64 = 33_000_000
    /// それ以外の取得間隔（約12Hz）。スペクトラム表示には十分
    public static let idleIntervalNanos: UInt64 = 80_000_000
    /// 上限 60Hz（これより短い間隔では取得しない）
    public static let minimumIntervalNanos: UInt64 = 16_666_667

    /// 状態に応じた取得間隔（回答中だけ速くする）
    public static func pollInterval(for state: VoiceConversationState) -> UInt64 {
        let interval = state == .assistantSpeaking ? speakingIntervalNanos : idleIntervalNanos
        return max(interval, minimumIntervalNanos)
    }

    /// WebRTC の audioLevel（0〜1 の線形振幅）を、見た目の大きさ（0〜1）に変換する。
    /// -50dB を 0、0dB を 1 とする（スペクトラム表示と同じ変換）。
    public static func normalized(_ linear: Double) -> Double {
        guard linear.isFinite, linear > 0.0001 else { return 0 }
        return min(1, max(0, (20 * log10(linear) + 50) / 50))
    }
}

/// HappyDrive の業務イベントのうち、音声アシスタントの結果から判定するもの
public enum AvatarDomainSignal {
    /// ツールの結果（モデルへ返す JSON）に案件が 1 件以上含まれるか。
    /// search_jobs は `count`（または `jobs`）、get_today_overview は `nearbyJobs` を見る。
    public static func containsJobs(toolName: String, output: String) -> Bool {
        guard let tool = VoiceToolName(rawValue: toolName),
              let data = output.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        switch tool {
        case .search_jobs:
            if let count = object["count"] as? Int { return count > 0 }
            return ((object["jobs"] as? [Any])?.count ?? 0) > 0
        case .get_today_overview:
            return ((object["nearbyJobs"] as? [Any])?.count ?? 0) > 0
        default:
            return false
        }
    }
}

/// 運行中に、移動中（en_route）の配送先へ近づいたことを 1 配送先につき 1 回だけ知らせる
public struct DestinationApproachTracker: Sendable, Hashable {
    /// 近づいたとみなす距離（メートル）
    public let radiusMeters: Double
    private var notifiedStopIds: Set<String> = []

    public init(radiusMeters: Double = 200) {
        self.radiusMeters = radiusMeters
    }

    /// 現在地の更新ごとに呼ぶ。新たに近づいた配送先の ID を返す（無ければ nil）。
    /// - Parameters:
    ///   - routeInProgress: ルートが運行中のときだけ判定する
    public mutating func update(stops: [Stop], current: GeoPoint, routeInProgress: Bool) -> String? {
        guard routeInProgress else { return nil }
        for stop in stops where stop.status == .en_route && !notifiedStopIds.contains(stop.id) {
            guard let location = stop.location else { continue }
            if Geo.distanceMeters(current, location) <= radiusMeters {
                notifiedStopIds.insert(stop.id)
                return stop.id
            }
        }
        return nil
    }

    /// 日付の切り替えなど、配送先の一覧が入れ替わったとき
    public mutating func reset() {
        notifiedStopIds.removeAll()
    }
}
