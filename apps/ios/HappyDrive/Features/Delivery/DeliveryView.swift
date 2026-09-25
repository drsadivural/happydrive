import SwiftUI
import HappyDriveCore

struct DeliveryView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model = DeliveryViewModel()
    @State private var editMode: EditMode = .inactive
    @State private var sheet: Sheet?
    @State private var alert: AlertMessage?

    enum Sheet: Identifiable {
        case addStop
        case csvImport
        case ocr
        case optimize
        var id: String { String(describing: self) }
    }

    private var isDriving: Bool { env.location.isDriving }

    var body: some View {
        List {
            Section {
                controls
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))

            if let cachedAt = model.cachedAt {
                Section {
                    NoticeBox(kind: .info, text: "圏外のため、\(HDFormat.dateTime(cachedAt))時点で保存した配送先を表示しています。地図は表示できない場合があります。")
                }
            }
            if let error = model.errorMessage {
                Section {
                    ErrorStateView(message: error) { Task { await model.load(env: env) } }
                }
            }

            if model.loadedOnce || !model.stops.isEmpty {
                content
            } else {
                Section { LoadingStateView() }
            }
        }
        .listStyle(.insetGrouped)
        .environment(\.editMode, $editMode)
        .navigationTitle("配達ルート")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    env.router.push(.dailyReport, on: .delivery)
                } label: {
                    Label("日報", systemImage: "chart.bar.doc.horizontal")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if model.summary.items.count > 1 && model.route?.status != .completed {
                    Button(editMode.isEditing ? "完了" : "並べ替え") {
                        withAnimation { editMode = editMode.isEditing ? .inactive : .active }
                    }
                    .disabled(isDriving)
                }
            }
        }
        .overlay {
            if let busy = model.busyMessage {
                ProgressView(busy)
                    .padding(HDSpacing.xl)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: HDRadius.card))
            }
        }
        .drivingLocked(isDriving)
        .refreshable { await model.load(env: env) }
        .task(id: model.dateString) { await model.load(env: env) }
        .onAppear { updateLocationUse() }
        .onDisappear { env.location.end("delivery") }
        .onChange(of: model.route?.status) { _, _ in updateLocationUse() }
        .sheet(item: $sheet) { s in
            switch s {
            case .addStop:
                AddStopView(date: model.dateString) { stop in
                    model.apply(stop, env: env)
                }
            case .csvImport:
                CSVImportView(date: model.dateString) {
                    Task { await model.load(env: env) }
                }
            case .ocr:
                OCRCaptureView(date: model.dateString) { stop in
                    model.apply(stop, env: env)
                }
            case .optimize:
                OptimizeSheet(date: model.dateString, stops: model.stops) { route in
                    model.setRoute(route, env: env)
                    Task { await model.load(env: env) }
                }
            }
        }
        .hdAlert($alert)
    }

    /// 運行中（ルート開始済み）は速度から運転中を判定する
    private func updateLocationUse() {
        if model.route?.status == .in_progress {
            env.location.requestWhenInUse()
            env.location.begin("delivery")
        } else {
            env.location.end("delivery")
        }
    }

    // MARK: 操作

    private var controls: some View {
        VStack(spacing: HDSpacing.sm) {
            DatePicker("配達日", selection: $model.date, displayedComponents: .date)
                .environment(\.timeZone, HDFormat.jst)
                .font(.hd(.body))
            HStack(spacing: HDSpacing.sm) {
                Button {
                    sheet = .addStop
                } label: {
                    Label("配達先を追加", systemImage: "plus")
                }
                .buttonStyle(.hdPrimary)
                .accessibilityIdentifier("addStopButton")

                Menu {
                    Button {
                        sheet = .csvImport
                    } label: {
                        Label("CSVファイルから取込", systemImage: "doc.text")
                    }
                    Button {
                        sheet = .ocr
                    } label: {
                        Label("写真から住所を読み取る", systemImage: "text.viewfinder")
                    }
                } label: {
                    Text("住所を一括取込")
                        .font(.hd(.headline, .semibold))
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(HDColor.brandBlueSoft, in: RoundedRectangle(cornerRadius: HDRadius.button))
                }
            }
        }
    }

    // MARK: 内容

    @ViewBuilder
    private var content: some View {
        let summary = model.summary
        if model.stops.isEmpty {
            Section {
                EmptyStateView(title: "配達先がありません", systemImage: "shippingbox", message: "「配達先を追加」または「住所を一括取込」から登録してください。")
            }
        } else {
            Section {
                ZStack(alignment: .topLeading) {
                    RouteMapView(items: summary.items.isEmpty ? unroutedItems(summary) : summary.items, showsUserLocation: env.location.isAuthorized)
                        .id(summary.items.map(\.id) + summary.unroutedStops.map(\.id))
                        .frame(height: 260)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    Text(summary.headline)
                        .font(.hd(.subheadline, .semibold))
                        .padding(.horizontal, HDSpacing.md)
                        .padding(.vertical, HDSpacing.sm)
                        .background(.regularMaterial, in: Capsule())
                        .padding(HDSpacing.sm)
                }
                .listRowInsets(EdgeInsets())
            }

            routeInfoSection(summary)

            if !summary.items.isEmpty {
                Section {
                    ForEach(summary.items) { item in
                        NavigationLink(value: AppRoute.stop(item.stop.id)) {
                            StopRow(order: item.order, stop: item.stop, leg: item.leg, violations: item.violations, pending: env.pendingCount(entityKey: "stop:\(item.stop.id)"))
                        }
                    }
                    .onMove { source, destination in
                        Task { await model.reorder(from: source, to: destination, env: env) }
                    }
                } header: {
                    Text("推奨ルートの順番")
                } footer: {
                    Text("制約（時間指定・優先度・作業時間・休憩）を考慮した推奨順です。厳密な最適解を保証するものではありません。「並べ替え」で手動で変更できます。")
                }
            }

            if !summary.unroutedStops.isEmpty {
                Section(summary.items.isEmpty ? "配達先" : "ルート未計算の配達先") {
                    ForEach(summary.unroutedStops) { stop in
                        NavigationLink(value: AppRoute.stop(stop.id)) {
                            StopRow(order: nil, stop: stop, leg: nil, violations: [], pending: env.pendingCount(entityKey: "stop:\(stop.id)"))
                        }
                    }
                }
            }
        }
    }

    private func unroutedItems(_ summary: RouteSummary) -> [RouteSummary.Item] {
        summary.unroutedStops.enumerated().map { RouteSummary.Item(order: $0.offset + 1, stop: $0.element, leg: nil, violations: []) }
    }

    @ViewBuilder
    private func routeInfoSection(_ summary: RouteSummary) -> some View {
        Section {
            if summary.hasRoute {
                if summary.isEstimated {
                    NoticeBox(kind: .info, text: "概算：道路の所要時間は直線距離から推定しています。実際の到着時刻は交通状況で変わります。")
                }
                if !summary.feasible {
                    NoticeBox(kind: .danger, text: "すべての制約は満たせませんでした。赤い表示の配達先を確認し、順番の手動調整や時間指定の見直しをしてください。")
                }
                ForEach(summary.warnings, id: \.self) { w in
                    NoticeBox(kind: .warning, text: w)
                }
                if summary.manuallyOrdered {
                    Label("手動で並べ替えた順番です", systemImage: "hand.draw")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.textSecondary)
                }
            }
            if let blocker = RouteSummary.optimizationBlocker(stops: model.stops) {
                Label(blocker, systemImage: "exclamationmark.circle")
                    .font(.hd(.subheadline))
                    .foregroundStyle(HDColor.warning)
            } else if model.route?.status != .in_progress && model.route?.status != .completed || !summary.unroutedStops.filter({ !$0.status.isTerminal }).isEmpty {
                Button {
                    sheet = .optimize
                } label: {
                    Label(summary.hasRoute ? "ルートを再計算" : "ルートを作成", systemImage: "point.topleft.down.curvedto.point.bottomright.up")
                }
                .buttonStyle(.hdSecondary)
            }
            if model.route?.status == .planned {
                Button {
                    Task { await model.startRoute(env: env) }
                } label: {
                    Label("ルートを開始", systemImage: "play.fill")
                }
                .buttonStyle(.hdPrimary)
                .accessibilityIdentifier("startRouteButton")
            } else if model.route?.status == .in_progress, let next = summary.nextStop {
                NavigationLink(value: AppRoute.stop(next.id)) {
                    Label("次の配達先：\(next.address)", systemImage: "arrow.right.circle.fill")
                        .font(.hd(.headline, .semibold))
                }
            }
        }
    }
}

struct StopRow: View {
    let order: Int?
    let stop: Stop
    let leg: RouteLeg?
    let violations: [RouteViolation]
    var pending = 0

    var body: some View {
        HStack(alignment: .top, spacing: HDSpacing.md) {
            if let order {
                NumberedPin(number: order, status: stop.status)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: stop.hasLocation ? "mappin.circle.fill" : "mappin.slash.circle")
                    .font(.title2)
                    .foregroundStyle(stop.hasLocation ? HDColor.brandBlue : HDColor.warning)
                    .frame(width: 32)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(stop.address)
                    .font(.hd(.body, .semibold))
                    .foregroundStyle(HDColor.textPrimary)
                if let s = stop.timeWindowStart, let e = stop.timeWindowEnd {
                    Text("指定 \(HDFormat.timeRange(s, e))")
                        .font(.hd(.subheadline))
                        .foregroundStyle(HDColor.textSecondary)
                }
                if let leg {
                    Text("到着見込み \(HDFormat.time(leg.arrivalAt))（移動\(leg.travelMinutes)分）")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.textSecondary)
                }
                HStack(spacing: HDSpacing.xs) {
                    StatusBadge(presentation: stop.status.presentation, compact: true)
                    if stop.priority > 0 {
                        StatusBadge(presentation: StatusPresentation("優先 \(StopPriorityLabel.label(stop.priority))", "flag.fill", .warning), compact: true)
                    }
                }
                if stop.duplicateOfStopId != nil {
                    Label("同じ住所の配送先があります", systemImage: "doc.on.doc")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.warning)
                }
                ForEach(violations, id: \.self) { v in
                    Label(v.message, systemImage: "exclamationmark.triangle.fill")
                        .font(.hd(.footnote, .semibold))
                        .foregroundStyle(HDColor.danger)
                }
                if pending > 0 {
                    Label("送信待ち", systemImage: "arrow.triangle.2.circlepath")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.brandBlue)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
