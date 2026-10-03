import Foundation
import Crypto
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct GoogleAuthChallenge: Codable, Sendable {
    public let challengeId: String
    public let nonce: String
    public let clientId: String
    public let expiresAt: Date
}

public struct GoogleMFAChallenge: Codable, Sendable {
    public let mfaToken: String
    public let mfaEnrollmentRequired: Bool
}
public enum GoogleSignInResult: Sendable {
    case authenticated(AuthResult)
    case mfa(GoogleMFAChallenge)
}

public enum GoogleOAuthError: Error, Equatable, Sendable {
    case invalidConfiguration, invalidCallback, cancelled, providerFailure
}

/// OAuth authorization-code flow for the registered iOS client. No client secret is used.
public struct GoogleOAuthFlow: Sendable {
    public let clientId: String
    public let state: String
    public let verifier: String
    public let redirectScheme: String
    public var redirectURI: String { "\(redirectScheme):/oauthredirect" }
    public init(clientId: String, state: String, verifier: String) throws {
        guard clientId.hasSuffix(".apps.googleusercontent.com"),
              clientId.count > ".apps.googleusercontent.com".count,
              clientId.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }),
              state.count >= 32, verifier.count >= 43, verifier.count <= 128,
              verifier.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-._~".contains($0)) }) else { throw GoogleOAuthError.invalidConfiguration }
        self.clientId = clientId; self.state = state; self.verifier = verifier
        redirectScheme = clientId.split(separator: ".").reversed().joined(separator: ".")
    }
    public var codeChallenge: String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public func authorizationURL(nonce: String) -> URL {
        var parts = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        parts.queryItems = [
            URLQueryItem(name: "client_id", value: clientId), URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "state", value: state), URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "code_challenge", value: codeChallenge), URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "prompt", value: "select_account")
        ]
        return parts.url!
    }
    public func authorizationCode(callback: URL) throws -> String {
        guard let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              parts.scheme == redirectScheme, parts.host == nil, parts.path == "/oauthredirect" else { throw GoogleOAuthError.invalidCallback }
        let items = parts.queryItems ?? []
        guard items.filter({ $0.name == "state" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state else { throw GoogleOAuthError.invalidCallback }
        if let error = items.first(where: { $0.name == "error" })?.value {
            throw error == "access_denied" ? GoogleOAuthError.cancelled : GoogleOAuthError.providerFailure
        }
        guard items.filter({ $0.name == "code" }).count == 1,
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty, code.count <= 4096 else { throw GoogleOAuthError.invalidCallback }
        return code
    }
    public func tokenRequest(code: String) -> URLRequest {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"; request.timeoutInterval = 15
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let fields = [("client_id",clientId),("redirect_uri",redirectURI),("grant_type","authorization_code"),("code",code),("code_verifier",verifier)]
        let safe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        request.httpBody = Data(fields.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: safe)!)" }.joined(separator: "&").utf8)
        return request
    }
}
