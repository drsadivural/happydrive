# HappyDrive v2 delivery status

Source: Google Drive `1Nm5f0VxM-IqzXSsu1X_M3idP_93j-PBi`, HappyDrive-implementation-package_updated.zip, dated 2026-10-03. Original requirements are preserved in `docs/spec/v2/`.

This branch is an implementation candidate, **not a production release**. Production and staging request creation and all checkout are disabled while commercial decisions and payment integration remain incomplete. The current workspace had 414 pre-existing tracked deletions; work was performed in the separate `/home/ubuntu/happydrive-v2` checkout without restoring or overwriting those deletions.

## Implemented

- Additive PostgreSQL/PostGIS `marketplace` schema beside existing authentication and delivery data. Existing authentication, administration, delivery tools and messaging remain available.
- SMS customer registration and optional email; existing email/password and MFA login remains available. Browser tokens stay in httpOnly cookies; mutations use CSRF protection and server-side idempotency.
- Customer/supplier account views and role selection, supplier registration in pending state, services submitted for review, supplier member selection and availability registration.
- Customer service catalog, request posting and history, masked supplier feed, tenant-authorized details, encrypted addresses/details/messages, ordered request progress, unaccepted cancellation and quota return, disputes with quota hold, and in-app notifications with existing APNs outbox.
- Basic 5 and Standard 12 requests per subscription period; Care 2 per scheduled JST day; quota locking including concurrent posts and period-rollover daily counting.
- Atomic supplier acceptance, required supplier subscription/review, verified qualifications, availability, staff membership and overlapping-request/delivery checks.
- Customer-only 60-second confirmation tokens, hashed at rest, reissue revocation, assigned-staff verification, expiry/replay protection and exactly-once completion/quota consumption. iOS QR display, expiry countdown, camera permission request and scanner are connected to those endpoints.
- Native customer/supplier views, service registration, request composition, workflow and messages. Existing delivery tools are reachable from the new home screen.
- Account-deletion blockers include marketplace work/contracts/ownership; completed deletion removes marketplace profile PII and deactivates memberships.
- Initial company names remain invited and unverified; no partnership claims or published services are seeded for them.

## Verification boundaries

- Automated API tests use a dedicated local PostGIS database; no production database is reset.
- Browser tests use a separate explicit `*_e2e` database and a loopback-only test server. Its SMS and subscription fixtures are test adapters, **not evidence of live SMS or Stripe operation**. The harness is outside `src` and is not included in the production API build.
- API concurrency tests cover 100 concurrent Basic posts and 100 eligible supplier acceptance attempts, plus QR replay/expiry/reissue, outsider access, Care limits and idempotency.
- The contract scenario exercises every added API operation and validates documented response schemas.
- Desktop and mobile Chromium browser tests cover SMS login, service selection, posting/history/cancellation, plan gate, supplier mode/service submission, tenant allowlist and logout. They do **not** cover all acceptance requirements or real iOS Safari.
- Linux Swift package tests verify models, QR parsing and expiry. The macOS CI job passed the full iOS Simulator app build and HappyAvatarKit simulator tests. Real-device, TestFlight and signed distribution checks have not been performed.

## Work still required before release

1. The user clarified Gmail/Google login. Both clients now have Google sign-in and explicit linking, with SMS phone confirmation and existing TOTP preserved. Configure the Google OAuth clients and verify live web/device login before release; see `docs/GOOGLE_SIGN_IN.md`. Broader account recovery remains unfinished.
2. Decide supplier pricing; whether customer subscriptions include work; service charges, tax, travel/material charges, supplier compensation, fees, cancellations/refunds and plan-change timing. See `docs/spec/v2/04_BILLING.md`. No guessed prices or live payment attempts are implemented.
3. Implement and validate Stripe setup/3DS, Billing/Connect, authoritative subscription synchronization, signature-checked ordered/deduplicated webhooks, quotas per real billing period, receipts, transfers, refunds and reconciliation. The current checkout endpoint deliberately returns unavailable.
4. Connect an actual SMS provider, APNs credentials and production object storage; validate delivery/failure/recovery behavior. SMS provider adapters remain the existing console/none choices.
5. Complete supplier application metadata/documents, staff invitations/assignment/reassignment, v2 admin review screens, invited-company ownership claims and qualified-service approval.
6. Complete attachment upload/access/retention for marketplace profiles and requests, ratings, support operations and evidence-backed two-person dispute resolution.
7. Implement MCP ownership/TLS/domain/OAuth/SSRF safeguards, read adapters, reviewed synchronization and target-server interoperability tests. Schema tables are present; MCP connectivity is not implemented on this branch.
8. Integrate the v2 staff schedule with the existing delivery workspace (the current collision check covers v2 delivery records); verify routes/OCR/import constraints against actual travel-time providers.
9. Complete customer terms/consent, caregiver/delegated booking rules, accessibility/Dynamic Type/VoiceOver, dark-mode and offline/retry reviews, plus broad browser/device acceptance tests.
10. Confirm the hosting project and DNS control for `happydrive.ayonix.com`. DNS resolution failed from this machine during inspection. The saved deployment configuration describes only `happydrive-api.ayonix.com`; no production web deployment was performed.
11. Configure Apple signing/developer access, run an archive, test on at least two physical devices, perform face-to-face QR trials, distribute through TestFlight and complete review accounts/privacy declarations.
12. Verify operations monitoring, alerts, backup restore drills and release runbooks. Complete the P0 evidence matrix in `docs/spec/v2/ACCEPTANCE.md` before enabling launch.

Do not market this candidate as fully tested, product-ready or App Store-ready. Passing the listed automated checks establishes only those checks.

## Initial v2 check results (before the Google login follow-up)

- API: 82 tests passed across 11 suites, including v2 contract and concurrency tests.
- Swift core: 149 tests passed, zero failures.
- Shared web library: 69 tests passed; supplier/customer web: 27 passed; admin web: 14 passed.
- Browser: 4 connected desktop/mobile Chromium tests passed, with screenshots and no captured page exceptions in the customer flow.
- API lint/type/build, web lint/type checks and both web production builds passed.
- Full iOS Simulator app compilation and HappyAvatarKit simulator tests passed in remote CI at commit 14fac95. Signed archive, physical-device validation and TestFlight remain unperformed.

## Remote CI findings

The first draft PR run passed contracts, API, web, browser and Swift-core jobs. macOS compilation identified an optional-string grouping error in the new workflow screen; the follow-up commit corrects it. Run 37124011627 passed contracts, API, web, browser, Swift-core and full iOS app jobs; only security failed. Subsequent test-only changes strengthen acceptance concurrency coverage to 100 distinct supplier accounts.

The security job reports CVE-2026-93687 / GHSA-vfj7-8cjw-p6xm in the transitive development dependency `braces@3.0.3` through Next's ESLint plugin. Both configured and public npm registries report 3.0.3 as latest; the GitHub advisory states no patched version is available. No audit exemption or lowered severity threshold has been introduced. This remains a release blocker pending a verified upstream patch or reviewed replacement of the affected toolchain.

Advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm


## Google login follow-up verification (2026-10-03)

The clarified Gmail/Google login requirement is implemented in web and iOS. Configuration and explicit verification boundaries are in `docs/GOOGLE_SIGN_IN.md`. No live OAuth clients have been supplied, and no production Google login or deployment has been performed.

- API: 91 tests passed across 12 suites. Following the final MFA concurrency/suspension changes, 25 focused authentication tests passed, including 20 parallel incorrect MFA attempts limited to 10 failures before lockout.
- Swift core: 155 tests passed, including the PKCE vector, hostile callbacks and session persistence only after successful MFA.
- Shared web: 75 tests passed; partner web: 27 passed. Both web production builds, API build, lint/type checks and contract checks passed.
- Browser: 8 connected desktop/mobile tests passed, including Google login, phone linking/profile registration, returning to the same account and Google + TOTP login. External Google UI and SMS remain test adapters.
- Remote run 37126614344 (8242f1a) passed contracts, API, web, browser, Swift core and full iOS Simulator app build/HappyAvatarKit tests. The follow-up strengthens test coverage and MFA locking and reruns CI. The iOS app source has not changed since the successful build.
- Security remains blocked by the upstream advisory above. Signed Apple distribution and live provider/device acceptance are still outstanding.
