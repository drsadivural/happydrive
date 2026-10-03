# Google / Gmail login

The customer web and iOS login screens offer Google sign-in alongside SMS. Google Workspace accounts are also accepted. The application requests only `openid email profile`; it does not request Gmail, Drive or other Google data access.

## Deployment configuration

1. In the HappyDrive-owned Google Cloud project, configure the OAuth consent screen, verified domains, application homepage, privacy policy and support contacts.
2. Create a **Web application** OAuth client. Add the exact production origin `https://happydrive.ayonix.com` to Authorized JavaScript origins. Add the actual staging origin separately. For local development only, add `http://localhost`, `http://localhost:3001` and/or `http://127.0.0.1:3001`. The GIS popup flow does not need a redirect URI or a client secret.
3. Set `GOOGLE_WEB_CLIENT_ID` on the API. The BFF obtains the public client ID from a server challenge; no Google secret is shipped or required.
4. Create an **iOS** OAuth client registered for the actual bundle identifier (currently `jp.happydrive.driver`). Set `GOOGLE_IOS_CLIENT_ID` on the API and in the private iOS build configuration. Set `GOOGLE_REVERSED_CLIENT_ID` in that build configuration to the reversed client ID: `123-example.apps.googleusercontent.com` becomes `com.googleusercontent.apps.123-example`. The build registers this callback scheme in Info.plist.
5. Apply migration `006_google_auth.sql`. Restart the API with the configured client IDs and rebuild the iOS app. Missing configuration shows a recoverable message and does not authenticate users.
6. Complete consent-screen verification and publishing as required by the Google project. Test the actual production origin and physical iOS devices using real Google accounts before enabling release. Apple signing, App Store authentication-policy requirements, domain deployment and the broader delivery report still apply.

No production OAuth client IDs were supplied during this implementation. Live Google authentication has not been verified or deployed.

## Security and account behavior

- The web uses Google's own GIS button in popup mode. Every challenge is bound to an httpOnly browser cookie; requests require same-origin CSRF verification. HappyDrive access and refresh tokens stay in httpOnly cookies. CSP allows only the required Google GIS resources; popup communication is enabled only in the customer/supplier application, not the administrator application.
- iOS opens an `ASWebAuthenticationSession` using authorization code + PKCE S256, a fresh random state and server-issued nonce. It validates the callback scheme/path/state and exchanges the code directly with Google's fixed token endpoint. HappyDrive tokens use the existing Keychain store. No client secret or Google provider tokens are persisted.
- The API verifies Google's JWKS signature, RS256 algorithm, issuer, exact client audience/authorized party, issuance time/expiry, verified email and nonce. Challenges expire after five minutes and can produce only one successful authentication. Google subjects are blind-indexed; the same subject works across web and iOS.
- A matching email never automatically takes over an existing account. Users authenticate by their current method, then explicitly link Google in the account screen. The link challenge is bound to that HappyDrive user; conflicting links are rejected. Automatic merges and replacement of linked identities are not supported.
- Accounts with an enrolled second factor must still complete TOTP after Google sign-in. Admin accounts continue to use the administrator MFA login; Google cannot create an administrator session. Invalid MFA attempts are recorded in the verification transaction before returning an error. The limit is rechecked while holding the account lock, so concurrent attempts respect it.
- Suspended/deleted identities are denied. The blind subject index remains associated with a deleted account to enforce the existing 30-day re-registration hold.
- Google login does not verify a phone number. The booking profile still requires SMS proof. Its phone-confirmation screen now links the number to the **current** HappyDrive account and refuses numbers already owned by another account; it does not switch the user into another account.

## Test boundaries

Tests use locally signed RSA JWTs with a test JWKS and an isolated database, including cryptographic rejection of wrong algorithm/signature/issuer/audience/expiry, nonce/replay/concurrency protection, explicit linking, TOTP, deletion/suspension and phone verification. Browser tests replace Google's external UI with a test adapter; they exercise the connected BFF/API and profile flow with those signed JWTs. Swift tests include the published PKCE S256 vector and malicious callback checks. These tests do not prove Google consent configuration or live provider operation.

Primary references: [Google GIS](https://developers.google.com/identity/gsi/web/reference/js-reference), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Google native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).
