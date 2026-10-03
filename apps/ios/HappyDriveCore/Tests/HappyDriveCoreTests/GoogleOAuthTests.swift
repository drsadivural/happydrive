import XCTest
@testable import HappyDriveCore

final class GoogleOAuthTests: XCTestCase {
    private let client = "123-test.apps.googleusercontent.com"
    private let state = String(repeating: "a", count: 43)
    func testPKCEPublishedVectorAndAuthorizationParameters() throws {
        let flow = try GoogleOAuthFlow(clientId: client, state: state, verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(flow.codeChallenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(flow.redirectScheme, "com.googleusercontent.apps.123-test")
        let url = flow.authorizationURL(nonce: "nonce")
        XCTAssertEqual(url.host, "accounts.google.com")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first(where: { $0.name == "code_challenge_method" })?.value, "S256")
        XCTAssertEqual(items.first(where: { $0.name == "scope" })?.value, "openid email profile")
        XCTAssertEqual(items.first(where: { $0.name == "nonce" })?.value, "nonce")
        XCTAssertFalse(url.absoluteString.contains(flow.verifier))
    }
    func testCallbackRejectsCrossFlowWrongURIAndDuplicates() throws {
        let flow = try GoogleOAuthFlow(clientId: client, state: state, verifier: String(repeating: "b", count: 43))
        let callback = "\(flow.redirectURI)?state=\(state)&code=verified-code"
        XCTAssertEqual(try flow.authorizationCode(callback: URL(string: callback)!), "verified-code")
        for value in [callback.replacingOccurrences(of: state, with: "wrong"), "evil:/oauthredirect?state=\(state)&code=x", "\(flow.redirectScheme):/other?state=\(state)&code=x", callback+"&state=\(state)", callback+"&code=other"] {
            XCTAssertThrowsError(try flow.authorizationCode(callback: URL(string: value)!))
        }
        XCTAssertThrowsError(try flow.authorizationCode(callback: URL(string: "\(flow.redirectURI)?state=\(state)&error=access_denied")!)) { XCTAssertEqual($0 as? GoogleOAuthError, .cancelled) }
    }
    func testTokenRequestEncodesCodeAndNeverSendsClientSecret() throws {
        let flow = try GoogleOAuthFlow(clientId: client, state: state, verifier: String(repeating: "c", count: 43))
        let req = flow.tokenRequest(code: "a&b+c= d")
        XCTAssertEqual(req.url?.host, "oauth2.googleapis.com"); XCTAssertEqual(req.httpMethod, "POST")
        let body = String(data: req.httpBody!, encoding: .utf8)!
        XCTAssertTrue(body.contains("code=a%26b%2Bc%3D%20d")); XCTAssertTrue(body.contains("code_verifier=")); XCTAssertFalse(body.contains("client_secret"))
    }
    func testConfigurationRejectsMalformedClientAndWeakVerifier() {
        XCTAssertThrowsError(try GoogleOAuthFlow(clientId: "https://evil", state: state, verifier: String(repeating: "a", count: 43)))
        XCTAssertThrowsError(try GoogleOAuthFlow(clientId: client, state: "short", verifier: "short"))
        XCTAssertThrowsError(try GoogleOAuthFlow(clientId: client, state: state, verifier: String(repeating: "!", count: 43)))
    }
}
