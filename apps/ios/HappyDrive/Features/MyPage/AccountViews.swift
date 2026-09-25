import CoreLocation
import SwiftUI
import UserNotifications
import HappyDriveCore

// MARK: - アカウント・設定

struct AccountSettingsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var displayName = ""
    @State private var savingName = false
    @State private var alert: AlertMessage?

    var body: some View {
        List {
            if let user = env.session.user {
                Section("表示名") {
                    TextField("表示名", text: $displayName)
                        .onAppear { if displayName.isEmpty { displayName = user.displayName } }
                    Button {
                        Task { await saveName() }
                    } label: {
                        ProgressLabel(title: "表示名を保存", isLoading: savingName)
                    }
                    .disabled(savingName || displayName.trimmingCharacters(in: .whitespaces).isEmpty || displayName == user.displayName)
                }
                Section("登録情報") {
                    if let phone = user.phoneMasked { InfoRow(title: "電話番号", value: phone) }
                    NavigationLink("本人情報") { ProfileFormView(user: user, mode: .edit) }
                    NavigationLink("車両情報") { VehicleFormView(user: user, mode: .edit) }
                    NavigationLink("振込先口座") { BankAccountFormView(user: user, mode: .edit) }
                    NavigationLink("本人確認") { VerificationCenterView() }
                }
                Section("プライバシーと通知") {
                    NavigationLink("マッチング・通知の設定") { PreferencesView(user: user) }
                    NavigationLink("位置情報・通知の許可") { PermissionsView() }
                }
            }
            Section("規約") {
                if let url = env.config.termsURL { Link("利用規約", destination: url) }
                if let url = env.config.privacyURL { Link("プライバシーポリシー", destination: url) }
                NavigationLink("ライセンス") { LicensesView() }
            }
            Section {
                NavigationLink {
                    AccountDeletionView()
                } label: {
                    Text("退会（アカウント削除）").foregroundStyle(HDColor.danger)
                }
            } footer: {
                Text("アプリのバージョン \(env.config.appVersion)")
            }
        }
        .navigationTitle("アカウント・設定")
        .hdAlert($alert)
    }

    private func saveName() async {
        savingName = true
        defer { savingName = false }
        do {
            let user = try await env.api.updateDisplayName(String(displayName.trimmingCharacters(in: .whitespaces).prefix(60)))
            env.session.update(user)
            alert = AlertMessage(title: "保存しました", message: "表示名を更新しました。")
        } catch {
            alert = AlertMessage(error: error)
        }
    }
}

struct LicensesView: View {
    var body: some View {
        List {
            Section("Noto Sans JP") {
                Text("Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. This Font Software is licensed under the SIL Open Font License, Version 1.1.")
                    .font(.hd(.footnote))
            }
            Section("swift-crypto") {
                Text("Copyright (c) Apple Inc. Licensed under the Apache License, Version 2.0.")
                    .font(.hd(.footnote))
            }
        }
        .navigationTitle("ライセンス")
    }
}

// MARK: - マッチング・通知の設定

struct PreferencesView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var prefs: Preferences
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(user: User) {
        let p = user.preferences ?? Preferences()
        _prefs = State(initialValue: Preferences(
            useLocationForMatching: p.useLocationForMatching ?? true,
            useHistoryForMatching: p.useHistoryForMatching ?? true,
            preferredCategories: p.preferredCategories ?? [],
            maxDistanceKm: p.maxDistanceKm ?? 10,
            notifyNewJobs: p.notifyNewJobs ?? true,
            notifyMessages: p.notifyMessages ?? true,
            showRatingToOrganizations: p.showRatingToOrganizations ?? true
        ))
    }

    private func binding(_ keyPath: WritableKeyPath<Preferences, Bool?>) -> Binding<Bool> {
        Binding(get: { prefs[keyPath: keyPath] ?? false }, set: { prefs[keyPath: keyPath] = $0 })
    }

    var body: some View {
        Form {
            Section {
                Toggle("位置情報をおすすめに使う", isOn: binding(\.useLocationForMatching))
                Toggle("これまでの実績をおすすめに使う", isOn: binding(\.useHistoryForMatching))
            } header: {
                Text("おすすめ（AIマッチング）")
            } footer: {
                Text("オフにしても案件の検索はできます。おすすめの理由は案件ごとに表示され、判定に異議がある場合は申し立てできます。")
            }
            Section("希望する仕事") {
                ForEach(JobCategory.searchable, id: \.self) { c in
                    Toggle(c.label, isOn: Binding(
                        get: { prefs.preferredCategories?.contains(c) ?? false },
                        set: { on in
                            var list = prefs.preferredCategories ?? []
                            if on { if !list.contains(c) { list.append(c) } } else { list.removeAll { $0 == c } }
                            prefs.preferredCategories = list
                        }
                    ))
                }
                VStack(alignment: .leading) {
                    Text("移動できる距離 \(Int(prefs.maxDistanceKm ?? 10)) km まで")
                    Slider(value: Binding(get: { prefs.maxDistanceKm ?? 10 }, set: { prefs.maxDistanceKm = $0.rounded() }), in: 1...100, step: 1)
                        .accessibilityLabel("移動できる距離（キロメートル）")
                }
            }
            Section("通知") {
                Toggle("新しい案件のお知らせ", isOn: binding(\.notifyNewJobs))
                Toggle("メッセージのお知らせ", isOn: binding(\.notifyMessages))
            }
            Section("公開範囲") {
                Toggle("評価を発注者に表示する", isOn: binding(\.showRatingToOrganizations))
            }
            if let errorMessage {
                Section { NoticeBox(kind: .danger, text: errorMessage) }
            }
            Section {
                Button {
                    Task { await save() }
                } label: {
                    ProgressLabel(title: "保存する", isLoading: isSaving)
                }
                .buttonStyle(.hdPrimary)
                .disabled(isSaving)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("マッチング・通知")
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let user = try await env.api.updatePreferences(prefs)
            env.session.update(user)
            if prefs.notifyNewJobs == true || prefs.notifyMessages == true {
                await env.push.requestAuthorizationIfNeeded()
            }
            dismiss()
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

// MARK: - 権限

struct PermissionsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined

    var body: some View {
        List {
            Section {
                InfoRow(title: "現在の設定", value: env.location.statusText)
                if env.location.authorization == .notDetermined {
                    Button("位置情報の利用を許可する") { env.location.requestWhenInUse() }
                } else {
                    Button("設定アプリで変更する") { SystemSettings.open() }
                }
            } header: {
                Text("位置情報")
            } footer: {
                Text("案件の検索（おおよその位置）、配送中の安全のための速度判定、業務中のチェックインと発注者への限定共有に使います。アプリを使っていない間は取得しません。オフでもエリア名で案件を検索できます。")
            }
            Section {
                InfoRow(title: "現在の設定", value: notificationText)
                if notificationStatus == .notDetermined {
                    Button("通知を許可する") {
                        Task {
                            await env.push.requestAuthorizationIfNeeded()
                            notificationStatus = await env.push.authorizationStatus()
                        }
                    }
                } else {
                    Button("設定アプリで変更する") { SystemSettings.open() }
                }
            } header: {
                Text("通知")
            } footer: {
                Text("受諾の結果、検収、振込、メッセージなどをお知らせします。通知がオフでもアプリ内の「通知」で確認できます。")
            }
            Section {
                Text("カメラは配達・業務の証跡写真、本人確認書類の撮影、伝票の住所読み取りにのみ使います。")
                    .font(.hd(.footnote))
                Button("設定アプリを開く") { SystemSettings.open() }
            } header: {
                Text("カメラ")
            }
        }
        .navigationTitle("位置情報・通知の許可")
        .task { notificationStatus = await env.push.authorizationStatus() }
    }

    private var notificationText: String {
        switch notificationStatus {
        case .authorized: return "許可"
        case .denied: return "許可されていません"
        case .provisional: return "仮許可"
        case .ephemeral: return "一時的に許可"
        case .notDetermined: return "未設定"
        @unknown default: return "不明"
        }
    }
}

// MARK: - 資格

struct SkillsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var catalog: LoadState<[SkillDefinition]> = .idle
    @State private var submitting: SkillDefinition?

    var body: some View {
        List {
            Section("保有資格") {
                let skills = env.session.user?.skillDetails ?? []
                if skills.isEmpty {
                    Text("登録された資格はありません").foregroundStyle(HDColor.textSecondary)
                }
                ForEach(skills) { SkillRow(skill: $0) }
            }
            switch catalog {
            case .idle, .loading:
                Section { LoadingStateView() }
            case .failed(let m):
                Section { ErrorStateView(message: m) { Task { await load() } } }
            case .loaded(let defs):
                Section {
                    ForEach(defs) { d in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(d.name).font(.hd(.body, .semibold))
                            if let desc = d.description { Text(desc).font(.hd(.footnote)).foregroundStyle(HDColor.textSecondary) }
                            if d.source == "training", let courseId = d.courseId {
                                Button("講習を受ける") { env.router.push(.course(courseId), on: .learn) }
                                    .frame(minHeight: 44)
                            } else if d.source == "document" {
                                Button("資格証を提出する") { submitting = d }
                                    .frame(minHeight: 44)
                            }
                        }
                    }
                } header: {
                    Text("取得・提出できる資格")
                } footer: {
                    Text("資格証は運営が確認し、確認後に有効になります。有効期限が近づくと通知でお知らせします。")
                }
            }
        }
        .navigationTitle("資格・講習")
        .task { await load() }
        .refreshable {
            await load()
            await env.session.refreshUser()
        }
        .sheet(item: $submitting) { d in
            SubmitSkillView(definition: d) { Task { await env.session.refreshUser() } }
        }
    }

    private func load() async {
        if catalog.value == nil { catalog = .loading }
        do {
            catalog = .loaded(try await env.api.skillCatalog())
        } catch {
            catalog = .failed(error.hdUserMessage)
        }
    }
}

struct SubmitSkillView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let definition: SkillDefinition
    let onDone: () -> Void

    @State private var photos: [PhotoAttachment] = []
    @State private var hasExpiry = false
    @State private var validUntil = Calendar.current.date(byAdding: .year, value: 1, to: Date()) ?? Date()
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var key = IdempotencyKey.generate()
    @State private var uploaded: [UUID: String] = [:]

    var body: some View {
        NavigationStack {
            Form {
                Section(definition.name) {
                    PhotoAttachmentPicker(attachments: $photos, maxCount: 4, title: "資格証を撮影", privacyNote: "資格証全体が写り、文字が読めることを確認してください。")
                }
                Section {
                    Toggle("有効期限がある", isOn: $hasExpiry)
                    if hasExpiry {
                        DatePicker("有効期限", selection: $validUntil, in: Date()..., displayedComponents: .date)
                            .environment(\.timeZone, HDFormat.jst)
                    }
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        ProgressLabel(title: "提出する", isLoading: isSubmitting)
                    }
                    .buttonStyle(.hdPrimary)
                    .disabled(photos.isEmpty || isSubmitting)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("資格証の提出")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
            }
        }
    }

    private func submit() async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            var ids: [String] = []
            for p in photos {
                if let id = uploaded[p.id] { ids.append(id); continue }
                let ev = try await env.api.uploadEvidence(data: p.data, contentType: p.contentType, purpose: .skill_document)
                uploaded[p.id] = ev.id
                ids.append(ev.id)
            }
            _ = try await env.api.submitSkill(SkillSubmission(skillCode: definition.code, validUntil: hasExpiry ? HDFormat.apiDate(validUntil) : nil, documentEvidenceIds: ids), idempotencyKey: key)
            onDone()
            dismiss()
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

// MARK: - ヘルプ・お問い合わせ

struct SupportView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var tickets: LoadState<[SupportTicket]> = .idle
    @State private var showNew = false
    @State private var showAppeal = false

    var body: some View {
        List {
            Section {
                Button {
                    showNew = true
                } label: {
                    Label("問い合わせる", systemImage: "square.and.pencil")
                }
                Button {
                    showAppeal = true
                } label: {
                    Label("おすすめ・条件判定への異議申立て", systemImage: "questionmark.bubble")
                }
                if let url = env.config.supportURL {
                    Link(destination: url) { Label("よくある質問", systemImage: "book") }
                }
            } footer: {
                Text("緊急時は110番・119番へ通報してください。業務中の危険は業務画面の「危険を報告」から運営へ即時に通知できます。")
            }
            switch tickets {
            case .idle, .loading:
                Section { LoadingStateView() }
            case .failed(let m):
                Section { ErrorStateView(message: m) { Task { await load() } } }
            case .loaded(let list):
                Section("これまでの問い合わせ") {
                    if list.isEmpty { Text("問い合わせはありません").foregroundStyle(HDColor.textSecondary) }
                    ForEach(list) { t in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text((SupportCategory(rawValue: t.category) ?? .other).label).font(.hd(.subheadline, .semibold))
                                Spacer()
                                StatusBadge(presentation: t.status.presentation, compact: true)
                            }
                            Text(t.body).font(.hd(.subheadline)).lineLimit(3)
                            if let answer = t.answer {
                                Text("回答：\(answer)").font(.hd(.subheadline)).foregroundStyle(HDColor.brandBlue)
                            }
                            Text(HDFormat.dateTime(t.createdAt)).font(.hd(.caption)).foregroundStyle(HDColor.textSecondary)
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationTitle("ヘルプ・お問い合わせ")
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showNew) {
            NewTicketView { Task { await load() } }
        }
        .sheet(isPresented: $showAppeal, onDismiss: { Task { await load() } }) {
            MatchingAppealSheet(jobId: nil)
        }
    }

    private func load() async {
        if tickets.value == nil { tickets = .loading }
        do {
            tickets = .loaded(try await env.api.supportTickets().sorted { $0.createdAt > $1.createdAt })
        } catch {
            tickets = .failed(error.hdUserMessage)
        }
    }
}

struct NewTicketView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let onDone: () -> Void

    @State private var category: SupportCategory = .job
    @State private var text = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var key = IdempotencyKey.generate()

    var body: some View {
        NavigationStack {
            Form {
                Picker("種類", selection: $category) {
                    ForEach(SupportCategory.selectable, id: \.self) { Text($0.label).tag($0) }
                }
                Section {
                    TextField("お問い合わせ内容", text: $text, axis: .vertical)
                        .lineLimit(5...10)
                } footer: {
                    Text("パスワードや口座番号などは記載しないでください。")
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
            }
            .navigationTitle("問い合わせ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("送信") { Task { await send() } }
                        .disabled(isSending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func send() async {
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            _ = try await env.api.createSupportTicket(SupportTicketInput(category: category, body: String(text.prefix(4000))), idempotencyKey: key)
            onDone()
            dismiss()
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

// MARK: - 退会

/// 退会（アプリ内で完結）。1段目で保持例外と阻害要因を確認し、2段目で確定する。
struct AccountDeletionView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var reason = ""
    @State private var preview: DeletionRequest?
    @State private var understood = false
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var blockers: [String] = []
    @State private var confirmKey = IdempotencyKey.generate()
    @State private var completed: DeletionRequest?

    var body: some View {
        Form {
            if let completed {
                Section {
                    NoticeBox(kind: .success, text: "退会の手続きを受け付けました。")
                    Text(completed.retentionNotice).font(.hd(.subheadline))
                    Button("閉じる") { Task { await env.finishAccountDeletion() } }
                        .buttonStyle(.hdPrimary)
                }
            } else {
                Section {
                    Text("退会すると、アカウントと登録情報が削除され、同じアカウントでログインできなくなります。")
                        .font(.hd(.body))
                    TextField("退会の理由（任意）", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                }
                if let preview {
                    Section("保管される情報") {
                        Text(preview.retentionNotice).font(.hd(.subheadline))
                    }
                }
                if !blockers.isEmpty {
                    Section("退会の前に必要なこと") {
                        ForEach(blockers, id: \.self) { b in
                            Label(b, systemImage: "exclamationmark.triangle.fill")
                                .font(.hd(.subheadline))
                                .foregroundStyle(HDColor.warning)
                        }
                        Text("進行中の業務の完了・キャンセル、未払い報酬の振込が終わると退会できます。")
                            .font(.hd(.footnote))
                            .foregroundStyle(HDColor.textSecondary)
                    }
                }
                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
                if preview == nil {
                    Section {
                        Button {
                            Task { await requestPreview() }
                        } label: {
                            ProgressLabel(title: "退会の条件を確認する", isLoading: isWorking)
                        }
                        .buttonStyle(.hdSecondary)
                        .disabled(isWorking)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    }
                } else if blockers.isEmpty {
                    Section {
                        Toggle("上記の内容を理解し、退会します", isOn: $understood)
                        Button {
                            Task { await confirm() }
                        } label: {
                            ProgressLabel(title: "退会する", isLoading: isWorking)
                        }
                        .buttonStyle(.hdDanger)
                        .disabled(!understood || isWorking)
                    }
                }
            }
        }
        .navigationTitle("退会")
        .interactiveDismissDisabled(isWorking)
    }

    private var trimmedReason: String? {
        let t = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : String(t.prefix(1000))
    }

    private func requestPreview() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let r = try await env.api.requestAccountDeletion(confirm: false, reason: trimmedReason, idempotencyKey: IdempotencyKey.generate())
            preview = r
            blockers = r.blockers ?? []
            if r.status == .completed { completed = r }
        } catch let error as APIError where error.status == 409 {
            blockers = error.details?["blockers"]?.stringArray ?? [error.userMessage]
            preview = DeletionRequest(id: nil, userId: nil, status: .confirmation_required, requestedAt: nil, completedAt: nil, retentionNotice: error.details?["retentionNotice"]?.stringValue ?? "", blockers: blockers)
        } catch {
            errorMessage = error.hdUserMessage
        }
    }

    private func confirm() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let r = try await env.api.requestAccountDeletion(confirm: true, reason: trimmedReason, idempotencyKey: confirmKey)
            completed = r
        } catch let error as APIError where error.status == 409 {
            blockers = error.details?["blockers"]?.stringArray ?? [error.userMessage]
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}
