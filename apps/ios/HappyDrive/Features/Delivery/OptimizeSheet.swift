import SwiftUI
import HappyDriveCore

/// ルート作成の条件（出発時刻・出発地・休憩）を指定してサーバーで推奨ルートを計算する
struct OptimizeSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let date: CalendarDateString
    let stops: [Stop]
    let onDone: (Route) -> Void

    @State private var departure = Date()
    @State private var startFromHere = true
    @State private var returnToStart = false
    @State private var addBreak = false
    @State private var breakEarliest = Date()
    @State private var breakLatest = Date()
    @State private var breakMinutes = 45
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var result: Route?
    @State private var requestKey = IdempotencyKey.generate()
    @State private var didPrefill = false

    private var targetIds: [String] { RouteSummary.optimizableStopIds(stops: stops) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    InfoRow(title: "対象の配送先", value: "\(targetIds.count)件")
                    DatePicker("出発時刻", selection: $departure, displayedComponents: .hourAndMinute)
                    if env.location.isAuthorized {
                        Toggle("現在地から出発", isOn: $startFromHere)
                        if startFromHere { Toggle("出発地に戻る", isOn: $returnToStart) }
                    } else {
                        Text("位置情報がオフのため、最初の配送先から計算します。")
                            .font(.hd(.footnote))
                            .foregroundStyle(HDColor.textSecondary)
                    }
                } header: {
                    Text("出発")
                }
                Section("休憩") {
                    Toggle("休憩を入れる", isOn: $addBreak)
                    if addBreak {
                        DatePicker("この時刻以降", selection: $breakEarliest, displayedComponents: .hourAndMinute)
                        DatePicker("この時刻までに開始", selection: $breakLatest, displayedComponents: .hourAndMinute)
                        Stepper("休憩 \(breakMinutes)分", value: $breakMinutes, in: 5...120, step: 5)
                    }
                }
                Section {
                    Text("時間指定・優先度・作業時間・休憩を考慮して推奨順を計算します。厳密な最適解を保証するものではありません。道路所要時間の提供元が未契約の場合は直線距離からの概算になります。")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.textSecondary)
                }
                if let result {
                    Section("計算結果") {
                        InfoRow(title: "所要時間", value: "約\(HDFormat.duration(minutes: result.estimatedMinutes))\(result.travelTimeSource == .provider ? "" : "（概算）")")
                        if let km = result.totalDistanceKm {
                            InfoRow(title: "走行距離", value: "約\(HDFormat.distance(km: km))\(result.travelTimeSource == .provider ? "" : "（概算）")")
                        }
                        if !result.feasible {
                            NoticeBox(kind: .danger, text: "すべての制約を満たすルートは見つかりませんでした。")
                        }
                        ForEach(result.violations ?? [], id: \.self) { v in
                            Label("\(v.type.label)：\(v.message)", systemImage: "exclamationmark.triangle.fill")
                                .font(.hd(.footnote))
                                .foregroundStyle(HDColor.danger)
                        }
                        ForEach(result.warnings ?? [], id: \.self) { w in
                            NoticeBox(kind: .warning, text: w)
                        }
                        Button("このルートを使う") {
                            onDone(result)
                            dismiss()
                        }
                        .buttonStyle(.hdPrimary)
                    }
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
            }
            .environment(\.timeZone, HDFormat.jst)
            .navigationTitle("ルートを作成")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await optimize() }
                    } label: {
                        if isWorking { ProgressView() } else { Text("計算する") }
                    }
                    .disabled(isWorking || targetIds.count < 2)
                }
            }
            .onAppear(perform: prefill)
            .onChange(of: [departure, breakEarliest, breakLatest]) { _, _ in requestKey = IdempotencyKey.generate() }
            .onChange(of: [startFromHere, returnToStart, addBreak]) { _, _ in requestKey = IdempotencyKey.generate() }
            .onChange(of: breakMinutes) { _, _ in requestKey = IdempotencyKey.generate() }
        }
    }

    private func prefill() {
        guard !didPrefill else { return }
        didPrefill = true
        let base = HDFormat.parseAPIDate(date) ?? Date()
        let isToday = date == HDFormat.apiDate(Date())
        departure = isToday ? Date() : (HDFormat.calendar.date(byAdding: .hour, value: 9, to: base) ?? base)
        breakEarliest = HDFormat.calendar.date(byAdding: .hour, value: 12, to: base) ?? base
        breakLatest = HDFormat.calendar.date(byAdding: .hour, value: 14, to: base) ?? base
    }

    /// 選択日の時刻に合わせる
    private func onDate(_ time: Date) -> Date {
        let c = HDFormat.calendar.dateComponents([.hour, .minute], from: time)
        return HDFormat.date(on: date, hour: c.hour ?? 0, minute: c.minute ?? 0) ?? time
    }

    private func optimize() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        var start: GeoPoint?
        if startFromHere && env.location.isAuthorized, let loc = await env.location.currentLocation() {
            start = GeoPoint(latitude: loc.coordinate.latitude, longitude: loc.coordinate.longitude)
        }
        var breaks: [RouteBreakRequest]?
        if addBreak {
            let e = onDate(breakEarliest), l = onDate(breakLatest)
            guard l >= e else {
                errorMessage = "休憩の開始時刻の範囲が正しくありません"
                return
            }
            breaks = [RouteBreakRequest(earliestStart: e, latestStart: l, durationMinutes: breakMinutes)]
        }
        let request = RouteRequest(
            date: date,
            stopIds: targetIds,
            startLocation: start,
            endLocation: returnToStart ? start : nil,
            departureAt: onDate(departure),
            breaks: breaks
        )
        do {
            result = try await env.api.optimizeRoute(request, idempotencyKey: requestKey)
        } catch let error as APIError where error.code == "stop_without_location" {
            errorMessage = "位置が確定していない配送先があります。一覧の「位置未確定」の配送先を開いて住所の候補を確定してください。"
        } catch let error as APIError where error.status == 409 {
            errorMessage = "運行中のため再計算できません。停車してから操作してください。\n\(error.userMessage)"
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}
