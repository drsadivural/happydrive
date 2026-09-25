import Foundation

/// ルート表示用の要約（UI に依存しない）
public struct RouteSummary: Sendable, Hashable {
    public struct Item: Sendable, Hashable, Identifiable {
        public var order: Int
        public var stop: Stop
        public var leg: RouteLeg?
        public var violations: [RouteViolation]
        public var id: String { stop.id }

        public init(order: Int, stop: Stop, leg: RouteLeg?, violations: [RouteViolation]) {
            self.order = order
            self.stop = stop
            self.leg = leg
            self.violations = violations
        }
    }

    public var items: [Item]
    /// ルートに含まれない配送先（追加後に未計算のもの）
    public var unroutedStops: [Stop]
    public var estimatedMinutes: Int
    public var totalDistanceKm: Double?
    public var isEstimated: Bool
    public var feasible: Bool
    public var warnings: [String]
    public var manuallyOrdered: Bool

    public init(route: Route?, stops: [Stop]) {
        let byId = Dictionary(stops.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let legs = Dictionary((route?.legs ?? []).map { ($0.stopId, $0) }, uniquingKeysWith: { a, _ in a })
        let violations = Dictionary(grouping: route?.violations ?? [], by: \.stopId)
        var items: [Item] = []
        if let route {
            for (i, id) in route.orderedStopIds.enumerated() {
                guard let stop = byId[id] else { continue }
                        items.append(Item(order: i + 1, stop: stop, leg: legs[id], violations: violations[id] ?? []))
            }
        }
        let routed = Set(items.map(\.stop.id))
        self.items = items
        self.unroutedStops = stops.filter { !routed.contains($0.id) }.sorted { ($0.sequence ?? Int.max, $0.address) < ($1.sequence ?? Int.max, $1.address) }
        self.estimatedMinutes = route?.estimatedMinutes ?? 0
        self.totalDistanceKm = route?.totalDistanceKm
        // 提供元が不明な場合も「概算」として扱う（厳密な所要時間とは表示しない）
        self.isEstimated = route?.travelTimeSource != .provider
        self.feasible = route?.feasible ?? true
        self.warnings = route?.warnings ?? []
        self.manuallyOrdered = route?.manuallyOrdered ?? false
    }

    public var hasRoute: Bool { !items.isEmpty }

    /// "12件・約4時間20分（概算）"
    public var headline: String {
        let count = items.count + unroutedStops.count
        guard hasRoute else { return "\(count)件" }
        var s = "\(count)件・約\(HDFormat.duration(minutes: estimatedMinutes))"
        if isEstimated { s += "（概算）" }
        return s
    }

    public var completedCount: Int {
        (items.map(\.stop) + unroutedStops).filter { $0.status.isTerminal }.count
    }

    /// 次に向かう配送先（配達中 → 到着 → 未着手の順）
    public var nextStop: Stop? {
        let ordered = items.map(\.stop) + unroutedStops
        return ordered.first(where: { $0.status == .arrived })
            ?? ordered.first(where: { $0.status == .en_route })
            ?? ordered.first(where: { $0.status == .ready || $0.status == .draft })
    }

    /// 最適化できない理由（位置未確定・件数不足）
    public static func optimizationBlocker(stops: [Stop]) -> String? {
        let active = stops.filter { !$0.status.isTerminal }
        if active.count < 2 { return "ルートを作成するには、未完了の配送先が2件以上必要です。" }
        let missing = active.filter { !$0.hasLocation }
        if !missing.isEmpty {
            return "位置が確定していない配送先が\(missing.count)件あります。住所の候補を確認して位置を確定してください。"
        }
        return nil
    }

    /// 最適化の対象（未完了かつ位置確定済み）
    public static func optimizableStopIds(stops: [Stop]) -> [String] {
        stops.filter { !$0.status.isTerminal && $0.hasLocation }.map(\.id)
    }

    /// 並べ替え後の順序（ドラッグ操作の結果をそのまま送る）
    public static func reordered(_ ids: [String], from source: [Int], to destination: Int) -> [String] {
        var result = ids
        let moving = source.sorted().map { ids[$0] }
        for index in source.sorted(by: >) { result.remove(at: index) }
        let adjusted = destination - source.filter { $0 < destination }.count
        result.insert(contentsOf: moving, at: max(0, min(adjusted, result.count)))
        return result
    }
}

/// 運転中の操作抑止。速度が一定以上の間は複雑な編集を無効にする。
/// 閾値の前後でちらつかないよう、停止判定は低速が一定時間続いた場合のみ行う。
public struct DrivingSafetyState: Sendable, Hashable {
    /// 走行とみなす速度（約10km/h）
    public static let drivingThresholdMps: Double = 10.0 / 3.6
    /// 停止とみなす速度（約5km/h）
    public static let stoppedThresholdMps: Double = 5.0 / 3.6
    /// 低速がこの秒数続いたら停止とみなす
    public static let stopConfirmSeconds: TimeInterval = 5

    public private(set) var isDriving = false
    private var slowSince: Date?

    public init() {}

    /// CLLocation.speed（m/s、負値は無効）を与えて状態を更新する
    public mutating func update(speedMps: Double, at time: Date) {
        guard speedMps >= 0 else { return }
        if speedMps > Self.drivingThresholdMps {
            isDriving = true
            slowSince = nil
        } else if isDriving && speedMps < Self.stoppedThresholdMps {
            if let since = slowSince {
                if time.timeIntervalSince(since) >= Self.stopConfirmSeconds {
                    isDriving = false
                    slowSince = nil
                }
            } else {
                slowSince = time
            }
        } else if isDriving {
            slowSince = nil
        }
    }

    public static let lockMessage = "安全のため、停車中に操作してください"
}

/// 日報の集計表示
public struct DeliveryReportSummary: Sendable, Hashable {
    public var total: Int
    public var delivered: Int
    public var failed: Int
    public var deferred: Int
    public var pending: Int
    public var distanceKm: Double

    public init(reports: [DeliveryDayReport]) {
        total = reports.reduce(0) { $0 + $1.total }
        delivered = reports.reduce(0) { $0 + $1.delivered }
        failed = reports.reduce(0) { $0 + $1.failed }
        deferred = reports.reduce(0) { $0 + $1.deferred }
        pending = reports.reduce(0) { $0 + ($1.pending ?? max(0, $1.total - $1.delivered - $1.failed - $1.deferred)) }
        distanceKm = reports.reduce(0) { $0 + ($1.estimatedDistanceKm ?? 0) }
    }

    /// 配達完了率（0〜1）
    public var completionRate: Double {
        total == 0 ? 0 : Double(delivered) / Double(total)
    }
}

/// 報酬の集計表示（即時払いを示唆しない）
public enum EarningsPresentation {
    /// 状態ごとの合計（表示順）
    public static func totalsByState(_ entries: [EarningEntry]) -> [(state: EarningState, amountYen: Int)] {
        let order: [EarningState] = [.estimated, .pending, .payable, .paid, .failed, .reversed]
        return order.compactMap { state in
            let sum = entries.filter { $0.state == state }.reduce(0) { $0 + $1.amountYen }
            let has = entries.contains { $0.state == state }
            return has ? (state, sum) : nil
        }
    }

    public static let payoutNotice = "報酬は検収で確定した後、振込予定日にまとめて振り込まれます。即時の振込ではありません。"
}
