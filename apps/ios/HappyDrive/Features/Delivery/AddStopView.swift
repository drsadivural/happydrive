import MapKit
import SwiftUI
import HappyDriveCore

/// 配送先の追加・編集。住所は候補を検索して地図で確認してから位置を確定する（最適化に必要）。
struct AddStopView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss

    let date: CalendarDateString
    var existing: Stop? = nil
    var source: StopSource = .manual
    var initialAddress: String = ""
    let onSaved: (Stop) -> Void

    @State private var search = AddressSearchService()
    @State private var address = ""
    @State private var candidates: [AddressCandidate] = []
    @State private var confirmed: AddressCandidate?
    @State private var keepExistingLocation = false
    @State private var useTimeWindow = false
    @State private var windowStart = Date()
    @State private var windowEnd = Date()
    @State private var priority = 0
    @State private var serviceMinutes = 3
    @State private var recipientName = ""
    @State private var recipientPhone = ""
    @State private var packageNumber = ""
    @State private var note = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var duplicateWarning: String?
    @State private var didPrefill = false

    private var isEditing: Bool { existing != nil }

    var body: some View {
        NavigationStack {
            Form {
                addressSection
                if let confirmed {
                    Section("位置の確認") {
                        SinglePointMap(point: confirmed.point, title: confirmed.title)
                            .frame(height: 180)
                            .listRowInsets(EdgeInsets())
                        Label("この位置で確定しました", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(HDColor.jobGreen)
                        Button("候補を選び直す") { self.confirmed = nil }
                    }
                } else if keepExistingLocation, let loc = existing?.location {
                    Section("位置") {
                        SinglePointMap(point: loc, title: existing?.address ?? "")
                            .frame(height: 160)
                            .listRowInsets(EdgeInsets())
                    }
                }

                Section("時間指定") {
                    Toggle("時間指定あり", isOn: $useTimeWindow)
                    if useTimeWindow {
                        DatePicker("開始", selection: $windowStart, displayedComponents: .hourAndMinute)
                        DatePicker("終了", selection: $windowEnd, displayedComponents: .hourAndMinute)
                    }
                }
                .environment(\.timeZone, HDFormat.jst)

                Section("配達の条件") {
                    Picker("優先度", selection: $priority) {
                        Text("通常").tag(0)
                        Text("高").tag(1)
                        Text("最優先").tag(2)
                    }
                    Stepper("作業時間 \(serviceMinutes)分", value: $serviceMinutes, in: 0...120)
                }

                Section {
                    TextField("受取人名（任意）", text: $recipientName)
                        .textContentType(.name)
                    TextField("電話番号（任意）", text: $recipientPhone)
                        .keyboardType(.phonePad)
                    TextField("荷物番号（任意）", text: $packageNumber)
                    TextField("メモ（置き配可否・受け渡し方法など）", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                } header: {
                    Text("受取人・荷物")
                } footer: {
                    Text("電話番号は配達中に「受取人に電話」を押した時だけ表示されます。")
                }

                if let duplicateWarning {
                    Section {
                        NoticeBox(kind: .warning, text: duplicateWarning)
                        Button("重複を承知で登録する") { Task { await save(allowDuplicate: true) } }
                            .buttonStyle(.hdSecondary)
                    }
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
            }
            .navigationTitle(isEditing ? "配送先の編集" : "配送先を追加")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save(allowDuplicate: false) }
                    } label: {
                        if isSaving { ProgressView() } else { Text("保存") }
                    }
                    .disabled(isSaving || address.trimmingCharacters(in: .whitespaces).count < 4)
                    .accessibilityIdentifier("saveStopButton")
                }
            }
            .onAppear(perform: prefill)
            .onChange(of: address) { _, q in
                if confirmed.map({ $0.address != q }) ?? true {
                    search.update(query: q)
                }
            }
            .drivingLocked(env.location.isDriving)
        }
    }

    // MARK: 住所

    private var addressSection: some View {
        Section {
            TextField("例 神奈川県横浜市中区山下町1-2-3", text: $address, axis: .vertical)
                .textContentType(.fullStreetAddress)
                .accessibilityLabel("住所")
                .accessibilityIdentifier("stopAddressField")
            if confirmed == nil {
                ForEach(search.suggestions, id: \.self) { s in
                    Button {
                        Task { await pick(s) }
                    } label: {
                        VStack(alignment: .leading) {
                            Text(s.title).font(.hd(.body)).foregroundStyle(HDColor.textPrimary)
                            if !s.subtitle.isEmpty {
                                Text(s.subtitle).font(.hd(.footnote)).foregroundStyle(HDColor.textSecondary)
                            }
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    }
                }
                Button {
                    Task { await geocode() }
                } label: {
                    Label(search.isSearching ? "検索中…" : "この住所で位置を検索", systemImage: "magnifyingglass")
                }
                .disabled(address.trimmingCharacters(in: .whitespaces).count < 4 || search.isSearching)
                ForEach(candidates) { c in
                    Button {
                        confirmed = c
                        candidates = []
                    } label: {
                        VStack(alignment: .leading) {
                            Text(c.address).font(.hd(.body, .semibold)).foregroundStyle(HDColor.textPrimary)
                            Text("この候補で確定する").font(.hd(.footnote)).foregroundStyle(HDColor.brandBlue)
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    }
                }
            }
        } header: {
            Text("住所")
        } footer: {
            if confirmed == nil && !(keepExistingLocation && existing?.location != nil) {
                Text("位置を確定しないまま保存すると「位置未確定」となり、ルートの作成ができません。")
            }
        }
    }

    private func prefill() {
        guard !didPrefill else { return }
        didPrefill = true
        let base = HDFormat.parseAPIDate(date) ?? Date()
        windowStart = HDFormat.calendar.date(byAdding: .hour, value: 10, to: base) ?? base
        windowEnd = HDFormat.calendar.date(byAdding: .hour, value: 12, to: base) ?? base
        if let s = existing {
            address = s.address
            keepExistingLocation = s.location != nil
            if let a = s.timeWindowStart, let b = s.timeWindowEnd {
                useTimeWindow = true
                windowStart = a
                windowEnd = b
            }
            priority = s.priority
            serviceMinutes = s.serviceMinutes
            recipientName = s.recipientName ?? ""
            packageNumber = s.packageNumber ?? ""
            note = s.note ?? ""
        } else {
            address = initialAddress
        }
    }

    private func pick(_ completion: MKLocalSearchCompletion) async {
        do {
            let results = try await search.resolve(completion)
            if results.count == 1, let only = results.first {
                confirmed = only
                address = only.address
            } else {
                candidates = results
            }
        } catch {
            errorMessage = "住所の候補を取得できませんでした。通信状態を確認してください。"
        }
    }

    private func geocode() async {
        errorMessage = nil
        do {
            candidates = try await search.geocode(address)
            if candidates.isEmpty { errorMessage = "該当する住所が見つかりませんでした。番地まで入力してください。" }
        } catch {
            errorMessage = "該当する住所が見つかりませんでした。番地まで入力するか、表記を変えて検索してください。"
        }
    }

    /// 選択した日付（JST）と時刻から時間枠を作る
    private func windowDate(_ time: Date) -> Date? {
        let c = HDFormat.calendar.dateComponents([.hour, .minute], from: time)
        return HDFormat.date(on: date, hour: c.hour ?? 0, minute: c.minute ?? 0)
    }

    private func save(allowDuplicate: Bool) async {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let phone = Validation.toHalfwidthASCII(recipientPhone).trimmingCharacters(in: .whitespaces)
        if !phone.isEmpty && !Validation.isRecipientPhone(phone) {
            errorMessage = "電話番号は数字とハイフンで10〜15文字で入力してください"
            return
        }
        var start: Date?, end: Date?
        if useTimeWindow {
            start = windowDate(windowStart)
            end = windowDate(windowEnd)
            if let s = start, let e = end, e <= s {
                errorMessage = "時間指定の終了は開始より後にしてください"
                return
            }
        }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let saved: Stop
            if let existing {
                var update = StopUpdate(version: existing.version)
                update.address = trimmed
                if let confirmed { update.location = confirmed.point }
                update.timeWindowStart = start.map { .value($0) } ?? .null
                update.timeWindowEnd = end.map { .value($0) } ?? .null
                update.note = note.isEmpty ? .null : .value(note)
                update.recipientName = recipientName.isEmpty ? .null : .value(recipientName)
                if !phone.isEmpty { update.recipientPhone = .value(phone) }
                update.packageNumber = packageNumber.isEmpty ? .null : .value(packageNumber)
                update.priority = priority
                update.serviceMinutes = serviceMinutes
                saved = try await env.api.updateStop(id: existing.id, update: update)
            } else {
                let stop = NewStop(
                    address: trimmed,
                    scheduledDate: date,
                    location: confirmed?.point,
                    timeWindowStart: start,
                    timeWindowEnd: end,
                    note: note.isEmpty ? nil : note,
                    recipientName: recipientName.isEmpty ? nil : recipientName,
                    recipientPhone: phone.isEmpty ? nil : phone,
                    packageNumber: packageNumber.isEmpty ? nil : packageNumber,
                    priority: priority,
                    serviceMinutes: serviceMinutes,
                    source: source,
                    allowDuplicate: allowDuplicate ? true : nil
                )
                // 本文が変わる（allowDuplicate）ため、重複確認後の再送は新しいキーを使う
                saved = try await env.api.addStop(stop, idempotencyKey: IdempotencyKey.generate())
            }
            // サーバーが重複候補として登録した場合（duplicateOfStopId）は一覧に警告を表示する
            onSaved(saved)
            dismiss()
        } catch let error as APIError where !isEditing && (error.status == 409 || error.code?.contains("duplicate") == true) {
            duplicateWarning = "\(error.userMessage)\n同じ住所への配達が既に登録されています。別の荷物であれば重複を承知で登録できます。"
        } catch let error as APIError where error.status == 409 {
            errorMessage = "他の端末で更新されています。一覧を更新してから編集し直してください。"
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}
