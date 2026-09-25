import SwiftUI
import HappyDriveCore

struct StopDetailView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let stopId: String

    @State private var stop: Stop?
    @State private var leg: RouteLeg?
    @State private var loadError: String?
    @State private var isOfflineCopy = false
    @State private var isSending = false
    @State private var sheet: Sheet?
    @State private var alert: AlertMessage?
    @State private var contact: StopContact?
    @State private var loadingContact = false
    @State private var confirmDelete = false
    @State private var queuedNotice: String?

    enum Sheet: Identifiable {
        case complete, fail, edit
        var id: Int { hashValue }
    }

    var body: some View {
        Group {
            if let stop {
                content(stop)
            } else if let loadError {
                ErrorStateView(message: loadError) { Task { await load() } }
            } else {
                LoadingStateView()
            }
        }
        .navigationTitle("配達先の詳細")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let stop, stop.status.isEditable {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            sheet = .edit
                        } label: {
                            Label(stop.hasLocation ? "編集" : "位置を確定・編集", systemImage: "pencil")
                        }
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("削除", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").accessibilityLabel("その他の操作")
                    }
                    .disabled(env.location.isDriving)
                }
            }
        }
        .task { await load() }
        .sheet(item: $sheet) { s in
            if let stop {
                switch s {
                case .complete:
                    DeliveryCompletionView(stop: stop) { updated, queued in handleUpdated(updated, queued: queued) }
                case .fail:
                    StopFailureView(stop: stop) { updated, queued in handleUpdated(updated, queued: queued) }
                case .edit:
                    AddStopView(date: stop.scheduledDate, existing: stop) { updated in
                        self.stop = updated
                    }
                }
            }
        }
        .confirmationDialog("この配送先を削除しますか？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("削除する", role: .destructive) { Task { await delete() } }
        }
        .confirmationDialog("受取人に電話", isPresented: Binding(get: { contact != nil }, set: { if !$0 { contact = nil } }), titleVisibility: .visible, presenting: contact) { c in
            Button("\(c.recipientName ?? "受取人")（\(c.recipientPhone)）に発信") { SystemSettings.call(c.recipientPhone) }
        } message: { _ in
            Text("番号の取得は記録されます。配達に必要な連絡にのみ使用してください。")
        }
        .hdAlert($alert)
    }

    @ViewBuilder
    private func content(_ stop: Stop) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HDSpacing.lg) {
                if isOfflineCopy {
                    NoticeBox(kind: .info, text: "圏外のため保存済みの情報を表示しています。")
                }
                if let queuedNotice {
                    NoticeBox(kind: .info, text: queuedNotice)
                }
                if env.pendingCount(entityKey: "stop:\(stop.id)") > 0 {
                    Label("送信待ちの記録があります。通信が回復すると自動で送信します。", systemImage: "arrow.triangle.2.circlepath")
                        .font(.hd(.footnote))
                        .foregroundStyle(HDColor.brandBlue)
                }

                HDCard {
                    StatusBadge(presentation: stop.status.presentation)
                    Text(stop.address)
                        .font(.hd(.title2, .bold))
                        .foregroundStyle(HDColor.textPrimary)
                        .textSelection(.enabled)
                    if let s = stop.timeWindowStart, let e = stop.timeWindowEnd {
                        InfoRow(title: "指定時間", value: HDFormat.timeRange(s, e), systemImage: "clock")
                    }
                    if let leg {
                        InfoRow(title: "到着見込み", value: HDFormat.time(leg.arrivalAt), systemImage: "car")
                    } else if let eta = stop.estimatedArrivalAt {
                        InfoRow(title: "到着見込み", value: HDFormat.time(eta), systemImage: "car")
                    }
                    if stop.priority > 0 {
                        InfoRow(title: "優先度", value: StopPriorityLabel.label(stop.priority), systemImage: "flag")
                    }
                    if !stop.hasLocation {
                        NoticeBox(kind: .warning, text: "位置が未確定です。右上のメニューから住所の候補を確定してください。")
                    }
                }

                if let point = stop.location {
                    SinglePointMap(point: point, title: stop.address)
                        .frame(height: 220)
                        .clipShape(RoundedRectangle(cornerRadius: HDRadius.card))
                }

                HDCard {
                    Text("配達メモ・受け渡し").font(.hd(.headline, .bold))
                    Text(stop.note?.isEmpty == false ? stop.note! : "メモはありません")
                        .font(.hd(.body))
                        .foregroundStyle(stop.note?.isEmpty == false ? HDColor.textPrimary : HDColor.textSecondary)
                    if let pkg = stop.packageNumber {
                        InfoRow(title: "荷物番号", value: pkg, systemImage: "shippingbox")
                    }
                    if let name = stop.recipientName {
                        InfoRow(title: "受取人", value: name, systemImage: "person")
                    }
                    InfoRow(title: "作業時間", value: "\(stop.serviceMinutes)分", systemImage: "timer")
                }

                if stop.status.isTerminal {
                    resultCard(stop)
                }

                actions(stop)
            }
            .padding(HDSpacing.lg)
        }
        .hdScreenBackground()
        .refreshable { await load() }
    }

    private func resultCard(_ stop: Stop) -> some View {
        HDCard {
            Text("配達結果").font(.hd(.headline, .bold))
            if let at = stop.completedAt {
                InfoRow(title: "記録時刻", value: HDFormat.dateTime(at))
            }
            if let h = stop.handoff, let type = HandoffType(rawValue: h) {
                InfoRow(title: "受け渡し", value: type.label)
            }
            if let r = stop.failureReason, let reason = FailureReason(rawValue: r) {
                InfoRow(title: "理由", value: reason.label)
            }
            if let note = stop.failureNote { Text(note).font(.hd(.subheadline)) }
            if let until = stop.deferredUntil {
                InfoRow(title: "再配達", value: HDFormat.dateTime(until))
            }
            if let count = stop.evidenceIds?.count, count > 0 {
                InfoRow(title: "証跡", value: "\(count)件")
            }
        }
    }

    @ViewBuilder
    private func actions(_ stop: Stop) -> some View {
        VStack(spacing: HDSpacing.sm) {
            if let point = stop.location, !stop.status.isTerminal {
                Button {
                    AppleMaps.navigate(to: point, name: stop.address)
                } label: {
                    Label("Appleマップで案内", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                }
                .buttonStyle(.hdPrimary)
            }
            if stop.hasRecipientPhone && !stop.status.isTerminal {
                Button {
                    Task { await fetchContact() }
                } label: {
                    ProgressLabel(title: "受取人に電話", systemImage: "phone.fill", isLoading: loadingContact)
                }
                .buttonStyle(.hdSecondary)
            }
            switch stop.status {
            case .draft, .ready:
                Button {
                    Task { await send(StopEventRequest(eventType: .en_route, occurredAt: Date())) }
                } label: {
                    ProgressLabel(title: "この配達先へ向かう", systemImage: "car.fill", isLoading: isSending)
                }
                .buttonStyle(.hdSecondary)
                .disabled(isSending || stop.status == .draft && !stop.hasLocation)
            case .en_route:
                Button {
                    Task {
                        let here = await currentPoint()
                        await send(StopEventRequest(eventType: .arrived, location: here, occurredAt: Date()))
                    }
                } label: {
                    ProgressLabel(title: "到着した", systemImage: "mappin.circle.fill", isLoading: isSending)
                }
                .buttonStyle(.hdSecondary)
                .disabled(isSending)
                completionButtons
            case .arrived:
                completionButtons
            default:
                EmptyView()
            }
        }
    }

    private var completionButtons: some View {
        VStack(spacing: HDSpacing.sm) {
            Button {
                sheet = .complete
            } label: {
                Label("配達を完了する", systemImage: "checkmark.circle.fill")
            }
            .buttonStyle(.hdJob)
            .accessibilityIdentifier("completeDeliveryButton")
            Button {
                sheet = .fail
            } label: {
                Label("持ち戻り・未配達", systemImage: "arrow.uturn.backward")
            }
            .buttonStyle(.hdSecondary)
        }
        .disabled(env.location.isDriving)
    }

    // MARK: 処理

    private func load() async {
        do {
            let s = try await env.api.stop(id: stopId)
            stop = s
            isOfflineCopy = false
            loadError = nil
            if let route = try? await env.api.route(date: s.scheduledDate) {
                leg = route.legs?.first(where: { $0.stopId == stopId })
            }
        } catch {
            if let cached = env.deliveryCache.load(), let s = cached.stops.first(where: { $0.id == stopId }) {
                stop = s
                leg = cached.route?.legs?.first(where: { $0.stopId == stopId })
                isOfflineCopy = true
            } else if stop == nil {
                loadError = error.hdUserMessage
            }
        }
    }

    private func currentPoint() async -> GeoPoint? {
        guard env.location.isAuthorized, let l = await env.location.currentLocation() else { return nil }
        return GeoPoint(latitude: l.coordinate.latitude, longitude: l.coordinate.longitude)
    }

    private func send(_ event: StopEventRequest) async {
        guard let stop else { return }
        isSending = true
        defer { isSending = false }
        do {
            let r = try await env.submitStopEvent(stop: stop, event: event)
            handleUpdated(r.stop, queued: r.queued)
        } catch {
            alert = AlertMessage(error: error)
        }
    }

    private func handleUpdated(_ updated: Stop, queued: Bool) {
        stop = updated
        queuedNotice = queued ? "圏外のため記録を端末に保存しました。通信が回復すると自動で送信します。" : nil
        // キャッシュにも反映
        if var cache = env.deliveryCache.load(), let i = cache.stops.firstIndex(where: { $0.id == updated.id }) {
            cache.stops[i] = updated
            try? env.deliveryCache.save(cache)
        }
    }

    private func fetchContact() async {
        loadingContact = true
        defer { loadingContact = false }
        do {
            contact = try await env.api.stopContact(id: stopId)
        } catch let error as APIError where error.status == 410 {
            alert = AlertMessage(message: "保管期限が過ぎたため、連絡先は表示できません。")
        } catch {
            alert = AlertMessage(error: error)
        }
    }

    private func delete() async {
        do {
            try await env.api.deleteStop(id: stopId)
            if var cache = env.deliveryCache.load() {
                cache.stops.removeAll { $0.id == stopId }
                try? env.deliveryCache.save(cache)
            }
            dismiss()
        } catch {
            alert = AlertMessage(error: error)
        }
    }
}

// MARK: - 配達完了

struct DeliveryCompletionView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let stop: Stop
    let onDone: (Stop, Bool) -> Void

    @State private var handoff: HandoffType = .in_person
    @State private var photos: [PhotoAttachment] = []
    @State private var signature: PhotoAttachment?
    @State private var showSignature = false
    @State private var isSending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("受け渡し方法") {
                    Picker("受け渡し方法", selection: $handoff) {
                        ForEach(HandoffType.allCases, id: \.self) { h in
                            Label(h.label, systemImage: h.symbol).tag(h)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section {
                    PhotoAttachmentPicker(attachments: $photos, maxCount: 3, title: "配達写真を追加", privacyNote: "表札や受取人の顔など、個人情報が写らないようにしてください。")
                } header: {
                    Text("配達写真")
                } footer: {
                    if handoff != .in_person && photos.isEmpty {
                        Text("置き配・宅配ボックス等の場合は、配達場所の写真を残すことをおすすめします。")
                    }
                }
                Section("受領サイン（任意）") {
                    if let signature {
                        Image(uiImage: signature.thumbnail)
                            .resizable()
                            .scaledToFit()
                            .frame(height: 80)
                            .accessibilityLabel("受領サイン")
                        Button("サインを消す", role: .destructive) { self.signature = nil }
                    } else {
                        Button {
                            showSignature = true
                        } label: {
                            Label("サインをもらう", systemImage: "signature")
                        }
                    }
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        ProgressLabel(title: "配達完了を記録", isLoading: isSending)
                    }
                    .buttonStyle(.hdJob)
                    .disabled(isSending)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("配達完了")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
            }
            .sheet(isPresented: $showSignature) {
                SignaturePadView { sig in signature = sig }
            }
            .drivingLocked(env.location.isDriving)
        }
    }

    private func submit() async {
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        var location: GeoPoint?
        if env.location.isAuthorized, let l = await env.location.currentLocation() {
            location = GeoPoint(latitude: l.coordinate.latitude, longitude: l.coordinate.longitude)
        }
        let event = StopEventRequest(eventType: .delivered, handoff: handoff, location: location, occurredAt: Date())
        do {
            let r = try await env.submitStopEvent(stop: stop, event: event, photos: photos, signature: signature)
            onDone(r.stop, r.queued)
            dismiss()
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

// MARK: - 持ち戻り・未配達

struct StopFailureView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let stop: Stop
    let onDone: (Stop, Bool) -> Void

    @State private var reason: FailureReason = .absent
    @State private var note = ""
    @State private var redeliver = true
    @State private var deferredUntil = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    @State private var photos: [PhotoAttachment] = []
    @State private var isSending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("理由") {
                    Picker("理由", selection: $reason) {
                        ForEach(FailureReason.allCases, id: \.self) { r in Text(r.label).tag(r) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    TextField("補足（任意）", text: $note, axis: .vertical)
                        .lineLimit(2...4)
                }
                Section {
                    Toggle("再配達の予定を登録する（持ち戻り）", isOn: $redeliver)
                    if redeliver {
                        DatePicker("再配達日時", selection: $deferredUntil, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                            .environment(\.timeZone, HDFormat.jst)
                    }
                } footer: {
                    Text(redeliver ? "「再配達」として記録します。" : "「未配達」として記録します。")
                }
                Section("証跡写真（任意）") {
                    PhotoAttachmentPicker(attachments: $photos, maxCount: 2, title: "写真を追加", privacyNote: "不在票の投函場所など、必要な範囲だけを撮影してください。")
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        ProgressLabel(title: redeliver ? "持ち戻りを記録" : "未配達を記録", isLoading: isSending)
                    }
                    .buttonStyle(.hdPrimary)
                    .disabled(isSending)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("持ち戻り・未配達")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
            }
            .drivingLocked(env.location.isDriving)
        }
    }

    private func submit() async {
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let event = StopEventRequest(
            eventType: redeliver ? .deferred : .failed,
            failureReason: reason,
            failureNote: trimmed.isEmpty ? nil : String(trimmed.prefix(1000)),
            deferredUntil: redeliver ? deferredUntil : nil,
            occurredAt: Date()
        )
        do {
            let r = try await env.submitStopEvent(stop: stop, event: event, photos: photos)
            onDone(r.stop, r.queued)
            dismiss()
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}
