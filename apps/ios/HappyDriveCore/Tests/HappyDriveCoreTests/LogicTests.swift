import XCTest
@testable import HappyDriveCore

final class LogicTests: XCTestCase {
    // MARK: 登録

    func testOnboardingStepsInOrder() throws {
        var user = User(id: "u", displayName: "", verificationStatus: .unsubmitted)
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .terms)
        user.onboardingSteps = OnboardingSteps(terms: true, profile: false, vehicle: false, bankAccount: false, verification: false)
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .profile)
        user.onboardingSteps?.profile = true
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .vehicle)
        user.onboardingSteps?.vehicle = true
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .bankAccount)
        user.onboardingSteps?.bankAccount = true
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .identityDocument)
        XCTAssertNotNil(OnboardingFlow.acceptBlocker(for: user))
        user.verificationStatus = .pending
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .verificationPending)
        XCTAssertEqual(OnboardingFlow.acceptBlocker(for: user), "本人確認の審査中です。承認されると受諾できるようになります。")
        user.verificationStatus = .rejected
        user.verificationNote = "書類が不鮮明です"
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .verificationRejected(note: "書類が不鮮明です"))
        user.verificationStatus = .verified
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .complete)
        XCTAssertNil(OnboardingFlow.acceptBlocker(for: user))
        user.suspended = true
        XCTAssertNotNil(OnboardingFlow.acceptBlocker(for: user))
    }

    func testOnboardingInfersFromFieldsWithoutSteps() throws {
        var user = try Fixture.decode(User.self, "user")
        user.onboardingSteps = nil
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .complete)
        user.bankAccount = nil
        XCTAssertEqual(OnboardingFlow.nextStep(for: user), .bankAccount)
        XCTAssertEqual(OnboardingFlow.checklist(for: user).filter { !$0.done }.count, 1)
    }

    func testOTPCountdown() throws {
        let sent = Date(timeIntervalSince1970: 1_000_000)
        let c = OTPResendCountdown(sentAt: sent, result: OTPRequestResult(expiresAt: sent.addingTimeInterval(300), resendAfterSeconds: 60))
        XCTAssertEqual(c.remainingSeconds(now: sent), 60)
        XCTAssertEqual(c.remainingSeconds(now: sent.addingTimeInterval(59.2)), 1)
        XCTAssertFalse(c.canResend(now: sent.addingTimeInterval(30)))
        XCTAssertTrue(c.canResend(now: sent.addingTimeInterval(60)))
        XCTAssertFalse(c.isExpired(now: sent.addingTimeInterval(299)))
        XCTAssertTrue(c.isExpired(now: sent.addingTimeInterval(300)))
    }

    // MARK: 業務

    func testAssignmentProgress() throws {
        var a = try Fixture.decode(Assignment.self, "assignment")
        var p = AssignmentProgress(assignment: a)
        XCTAssertEqual(p.label, "進行状況 3 / 5")
        XCTAssertEqual(p.nextAction, .completeStep(index: 3))
        for i in a.steps!.indices { a.steps![i].completed = true }
        p = AssignmentProgress(assignment: a)
        XCTAssertEqual(p.nextAction, .submitReport)
        XCTAssertEqual(p.fractionComplete, 1)
        a.state = .accepted
        XCTAssertEqual(AssignmentProgress(assignment: a).nextAction, .startTravel)
        a.state = .traveling
        XCTAssertEqual(AssignmentProgress(assignment: a).nextAction, .checkIn)
        a.state = .needs_revision
        XCTAssertEqual(AssignmentProgress(assignment: a).nextAction, .resubmit)
        a.state = .approved
        XCTAssertEqual(AssignmentProgress(assignment: a).nextAction, .rate)
        a.myRatingSubmitted = true
        XCTAssertEqual(AssignmentProgress(assignment: a).nextAction, .done)
        a.state = .reserved
        XCTAssertEqual(AssignmentProgress(assignment: a).nextAction, .waitForApproval)
    }

    func testLocationSharingStates() {
        let allowed = AssignmentState.allCases.filter(\.allowsLocationSharing)
        XCTAssertEqual(Set(allowed), [.traveling, .checked_in, .working])
    }

    func testReportRequirements() throws {
        let a = try Fixture.decode(Assignment.self, "assignment")
        XCTAssertEqual(ReportRequirements.missingPhotoCount(minPhotoCount: 2, attached: 1), 1)
        XCTAssertEqual(ReportRequirements.missingPhotoCount(minPhotoCount: nil, attached: 0), 0)
        XCTAssertEqual(ReportRequirements.missingStepPhotos(steps: a.steps ?? [], photosByStep: [:]), [4])
        XCTAssertEqual(ReportRequirements.missingStepPhotos(steps: a.steps ?? [], photosByStep: [4: 1]), [])
    }

    func testAcceptFailureResolution() {
        func err(_ code: String, _ details: [String: JSONValue]? = nil) -> APIError {
            .server(status: 409, body: APIErrorBody(code: code, message: "m", details: details))
        }
        XCTAssertEqual(AcceptFailureResolution(error: err("capacity_full")), .offerWaitlist(message: "m"))
        XCTAssertEqual(AcceptFailureResolution(error: err("terms_changed")), .reloadTerms(message: "m"))
        XCTAssertEqual(AcceptFailureResolution(error: err("not_eligible", ["reasons": .array([.string("資格がありません")])])), .notEligible(message: "m", reasons: ["資格がありません"]))
        XCTAssertEqual(AcceptFailureResolution(error: err("already_accepted", ["assignmentId": .string("a1")])), .alreadyAccepted(message: "m", assignmentId: "a1"))
        XCTAssertEqual(AcceptFailureResolution(error: err("invalid_state")), .other(message: "m"))
    }

    func testCheckInEvaluation() throws {
        let a = try Fixture.decode(Assignment.self, "assignment")
        let job = try XCTUnwrap(a.job)
        let early = job.startsAt.addingTimeInterval(-31 * 60)
        XCTAssertEqual(CheckInEvaluation.evaluate(current: job.location, accuracyMeters: 10, job: job, now: early), .tooEarly(opensAt: job.startsAt.addingTimeInterval(-1800)))
        let now = job.startsAt.addingTimeInterval(-10 * 60)
        XCTAssertEqual(CheckInEvaluation.evaluate(current: nil, accuracyMeters: nil, job: job, now: now), .locationUnavailable)
        // 約 111m 北
        let near = GeoPoint(latitude: job.location!.latitude + 0.001, longitude: job.location!.longitude)
        if case .ok(let d) = CheckInEvaluation.evaluate(current: near, accuracyMeters: 10, job: job, now: now) {
            XCTAssertEqual(d, 111, accuracy: 2)
        } else {
            XCTFail()
        }
        let far = GeoPoint(latitude: job.location!.latitude + 0.01, longitude: job.location!.longitude)
        if case .tooFar(let d, let r) = CheckInEvaluation.evaluate(current: far, accuracyMeters: 10, job: job, now: now) {
            XCTAssertEqual(r, 200)
            XCTAssertGreaterThan(d, 1000)
        } else {
            XCTFail()
        }
    }

    func testGeoDistance() {
        // 横浜駅〜桜木町駅 約 2.1km
        let d = Geo.distanceMeters(GeoPoint(latitude: 35.4658, longitude: 139.6223), GeoPoint(latitude: 35.4509, longitude: 139.6311))
        XCTAssertEqual(d, 1850, accuracy: 150)
    }

    // MARK: 配送

    func testRouteSummary() throws {
        let stops = try Fixture.decode([Stop].self, "stops")
        let route = try Fixture.decode(Route.self, "route")
        let summary = RouteSummary(route: route, stops: stops)
        XCTAssertEqual(summary.items.map(\.order), [1, 2])
        XCTAssertEqual(summary.items[1].violations.first?.type, .time_window_late)
        XCTAssertEqual(summary.items[0].leg?.travelMinutes, 15)
        XCTAssertEqual(summary.unroutedStops.map(\.id), ["0a4b1a70-2222-4c1e-9a53-0f4b8e2d1a02"])
        XCTAssertTrue(summary.isEstimated)
        XCTAssertFalse(summary.feasible)
        XCTAssertEqual(summary.headline, "3件・約4時間20分（概算）")
        XCTAssertEqual(summary.completedCount, 1)
        XCTAssertEqual(summary.nextStop?.id, "0a4b1a70-1111-4c1e-9a53-0f4b8e2d1a01")

        var provider = route
        provider.travelTimeSource = .provider
        XCTAssertFalse(RouteSummary(route: provider, stops: stops).isEstimated)
        XCTAssertEqual(RouteSummary(route: nil, stops: stops).headline, "3件")
    }

    func testOptimizationBlocker() throws {
        let stops = try Fixture.decode([Stop].self, "stops")
        XCTAssertEqual(RouteSummary.optimizationBlocker(stops: stops), "位置が確定していない配送先が1件あります。住所の候補を確認して位置を確定してください。")
        XCTAssertEqual(RouteSummary.optimizationBlocker(stops: [stops[0]]), "ルートを作成するには、未完了の配送先が2件以上必要です。")
        var located = stops
        located[1].hasLocation = true
        located[1].status = .ready
        XCTAssertNil(RouteSummary.optimizationBlocker(stops: located))
        XCTAssertEqual(RouteSummary.optimizableStopIds(stops: located).count, 2, "完了済みは対象外")
    }

    func testReorder() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(RouteSummary.reordered(ids, from: [0], to: 3), ["b", "c", "a", "d"])
        XCTAssertEqual(RouteSummary.reordered(ids, from: [3], to: 0), ["d", "a", "b", "c"])
        XCTAssertEqual(RouteSummary.reordered(ids, from: [1], to: 4), ["a", "c", "d", "b"])
    }

    func testDrivingSafetyHysteresis() {
        var s = DrivingSafetyState()
        let t0 = Date(timeIntervalSince1970: 0)
        s.update(speedMps: 1, at: t0)
        XCTAssertFalse(s.isDriving)
        s.update(speedMps: 3.0, at: t0.addingTimeInterval(1)) // 10.8km/h
        XCTAssertTrue(s.isDriving)
        s.update(speedMps: -1, at: t0.addingTimeInterval(2)) // 無効値は無視
        XCTAssertTrue(s.isDriving)
        s.update(speedMps: 0.5, at: t0.addingTimeInterval(3))
        XCTAssertTrue(s.isDriving, "停止直後はまだ走行扱い")
        s.update(speedMps: 0.2, at: t0.addingTimeInterval(6))
        XCTAssertTrue(s.isDriving)
        s.update(speedMps: 0.0, at: t0.addingTimeInterval(8.1))
        XCTAssertFalse(s.isDriving, "5秒以上の低速で停止")
        s.update(speedMps: 2.0, at: t0.addingTimeInterval(9)) // 7.2km/h
        XCTAssertFalse(s.isDriving, "閾値未満では走行にしない")
    }

    func testDeliveryReportSummary() {
        let s = DeliveryReportSummary(reports: [
            DeliveryDayReport(date: "2026-09-25", total: 10, delivered: 8, failed: 1, deferred: 1, pending: 0, estimatedDistanceKm: 30),
            DeliveryDayReport(date: "2026-09-26", total: 12, delivered: 3, failed: 0, deferred: 0, pending: nil, estimatedDistanceKm: nil),
        ])
        XCTAssertEqual(s.total, 22)
        XCTAssertEqual(s.delivered, 11)
        XCTAssertEqual(s.pending, 9)
        XCTAssertEqual(s.distanceKm, 30)
        XCTAssertEqual(s.completionRate, 0.5, accuracy: 0.001)
    }

    func testEarningsTotals() throws {
        let entries = try Fixture.decode([EarningEntry].self, "earnings")
        let totals = EarningsPresentation.totalsByState(entries)
        XCTAssertEqual(totals.map(\.state), [.payable, .paid, .reversed])
        XCTAssertEqual(totals.map(\.amountYen), [900, 600, -300])
        XCTAssertFalse(EarningsPresentation.payoutNotice.isEmpty)
    }

    // MARK: 検証

    func testValidation() {
        XCTAssertEqual(Validation.normalizePhone("０９０-１２３４-５６７８"), "09012345678")
        XCTAssertTrue(Validation.isValidPhone("09012345678"))
        XCTAssertTrue(Validation.isValidPhone("+819012345678"))
        XCTAssertFalse(Validation.isValidPhone("12345"))
        // 070 / 080 mobile numbers
        XCTAssertTrue(Validation.isValidPhone(Validation.normalizePhone("07089351565")))
        XCTAssertTrue(Validation.isValidPhone(Validation.normalizePhone("070-8935-1565")))
        XCTAssertTrue(Validation.isValidPhone(Validation.normalizePhone("０７０ ８９３５ １５６５")))
        XCTAssertTrue(Validation.isValidPhone(Validation.normalizePhone("08012345678")))
        XCTAssertEqual(Validation.sanitizeOTP("１２３ ４５６７"), "123456")
        XCTAssertTrue(Validation.isValidOTP("123456"))
        XCTAssertFalse(Validation.isValidOTP("12345a"))
        XCTAssertEqual(Validation.hiraganaToKatakana("やまだ たろう"), "ヤマダ タロウ")
        XCTAssertTrue(Validation.isKatakanaName("ヤマダ　タロウ"))
        XCTAssertFalse(Validation.isKatakanaName("山田"))
        XCTAssertTrue(Validation.isBankHolderKana("ヤマダ タロウ"))
        XCTAssertTrue(Validation.isPostalCode("231-0023"))
        XCTAssertTrue(Validation.isPostalCode("2310023"))
        XCTAssertFalse(Validation.isPostalCode("231-002"))
        XCTAssertTrue(Validation.isInvoiceNumber("T1234567890123"))
        XCTAssertTrue(Validation.isBankCode("0001"))
        XCTAssertTrue(Validation.isAccountNumber("1234567"))
        XCTAssertFalse(Validation.isAccountNumber("123456"))
        XCTAssertEqual(Validation.minutesFromHHMM("9:05"), 545)
        XCTAssertNil(Validation.minutesFromHHMM("24:00"))
        XCTAssertNil(Validation.minutesFromHHMM("10:5"))
        XCTAssertTrue(Validation.isRecipientPhone("045-000-0000"))
    }

    // MARK: 通知の遷移

    func testDeepLinks() {
        XCTAssertEqual(DeepLink.from(entityType: "assignment", entityId: "a1", type: "assignment.approved"), .assignment("a1"))
        XCTAssertEqual(DeepLink.from(entityType: "assignment", entityId: "a1", type: "message.created"), .assignmentChat("a1"))
        XCTAssertEqual(DeepLink.from(entityType: "job", entityId: "j1"), .job("j1"))
        XCTAssertEqual(DeepLink.from(entityType: "stop", entityId: "s1"), .stop("s1"))
        XCTAssertEqual(DeepLink.from(entityType: "payout", entityId: nil), .earnings)
        XCTAssertEqual(DeepLink.from(entityType: nil, entityId: nil, type: "verification.approved"), .verification)
        XCTAssertNil(DeepLink.from(entityType: nil, entityId: nil, type: "system"))
        XCTAssertEqual(DeepLink.from(userInfo: ["entityType": "job", "entityId": "j2", "aps": [:]]), .job("j2"))
    }

    // MARK: 暗号化

    func testEncryptionAndCache() throws {
        let key = StaticKeyProvider.random()
        let sealer = AESGCMSealer(keyProvider: key)
        let sealed = try sealer.seal(Data("山下町1-2-3".utf8))
        XCTAssertEqual(String(data: try sealer.open(sealed), encoding: .utf8), "山下町1-2-3")
        XCTAssertThrowsError(try AESGCMSealer(keyProvider: StaticKeyProvider.random()).open(sealed))
        XCTAssertThrowsError(try AESGCMSealer(keyProvider: StaticKeyProvider(data: Data([1, 2]))).seal(Data()))

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("hdc-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = DeliveryCache(url: dir.appendingPathComponent("today.bin"), sealer: sealer)
        XCTAssertNil(cache.load())
        let stops = try Fixture.decode([Stop].self, "stops")
        let snapshot = DeliveryCacheSnapshot(date: "2026-09-26", stops: stops, route: try Fixture.decode(Route.self, "route"), savedAt: Date(timeIntervalSince1970: 1_790_000_000))
        try cache.save(snapshot)
        let raw = try Data(contentsOf: dir.appendingPathComponent("today.bin"))
        XCTAssertNil(raw.range(of: Data("HD-2026-0142".utf8)), "キャッシュは暗号化される")
        XCTAssertEqual(cache.load(), snapshot)
        cache.clear()
        XCTAssertNil(cache.load())
    }

    func testEvidenceHashing() {
        XCTAssertEqual(EvidenceHashing.sha256Hex(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(EvidenceHashing.detectContentType(Data([0xFF, 0xD8, 0xFF, 0xDB])), .jpeg)
        XCTAssertEqual(EvidenceHashing.detectContentType(Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0])), .png)
        XCTAssertNil(EvidenceHashing.detectContentType(Data("GIF89a".utf8)))
    }
}
