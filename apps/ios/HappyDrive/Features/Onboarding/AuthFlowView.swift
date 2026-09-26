import SwiftUI
import HappyDriveCore

/// サインインできなかった場合の画面。電話番号確認は行わず、この端末のアカウントに自動でサインインする。
/// 通常は起動時に自動でサインインしてメイン画面が開くため、この画面は通信エラー時・ログアウト後のみ表示される。
struct AuthFlowView: View {
    @Environment(AppEnvironment.self) private var env

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

                if let error = env.session.signInError {
                    NoticeBox(kind: .danger, text: error)
                }

                Button {
                    Task { await env.session.signInWithDevice() }
                } label: {
                    ProgressLabel(title: "はじめる", isLoading: env.session.isSigningIn)
                }
                .buttonStyle(.hdPrimary)
                .disabled(env.session.isSigningIn)
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
    }
}
