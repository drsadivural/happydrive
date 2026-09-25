import SwiftUI
import UniformTypeIdentifiers
import HappyDriveCore

/// CSV 一括取込：ファイル選択 → 端末内の事前確認 → サーバーの試行（dryRun）で重複・エラーを確認 → 取込
struct CSVImportView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let date: CalendarDateString
    let onImported: () -> Void

    @State private var showPicker = false
    @State private var fileName: String?
    @State private var preview: StopCSV.Preview?
    @State private var dryRun: StopImportResult?
    @State private var skipDuplicates = true
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var result: StopImportResult?
    /// 取込の再試行で二重登録しないよう、ファイルごとに固定するキー
    @State private var commitKey = IdempotencyKey.generate()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        showPicker = true
                    } label: {
                        Label(fileName ?? "CSVファイルを選ぶ", systemImage: "doc.badge.plus")
                    }
                    ShareLink(item: StopCSV.template, preview: SharePreview("配送先テンプレート.csv")) {
                        Label("テンプレートを共有", systemImage: "square.and.arrow.up")
                    }
                } header: {
                    Text("ファイル")
                } footer: {
                    Text("UTF-8のCSV（1行目は見出し）。列: address（必須）, latitude, longitude, time_start, time_end（HH:MM）, priority（0〜2）, service_minutes, recipient_name, recipient_phone, package_number, note。日本語の見出し（住所・荷物番号など）も使えます。")
                }

                if let preview {
                    Section("端末での確認") {
                        InfoRow(title: "読み込んだ行", value: "\(preview.rows.count)件")
                        InfoRow(title: "形式に問題のない行", value: "\(preview.validCount)件")
                        if !preview.localDuplicates.isEmpty {
                            InfoRow(title: "ファイル内の重複", value: "\(preview.localDuplicates.count)件")
                        }
                        ForEach(preview.errors, id: \.self) { issue in
                            Label("\(issue.row)行目: \(issue.message)", systemImage: "exclamationmark.triangle")
                                .font(.hd(.footnote))
                                .foregroundStyle(HDColor.warning)
                        }
                    }
                }

                if let dryRun {
                    Section {
                        InfoRow(title: "登録できる件数", value: "\(dryRun.valid ?? max(0, (preview?.rows.count ?? 0) - dryRun.errors.count))件")
                        ForEach(dryRun.duplicates, id: \.self) { d in
                            Label(duplicateText(d), systemImage: "doc.on.doc")
                                .font(.hd(.footnote))
                                .foregroundStyle(HDColor.warning)
                        }
                        ForEach(dryRun.errors, id: \.self) { e in
                            Label("\(e.row)行目: \(e.message)", systemImage: "xmark.octagon")
                                .font(.hd(.footnote))
                                .foregroundStyle(HDColor.danger)
                        }
                        if !dryRun.duplicates.isEmpty {
                            Toggle("重複する配送先を除いて取り込む", isOn: $skipDuplicates)
                                .onChange(of: skipDuplicates) { _, _ in commitKey = IdempotencyKey.generate() }
                        }
                    } header: {
                        Text("取込前の確認（サーバー）")
                    } footer: {
                        Text("エラーの行は取り込まれません。緯度・経度のない行は「位置未確定」として登録され、住所の候補を確認して位置を確定するまでルートに含められません。")
                    }
                }

                if let result {
                    Section {
                        NoticeBox(kind: .success, text: "\(result.created.count)件の配送先を登録しました。")
                        Button("閉じる") {
                            onImported()
                            dismiss()
                        }
                        .buttonStyle(.hdPrimary)
                    }
                }

                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }

                if dryRun != nil && result == nil {
                    Section {
                        Button {
                            Task { await commit() }
                        } label: {
                            ProgressLabel(title: "取り込む", isLoading: isWorking)
                        }
                        .buttonStyle(.hdPrimary)
                        .disabled(isWorking || (preview?.validCount ?? 0) == 0)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    }
                }
            }
            .navigationTitle("CSVから取込")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
            .overlay {
                if isWorking && dryRun == nil { ProgressView("確認しています…") }
            }
            .fileImporter(isPresented: $showPicker, allowedContentTypes: [.commaSeparatedText, .plainText, .text]) { r in
                switch r {
                case .success(let url): Task { await load(url) }
                case .failure: errorMessage = "ファイルを開けませんでした"
                }
            }
        }
    }

    private func duplicateText(_ d: StopImportDuplicate) -> String {
        if let row = d.duplicateOfRow {
            return "\(d.row)行目: \(d.address)（\(row)行目と同じ住所）"
        }
        return "\(d.row)行目: \(d.address)（登録済みの配送先と同じ住所）"
    }

    private func load(_ url: URL) async {
        errorMessage = nil
        preview = nil
        dryRun = nil
        result = nil
        commitKey = IdempotencyKey.generate()
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            errorMessage = "ファイルを読み込めませんでした"
            return
        }
        guard data.count <= 500_000 else {
            errorMessage = "ファイルが大きすぎます（500KBまで）。分割して取り込んでください。"
            return
        }
        guard let text = CSV.decode(data) else {
            errorMessage = "文字コードを判別できませんでした。UTF-8で保存したCSVを選んでください。"
            return
        }
        fileName = url.lastPathComponent
        do {
            let p = try StopCSV.preview(text)
            preview = p
            guard !p.rows.isEmpty else {
                errorMessage = p.errors.first?.message ?? "データ行がありません"
                return
            }
            isWorking = true
            defer { isWorking = false }
            dryRun = try await env.api.importStops(
                StopImportRequest(scheduledDate: date, csv: p.normalizedCSV, dryRun: true, skipDuplicates: nil),
                idempotencyKey: IdempotencyKey.generate()
            )
        } catch CSVError.unterminatedQuote(let line) {
            errorMessage = "\(line)行目の引用符（\"）が閉じられていません"
        } catch CSVError.empty {
            errorMessage = "ファイルが空です"
        } catch {
            errorMessage = error.hdUserMessage
        }
    }

    private func commit() async {
        guard let preview else { return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            result = try await env.api.importStops(
                StopImportRequest(scheduledDate: date, csv: preview.normalizedCSV, dryRun: false, skipDuplicates: skipDuplicates),
                idempotencyKey: commitKey
            )
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}
