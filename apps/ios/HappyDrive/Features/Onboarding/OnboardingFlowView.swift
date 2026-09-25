import SwiftUI
import HappyDriveCore

/// 登録手順（規約同意 → 本人情報 → 車両 → 口座 → 本人確認書類 → 審査状況）
struct OnboardingFlowView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        NavigationStack {
            Group {
                if let user = env.session.user {
                    content(for: OnboardingFlow.nextStep(for: user), user: user)
                } else if let error = env.session.userLoadError {
                    ErrorStateView(message: error) { Task { await env.session.refreshUser() } }
                } else {
                    LoadingStateView()
                }
            }
            .toolbar {
                if canDefer {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("あとで") { env.session.onboardingDeferred = true }
                            .accessibilityHint("登録を後回しにして案件を見る。受諾には登録の完了が必要です。")
                            .accessibilityIdentifier("deferOnboardingButton")
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button("ログアウト", role: .destructive) { Task { await env.signOut() } }
                    } label: {
                        Image(systemName: "ellipsis.circle").accessibilityLabel("その他")
                    }
                }
            }
        }
    }

    private var canDefer: Bool {
        guard let step = env.session.onboardingStep else { return false }
        return step != .terms
    }

    @ViewBuilder
    private func content(for step: OnboardingStep, user: User) -> some View {
        switch step {
        case .terms:
            TermsConsentView()
        case .profile:
            ProfileFormView(user: user, mode: .onboarding)
        case .vehicle:
            VehicleFormView(user: user, mode: .onboarding)
        case .bankAccount:
            BankAccountFormView(user: user, mode: .onboarding)
        case .identityDocument:
            IdentityDocumentView(mode: .onboarding)
        case .verificationPending, .verificationRejected, .complete:
            VerificationStatusView(user: user)
        }
    }
}

/// 進捗表示（ステップ n / 5）
struct OnboardingProgressHeader: View {
    let step: OnboardingStep

    var body: some View {
        VStack(alignment: .leading, spacing: HDSpacing.xs) {
            Text("ステップ \(step.number) / \(OnboardingStep.totalInputSteps)")
                .font(.hd(.footnote, .semibold))
                .foregroundStyle(HDColor.brandBlue)
            ProgressView(value: Double(step.number), total: Double(OnboardingStep.totalInputSteps))
                .tint(HDColor.brandBlue)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("登録 ステップ\(step.number) / \(OnboardingStep.totalInputSteps)")
    }
}

enum FormMode {
    case onboarding
    case edit
}

// MARK: - 規約同意

struct TermsConsentView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var agreeTerms = false
    @State private var agreePrivacy = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section { OnboardingProgressHeader(step: .terms) }
            Section {
                Text("HappyDriveをご利用いただくには、利用規約とプライバシーポリシーへの同意が必要です。")
                    .font(.hd(.body))
                if let url = env.config.termsURL {
                    Link(destination: url) { Label("利用規約を読む", systemImage: "doc.text") }
                }
                if let url = env.config.privacyURL {
                    Link(destination: url) { Label("プライバシーポリシーを読む", systemImage: "hand.raised") }
                }
            }
            Section("位置情報・写真について") {
                Text("位置情報は、案件の検索（おおよその位置）と、業務中のチェックイン・発注者への限定共有（最新の1点のみ）にだけ使います。アプリを使っていない間は取得しません。")
                    .font(.hd(.subheadline))
                Text("配達や業務の写真は証跡として保存されます。依頼先の個人情報が写らないようにしてください。")
                    .font(.hd(.subheadline))
            }
            Section {
                Toggle("利用規約に同意します", isOn: $agreeTerms)
                    .accessibilityIdentifier("agreeTermsToggle")
                Toggle("プライバシーポリシーに同意します", isOn: $agreePrivacy)
                    .accessibilityIdentifier("agreePrivacyToggle")
            }
            if let errorMessage {
                Section { NoticeBox(kind: .danger, text: errorMessage) }
            }
            Section {
                Button {
                    Task { await save() }
                } label: {
                    ProgressLabel(title: "同意して次へ", isLoading: isSaving)
                }
                .buttonStyle(.hdPrimary)
                .disabled(!(agreeTerms && agreePrivacy) || isSaving)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .accessibilityIdentifier("acceptTermsButton")
            }
        }
        .navigationTitle("利用規約への同意")
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let user = try await env.api.acceptTerms(termsVersion: env.config.termsVersion, privacyVersion: env.config.privacyVersion)
            env.session.update(user)
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

// MARK: - 本人情報

struct ProfileFormView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let mode: FormMode

    @State private var legalName: String
    @State private var legalNameKana: String
    @State private var birthDate: Date
    @State private var postalCode: String
    @State private var address: String
    @State private var invoiceNumber: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(user: User, mode: FormMode) {
        self.mode = mode
        let p = user.profile
        _legalName = State(initialValue: p?.legalName ?? "")
        _legalNameKana = State(initialValue: p?.legalNameKana ?? "")
        let defaultBirth = Calendar(identifier: .gregorian).date(byAdding: .year, value: -30, to: Date()) ?? Date()
        _birthDate = State(initialValue: p?.birthDate.flatMap(HDFormat.parseAPIDate) ?? defaultBirth)
        _postalCode = State(initialValue: p?.postalCode ?? "")
        _address = State(initialValue: p?.address ?? "")
        _invoiceNumber = State(initialValue: p?.invoiceRegistrationNumber ?? "")
    }

    private var kana: String { Validation.hiraganaToKatakana(legalNameKana.trimmingCharacters(in: .whitespaces)) }
    private var postal: String { Validation.toHalfwidthASCII(postalCode).trimmingCharacters(in: .whitespaces) }
    private var invoice: String { Validation.toHalfwidthASCII(invoiceNumber).trimmingCharacters(in: .whitespaces).uppercased() }

    private var validationMessages: [String] {
        var m: [String] = []
        if legalName.trimmingCharacters(in: .whitespaces).isEmpty { m.append("氏名を入力してください") }
        if !Validation.isKatakanaName(kana) { m.append("フリガナはカタカナで入力してください") }
        if !Validation.isPostalCode(postal) { m.append("郵便番号は7桁で入力してください（例 231-0023）") }
        if address.trimmingCharacters(in: .whitespaces).count < 4 { m.append("住所を入力してください") }
        if !invoice.isEmpty && !Validation.isInvoiceNumber(invoice) { m.append("適格請求書発行事業者番号は T と13桁の数字です") }
        return m
    }

    var body: some View {
        Form {
            if mode == .onboarding { Section { OnboardingProgressHeader(step: .profile) } }
            Section {
                TextField("山田 太郎", text: $legalName)
                    .textContentType(.name)
                    .accessibilityLabel("氏名")
                TextField("ヤマダ タロウ", text: $legalNameKana)
                    .accessibilityLabel("フリガナ（カタカナ）")
                DatePicker("生年月日", selection: $birthDate, in: ...Date(), displayedComponents: .date)
                    .environment(\.locale, Locale(identifier: "ja_JP"))
                    .environment(\.timeZone, HDFormat.jst)
            } header: {
                Text("氏名・生年月日")
            } footer: {
                Text("本人確認書類と同じ内容を入力してください。本人情報は暗号化して保存され、発注者には公開されません。")
            }
            Section("住所") {
                TextField("231-0023", text: $postalCode)
                    .keyboardType(.numbersAndPunctuation)
                    .textContentType(.postalCode)
                    .accessibilityLabel("郵便番号")
                TextField("神奈川県横浜市中区山下町1-2-3", text: $address, axis: .vertical)
                    .textContentType(.fullStreetAddress)
                    .accessibilityLabel("住所")
            }
            Section {
                TextField("T1234567890123", text: $invoiceNumber)
                    .textInputAutocapitalization(.characters)
                    .accessibilityLabel("適格請求書発行事業者番号（任意）")
            } header: {
                Text("インボイス登録番号（任意）")
            } footer: {
                Text("業務委託の報酬明細に記載します。未登録の場合は空欄のままで構いません。")
            }
            if mode == .edit {
                Section { NoticeBox(kind: .info, text: "本人情報を変更すると、再審査が必要になる場合があります。") }
            }
            if let errorMessage {
                Section { NoticeBox(kind: .danger, text: errorMessage) }
            }
            Section {
                Button {
                    Task { await save() }
                } label: {
                    ProgressLabel(title: mode == .onboarding ? "保存して次へ" : "保存する", isLoading: isSaving)
                }
                .buttonStyle(.hdPrimary)
                .disabled(isSaving)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("本人情報")
    }

    private func save() async {
        if let first = validationMessages.first {
            errorMessage = validationMessages.count > 1 ? validationMessages.joined(separator: "\n") : first
            return
        }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        let input = ProfileInput(
            legalName: legalName.trimmingCharacters(in: .whitespaces),
            legalNameKana: kana,
            birthDate: HDFormat.apiDate(birthDate),
            postalCode: postal,
            address: address.trimmingCharacters(in: .whitespacesAndNewlines),
            invoiceRegistrationNumber: invoice.isEmpty ? nil : invoice
        )
        do {
            let user = try await env.api.updateProfile(input)
            env.session.update(user)
            if mode == .edit { dismiss() }
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

// MARK: - 車両

struct VehicleFormView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let mode: FormMode

    @State private var type: VehicleType
    @State private var plateNumber: String
    @State private var blackPlate: Bool
    @State private var capacityText: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(user: User, mode: FormMode) {
        self.mode = mode
        let v = user.vehicle
        _type = State(initialValue: v?.type == .unknown ? .kei_van : (v?.type ?? .kei_van))
        _plateNumber = State(initialValue: v?.plateNumber ?? "")
        _blackPlate = State(initialValue: v?.blackPlateRegistered ?? false)
        _capacityText = State(initialValue: v?.cargoCapacityKg.map(String.init) ?? "")
    }

    private var isCargoVehicle: Bool { type == .kei_van || type == .kei_truck }

    var body: some View {
        Form {
            if mode == .onboarding { Section { OnboardingProgressHeader(step: .vehicle) } }
            Section("車両の種類") {
                Picker("車両", selection: $type) {
                    ForEach(VehicleType.selectable, id: \.self) { t in
                        Text(t.label).tag(t)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            if type != .none && type != .bicycle {
                Section {
                    TextField("横浜 480 あ 12-34", text: $plateNumber)
                        .accessibilityLabel("ナンバー")
                    if isCargoVehicle {
                        Toggle("貨物軽自動車運送事業の届出済み（黒ナンバー）", isOn: $blackPlate)
                        TextField("最大積載量（kg）", text: $capacityText)
                            .keyboardType(.numberPad)
                            .accessibilityLabel("最大積載量（キログラム）")
                    }
                } header: {
                    Text("ナンバー・届出")
                } footer: {
                    Text("配送案件の適格判定に使います。")
                }
            }
            if let errorMessage {
                Section { NoticeBox(kind: .danger, text: errorMessage) }
            }
            Section {
                Button {
                    Task { await save() }
                } label: {
                    ProgressLabel(title: mode == .onboarding ? "保存して次へ" : "保存する", isLoading: isSaving)
                }
                .buttonStyle(.hdPrimary)
                .disabled(isSaving)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("車両情報")
    }

    private func save() async {
        var capacity: Int?
        if isCargoVehicle, !capacityText.isEmpty {
            guard let c = Int(Validation.toHalfwidthASCII(capacityText)), (0...5000).contains(c) else {
                errorMessage = "最大積載量は0〜5000の数字で入力してください"
                return
            }
            capacity = c
        }
        let plate = plateNumber.trimmingCharacters(in: .whitespaces)
        let vehicle = Vehicle(
            type: type,
            plateNumber: (type == .none || type == .bicycle || plate.isEmpty) ? nil : String(plate.prefix(30)),
            blackPlateRegistered: isCargoVehicle ? blackPlate : nil,
            cargoCapacityKg: capacity
        )
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let user = try await env.api.updateVehicle(vehicle)
            env.session.update(user)
            if mode == .edit { dismiss() }
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

// MARK: - 振込先口座

struct BankAccountFormView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let mode: FormMode
    let current: BankAccountMasked?

    @State private var bankCode = ""
    @State private var branchCode = ""
    @State private var accountType: BankAccountType = .ordinary
    @State private var accountNumber = ""
    @State private var holderKana = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(user: User, mode: FormMode) {
        self.mode = mode
        self.current = user.bankAccount
        _bankCode = State(initialValue: user.bankAccount?.bankCode ?? "")
        _branchCode = State(initialValue: user.bankAccount?.branchCode ?? "")
        _accountType = State(initialValue: BankAccountType(rawValue: user.bankAccount?.accountType ?? "") ?? .ordinary)
        _holderKana = State(initialValue: user.bankAccount?.holderNameKana ?? "")
    }

    private func digits(_ s: String) -> String { Validation.toHalfwidthASCII(s).filter(\.isNumber) }
    private var kana: String { Validation.hiraganaToKatakana(holderKana.trimmingCharacters(in: .whitespaces)) }

    var body: some View {
        Form {
            if mode == .onboarding { Section { OnboardingProgressHeader(step: .bankAccount) } }
            if let current, let last4 = current.accountNumberLast4 {
                Section("現在の登録") {
                    InfoRow(title: "口座", value: "\(current.bankCode ?? "") - \(current.branchCode ?? "")  ****\(last4)")
                }
            }
            Section {
                TextField("金融機関コード（4桁）", text: $bankCode)
                    .keyboardType(.numberPad)
                TextField("支店コード（3桁）", text: $branchCode)
                    .keyboardType(.numberPad)
                Picker("種別", selection: $accountType) {
                    ForEach(BankAccountType.selectable, id: \.self) { t in Text(t.label).tag(t) }
                }
                SecureField("口座番号（7桁）", text: $accountNumber)
                    .keyboardType(.numberPad)
                TextField("口座名義（カタカナ）", text: $holderKana)
            } header: {
                Text("振込先")
            } footer: {
                Text("報酬は検収で確定した後、振込予定日に振り込まれます。口座番号は暗号化して保存され、画面には末尾4桁のみ表示されます。")
            }
            if let errorMessage {
                Section { NoticeBox(kind: .danger, text: errorMessage) }
            }
            Section {
                Button {
                    Task { await save() }
                } label: {
                    ProgressLabel(title: mode == .onboarding ? "保存して次へ" : "保存する", isLoading: isSaving)
                }
                .buttonStyle(.hdPrimary)
                .disabled(isSaving)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("振込先口座")
    }

    private func save() async {
        let input = BankAccountInput(bankCode: digits(bankCode), branchCode: digits(branchCode), accountType: accountType, accountNumber: digits(accountNumber), holderNameKana: kana)
        var problems: [String] = []
        if !Validation.isBankCode(input.bankCode) { problems.append("金融機関コードは4桁の数字です") }
        if !Validation.isBranchCode(input.branchCode) { problems.append("支店コードは3桁の数字です") }
        if !Validation.isAccountNumber(input.accountNumber) { problems.append("口座番号は7桁の数字です") }
        if !Validation.isBankHolderKana(input.holderNameKana) { problems.append("口座名義はカタカナで入力してください") }
        guard problems.isEmpty else {
            errorMessage = problems.joined(separator: "\n")
            return
        }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let user = try await env.api.updateBankAccount(input)
            accountNumber = ""
            env.session.update(user)
            if mode == .edit { dismiss() }
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

// MARK: - 本人確認書類

struct IdentityDocumentView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let mode: FormMode

    @State private var photos: [PhotoAttachment] = []
    @State private var isSubmitting = false
    @State private var progressText: String?
    @State private var errorMessage: String?
    /// 再試行でも同じ申請として扱うためのキー（画面を開いている間は固定）
    @State private var submitKey = IdempotencyKey.generate()
    @State private var uploadedIds: [UUID: String] = [:]

    var body: some View {
        Form {
            if mode == .onboarding { Section { OnboardingProgressHeader(step: .identityDocument) } }
            Section {
                Text("運転免許証などの本人確認書類を撮影してください。表面と裏面の2枚をおすすめします（最大4枚）。")
                    .font(.hd(.body))
                PhotoAttachmentPicker(attachments: $photos, maxCount: 4, title: "書類を撮影", privacyNote: "書類全体が写り、文字が読めることを確認してください。")
            } header: {
                Text("本人確認書類")
            } footer: {
                Text("書類の画像は審査にのみ使用し、暗号化して保存します。")
            }
            if let progressText {
                Section { Label(progressText, systemImage: "arrow.up.circle") }
            }
            if let errorMessage {
                Section { NoticeBox(kind: .danger, text: errorMessage) }
            }
            Section {
                Button {
                    Task { await submit() }
                } label: {
                    ProgressLabel(title: "審査を申請する", isLoading: isSubmitting)
                }
                .buttonStyle(.hdPrimary)
                .disabled(photos.isEmpty || isSubmitting)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("本人確認")
    }

    private func submit() async {
        isSubmitting = true
        errorMessage = nil
        defer {
            isSubmitting = false
            progressText = nil
        }
        do {
            var ids: [String] = []
            for (i, photo) in photos.enumerated() {
                if let done = uploadedIds[photo.id] {
                    ids.append(done)
                    continue
                }
                progressText = "書類をアップロード中（\(i + 1) / \(photos.count)）"
                let evidence = try await env.api.uploadEvidence(data: photo.data, contentType: photo.contentType, purpose: .identity_document)
                uploadedIds[photo.id] = evidence.id
                ids.append(evidence.id)
            }
            progressText = "審査を申請しています"
            let user = try await env.api.submitVerification(documentEvidenceIds: ids, idempotencyKey: submitKey)
            env.session.update(user)
            if mode == .edit { dismiss() }
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

// MARK: - 審査状況

struct VerificationStatusView: View {
    @Environment(AppEnvironment.self) private var env
    let user: User
    var inOnboarding = true
    @State private var isRefreshing = false

    var body: some View {
        ScrollView {
            VStack(spacing: HDSpacing.xl) {
                StatusBadge(presentation: user.verificationStatus.presentation)
                switch user.verificationStatus {
                case .pending:
                    Image(systemName: "hourglass.circle.fill")
                        .font(.system(size: 72))
                        .foregroundStyle(HDColor.brandBlue)
                        .accessibilityHidden(true)
                    Text("本人確認の審査中です")
                        .font(.hd(.title2, .bold))
                    Text("審査結果は通知でお知らせします。審査中も案件や講習を見ることはできますが、受諾は承認後に可能になります。")
                        .font(.hd(.body))
                        .foregroundStyle(HDColor.textSecondary)
                        .multilineTextAlignment(.center)
                case .rejected:
                    Image(systemName: "exclamationmark.shield.fill")
                        .font(.system(size: 72))
                        .foregroundStyle(HDColor.danger)
                        .accessibilityHidden(true)
                    Text("書類の再提出が必要です")
                        .font(.hd(.title2, .bold))
                    if let note = user.verificationNote, !note.isEmpty {
                        NoticeBox(kind: .warning, text: "運営からのコメント：\(note)")
                    }
                    NavigationLink {
                        IdentityDocumentView(mode: .edit)
                    } label: {
                        Text("書類を再提出する")
                    }
                    .buttonStyle(.hdPrimary)
                default:
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 72))
                        .foregroundStyle(HDColor.jobGreen)
                        .accessibilityHidden(true)
                    Text("登録が完了しました")
                        .font(.hd(.title2, .bold))
                }

                Button {
                    Task {
                        isRefreshing = true
                        await env.session.refreshUser()
                        isRefreshing = false
                    }
                } label: {
                    ProgressLabel(title: "審査状況を更新", systemImage: "arrow.clockwise", isLoading: isRefreshing)
                }
                .buttonStyle(.hdSecondary)

                if inOnboarding {
                    Button("アプリを使いはじめる") {
                        env.session.onboardingDeferred = true
                    }
                    .buttonStyle(.hdPrimary)
                    .accessibilityIdentifier("startUsingAppButton")
                }
            }
            .padding(HDSpacing.xl)
        }
        .navigationTitle("審査状況")
        .refreshable { await env.session.refreshUser() }
    }
}

/// マイページからの本人確認（状態表示と再提出）
struct VerificationCenterView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        Group {
            if let user = env.session.user {
                switch OnboardingFlow.nextStep(for: user) {
                case .identityDocument:
                    IdentityDocumentView(mode: .edit)
                case .terms:
                    TermsConsentView()
                case .profile:
                    ProfileFormView(user: user, mode: .onboarding)
                case .vehicle:
                    VehicleFormView(user: user, mode: .onboarding)
                case .bankAccount:
                    BankAccountFormView(user: user, mode: .onboarding)
                default:
                    VerificationStatusView(user: user, inOnboarding: false)
                }
            } else {
                LoadingStateView()
            }
        }
        .task { await env.session.refreshUser() }
    }
}
