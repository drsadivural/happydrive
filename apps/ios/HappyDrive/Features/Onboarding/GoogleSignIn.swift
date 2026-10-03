import AuthenticationServices
import HappyDriveCore
import Security
import SwiftUI
import UIKit

@MainActor
private final class GoogleBrowserSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
    func open(_ url: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
                if let callback { continuation.resume(returning: callback) }
                else { continuation.resume(throwing: error ?? GoogleOAuthError.invalidCallback) }
            }
            auth.presentationContextProvider = self
            // Always ask for the account; allow Google's existing system-browser session.
            auth.prefersEphemeralWebBrowserSession = false
            session = auth
            if !auth.start() { continuation.resume(throwing: GoogleOAuthError.providerFailure) }
        }
    }
    func cancel() { session?.cancel(); session = nil }
}

struct GoogleSignInButton: View {
    @Environment(AppEnvironment.self) private var env
    var link = false
    var onSuccess: () -> Void = {}
    @State private var busy = false
    @State private var error: String?
    @State private var mfa: GoogleMFAChallenge?
    @State private var code = ""
    @State private var browser = GoogleBrowserSession()
    var body: some View {
        VStack(alignment: .leading) {
            Button { Task { await signIn() } } label: {
                HStack { Image(systemName: "person.crop.circle"); Text(link ? "Googleアカウントを連携" : "Gmail・Googleでログイン"); if busy { ProgressView() } }
            }.disabled(busy)
            if mfa != nil {
                Text("認証アプリの6桁のコードを入力してください")
                TextField("二段階認証コード", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                Button("確認してログイン") { Task { await verifyMFA() } }.disabled(busy || code.count != 6)
            }
            if let error { Text(error).foregroundStyle(HDColor.danger).accessibilityAddTraits(.updatesFrequently) }
        }.onDisappear { browser.cancel() }
    }
    private func verifyMFA() async {
        guard !busy, let challenge = mfa else { return }; busy = true; error = nil; defer { busy = false }
        do {
            let result = try await env.api.verifyGoogleMFA(challenge: challenge, code: code)
            mfa = nil; code = ""; env.session.signedIn(result); onSuccess()
        } catch { self.error = error.hdUserMessage }
    }
    private func randomString() throws -> String {
        var data = Data(count: 32)
        let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw GoogleOAuthError.providerFailure }
        return data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private func signIn() async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do {
            guard let clientId = env.config.googleClientId else { error = "Googleログインは準備中です。電話番号でログインしてください。"; return }
            let challenge = try await env.api.googleChallenge(link: link)
            guard challenge.clientId == clientId else { throw GoogleOAuthError.invalidConfiguration }
            let flow = try GoogleOAuthFlow(clientId: clientId, state: randomString(), verifier: randomString())
            let callback = try await browser.open(flow.authorizationURL(nonce: challenge.nonce), scheme: flow.redirectScheme)
            let code = try flow.authorizationCode(callback: callback)
            let (data, response) = try await URLSession.shared.data(for: flow.tokenRequest(code: code))
            guard (response as? HTTPURLResponse)?.statusCode == 200, Date() < challenge.expiresAt else { throw GoogleOAuthError.providerFailure }
            struct TokenResponse: Decodable { let id_token: String }
            let token = try JSONDecoder().decode(TokenResponse.self, from: data)
            let result = try await env.api.googleSignIn(challengeId: challenge.challengeId, idToken: token.id_token, deviceName: SessionStore.deviceName, link: link)
            switch result {
            case .authenticated(let auth): env.session.signedIn(auth); onSuccess()
            case .mfa(let challenge): mfa = challenge
            }
        } catch GoogleOAuthError.cancelled { }
        catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin { }
        catch let e as GoogleOAuthError {
            error = e == .invalidConfiguration ? "Googleログインの設定を確認できません。サポートへお問い合わせください。" : "Googleアカウントの確認ができませんでした。もう一度お試しください。"
        } catch { self.error = error.hdUserMessage }
    }
}
