import SwiftUI
import HappyDriveCore

/// ログイン：ロゴ → 電話番号 → 確認コード（6桁）
struct AuthFlowView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var path: [AuthStep] = []

    enum AuthStep: Hashable {
        case phone
        case otp(phone: String, result: OTPRequestResult, sentAt: Date)
    }

    var body: some View {
        NavigationStack(path: $path) {
            WelcomeView(onStart: { path.append(.phone) })
                .navigationDestination(for: AuthStep.self) { step in
                    switch step {
                    case .phone:
                        PhoneEntryView { phone, result in
                            path.append(.otp(phone: phone, result: result, sentAt: Date()))
                        }
                    case .otp(let phone, let result, let sentAt):
                        OTPEntryView(phone: phone, initialResult: result, sentAt: sentAt)
                    }
                }
        }
    }
}

struct WelcomeView: View {
    @Environment(AppEnvironment.self) private var env
    let onStart: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: HDSpacing.xl) {
                Spacer(minLength: HDSpacing.xxl)
                Image("AppLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 120, height: 120)
                    .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                    .accessibilityHidden(true)
                Wordmark(height: 56)
                Text("配達と地域の仕事をひとつに")
                    .font(.hd(.title3, .bold))
                    .foregroundStyle(HDColor.textPrimary)
                    .multilineTextAlignment(.center)
                VStack(alignment: .leading, spacing: HDSpacing.md) {
                    feature("shippingbox.fill", "配送先の登録・ルート作成・配達記録", HDColor.brandBlue)
                    feature("heart.fill", "近くのHappy案件を探して受諾", HDColor.jobGreen)
                    feature("yensign.circle.fill", "報酬の確定状況と振込予定を確認", HDColor.brandBlue)
                }
                .padding(HDSpacing.lg)
                .background(HDColor.surface, in: RoundedRectangle(cornerRadius: HDRadius.card))

                if let notice = env.session.sessionExpiredNotice {
                    NoticeBox(kind: .warning, text: notice)
                }

                Button("電話番号ではじめる", action: onStart)
                    .buttonStyle(.hdPrimary)
                    .accessibilityIdentifier("startButton")

                HStack(spacing: HDSpacing.lg) {
                    if let url = env.config.termsURL { Link("利用規約", destination: url) }
                    if let url = env.config.privacyURL { Link("プライバシーポリシー", destination: url) }
                }
                .font(.hd(.footnote))
            }
            .padding(HDSpacing.xl)
        }
        .hdScreenBackground()
        .toolbar(.hidden, for: .navigationBar)
    }

    private func feature(_ symbol: String, _ text: String, _ color: Color) -> some View {
        Label {
            Text(text).font(.hd(.body)).foregroundStyle(HDColor.textPrimary)
        } icon: {
            Image(systemName: symbol).foregroundStyle(color)
        }
    }
}

struct PhoneEntryView: View {
    @Environment(AppEnvironment.self) private var env
    let onSent: (String, OTPRequestResult) -> Void

    @State private var phone = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    private var normalized: String { Validation.normalizePhone(phone) }
    private var isValid: Bool { Validation.isValidPhone(normalized) }

    var body: some View {
        Form {
            Section {
                TextField("09012345678", text: $phone)
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)
                    .font(.hd(.title3))
                    .focused($focused)
                    .accessibilityLabel("携帯電話番号")
                    .accessibilityIdentifier("phoneField")
            } header: {
                Text("携帯電話番号")
            } footer: {
                Text("SMSで6桁の確認コードを送ります。電話番号は発注者に公開されません。")
            }

            if let errorMessage {
                Section { NoticeBox(kind: .danger, text: errorMessage) }
            }

            Section {
                Button {
                    Task { await send() }
                } label: {
                    ProgressLabel(title: "確認コードを送信", isLoading: isSending)
                }
                .buttonStyle(.hdPrimary)
                .disabled(!isValid || isSending)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .accessibilityIdentifier("sendCodeButton")
            }
        }
        .navigationTitle("電話番号の確認")
        .onAppear { focused = true }
    }

    private func send() async {
        guard isValid else { return }
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            let result = try await env.api.requestOTP(phone: normalized)
            onSent(normalized, result)
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

struct OTPEntryView: View {
    @Environment(AppEnvironment.self) private var env
    let phone: String

    @State private var countdown: OTPResendCountdown
    @State private var code = ""
    @State private var isVerifying = false
    @State private var isResending = false
    @State private var errorMessage: String?
    @State private var infoMessage: String?
    @FocusState private var focused: Bool

    init(phone: String, initialResult: OTPRequestResult, sentAt: Date) {
        self.phone = phone
        _countdown = State(initialValue: OTPResendCountdown(sentAt: sentAt, result: initialResult))
    }

    var body: some View {
        Form {
            Section {
                TextField("123456", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .font(.hd(.title, .bold))
                    .monospacedDigit()
                    .focused($focused)
                    .onChange(of: code) { _, new in
                        let clean = Validation.sanitizeOTP(new)
                        if clean != new { code = clean }
                        if clean.count == 6 && !isVerifying { Task { await verify() } }
                    }
                    .accessibilityLabel("6桁の確認コード")
                    .accessibilityIdentifier("otpField")
            } header: {
                Text("確認コード")
            } footer: {
                Text("\(maskedPhone) に送信した6桁のコードを入力してください。")
            }

            if let errorMessage {
                Section { NoticeBox(kind: .danger, text: errorMessage) }
            }
            if let infoMessage {
                Section { NoticeBox(kind: .info, text: infoMessage) }
            }

            Section {
                Button {
                    Task { await verify() }
                } label: {
                    ProgressLabel(title: "確認してログイン", isLoading: isVerifying)
                }
                .buttonStyle(.hdPrimary)
                .disabled(!Validation.isValidOTP(code) || isVerifying)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .accessibilityIdentifier("verifyButton")

                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let remaining = countdown.remainingSeconds(now: context.date)
                    Button {
                        Task { await resend() }
                    } label: {
                        if remaining > 0 {
                            Text("コードを再送信（\(remaining)秒後）")
                        } else {
                            ProgressLabel(title: "コードを再送信", isLoading: isResending)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(remaining > 0 || isResending)
                    .accessibilityHint(remaining > 0 ? "\(remaining)秒後に再送信できます" : "")
                }
            }
        }
        .navigationTitle("確認コードの入力")
        .onAppear { focused = true }
    }

    private var maskedPhone: String {
        guard phone.count >= 4 else { return phone }
        return String(repeating: "•", count: phone.count - 4) + phone.suffix(4)
    }

    private func verify() async {
        guard Validation.isValidOTP(code), !isVerifying else { return }
        if countdown.isExpired(now: Date()) {
            errorMessage = "確認コードの有効期限が切れました。コードを再送信してください。"
            return
        }
        isVerifying = true
        errorMessage = nil
        defer { isVerifying = false }
        do {
            let result = try await env.api.verifyOTP(phone: phone, code: code, deviceName: SessionStore.deviceName)
            env.session.signedIn(result)
            env.syncPending()
        } catch {
            errorMessage = error.hdUserMessage
            code = ""
        }
    }

    private func resend() async {
        isResending = true
        errorMessage = nil
        defer { isResending = false }
        do {
            let result = try await env.api.requestOTP(phone: phone)
            countdown = OTPResendCountdown(sentAt: Date(), result: result)
            infoMessage = "確認コードを再送信しました。"
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}
