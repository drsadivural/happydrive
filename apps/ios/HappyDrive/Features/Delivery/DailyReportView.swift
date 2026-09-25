import SwiftUI
import HappyDriveCore

/// 配送の日報（日次集計）
struct DailyReportView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var from = Calendar.current.date(byAdding: .day, value: -6, to: Date()) ?? Date()
    @State private var to = Date()
    @State private var state: LoadState<[DeliveryDayReport]> = .idle

    var body: some View {
        List {
            Section("期間") {
                DatePicker("開始日", selection: $from, in: ...to, displayedComponents: .date)
                DatePicker("終了日", selection: $to, in: from..., displayedComponents: .date)
            }
            .environment(\.timeZone, HDFormat.jst)

            switch state {
            case .idle, .loading:
                Section { LoadingStateView() }
            case .failed(let m):
                Section { ErrorStateView(message: m) { Task { await load() } } }
            case .loaded(let reports):
                let s = DeliveryReportSummary(reports: reports)
                Section("合計") {
                    InfoRow(title: "配送先", value: "\(s.total)件")
                    InfoRow(title: "配達完了", value: "\(s.delivered)件（\(Int((s.completionRate * 100).rounded()))%）")
                    InfoRow(title: "未配達", value: "\(s.failed)件")
                    InfoRow(title: "再配達", value: "\(s.deferred)件")
                    InfoRow(title: "未完了", value: "\(s.pending)件")
                    if s.distanceKm > 0 {
                        InfoRow(title: "走行距離（概算）", value: HDFormat.distance(km: s.distanceKm))
                    }
                }
                Section("日別") {
                    if reports.isEmpty {
                        Text("この期間の記録はありません").foregroundStyle(HDColor.textSecondary)
                    }
                    ForEach(reports) { r in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(HDFormat.displayAPIDate(r.date)).font(.hd(.headline, .bold))
                            Text("完了 \(r.delivered) / \(r.total)件 ・ 未配達 \(r.failed) ・ 再配達 \(r.deferred)")
                                .font(.hd(.subheadline))
                                .foregroundStyle(HDColor.textSecondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationTitle("配送の日報")
        .task(id: "\(HDFormat.apiDate(from))-\(HDFormat.apiDate(to))") { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        state = .loading
        do {
            let reports = try await env.api.deliveryReports(from: HDFormat.apiDate(from), to: HDFormat.apiDate(to))
            state = .loaded(reports.sorted { $0.date > $1.date })
        } catch {
            state = .failed(error.hdUserMessage)
        }
    }
}
