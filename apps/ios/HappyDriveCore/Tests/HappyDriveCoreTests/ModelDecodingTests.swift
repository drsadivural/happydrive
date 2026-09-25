import XCTest
@testable import HappyDriveCore

final class ModelDecodingTests: XCTestCase {
    func testUserDecoding() throws {
        let user = try Fixture.decode(User.self, "user")
        XCTAssertEqual(user.displayName, "山田 太郎")
        XCTAssertEqual(user.verificationStatus, .verified)
        XCTAssertEqual(user.skillDetails?.count, 2)
        XCTAssertEqual(user.skillDetails?[1].status, .pending)
        XCTAssertEqual(user.vehicle?.type, .kei_van)
        XCTAssertEqual(user.bankAccount?.accountNumberLast4, "4567")
        XCTAssertEqual(user.preferences?.preferredCategories, [.life_support, .community_info])
        XCTAssertEqual(user.preferences?.maxDistanceKm, 10)
        XCTAssertEqual(user.roles, [.worker])
        XCTAssertEqual(user.ratingAverage, 4.8)
        XCTAssertEqual(user.onboardingSteps?.verification, true)
    }

    func testAuthResultDecodesDatesWithAndWithoutFraction() throws {
        let result = try Fixture.decode(AuthResult.self, "auth_result")
        XCTAssertTrue(result.isNewUser)
        XCTAssertEqual(result.tokens.accessTokenExpiresAt, HDJSON.parseDateTime("2026-09-26T06:15:00Z"))
        XCTAssertEqual(result.tokens.refreshTokenExpiresAt, HDJSON.parseDateTime("2026-10-26T06:00:00Z"))
        XCTAssertEqual(result.user.verificationStatus, .unsubmitted)
    }

    func testStopsDecoding() throws {
        let stops = try Fixture.decode([Stop].self, "stops")
        XCTAssertEqual(stops.count, 3)
        XCTAssertEqual(stops[0].status, .en_route)
        XCTAssertEqual(stops[0].location?.latitude, 35.4437)
        XCTAssertEqual(stops[0].packageNumber, "HD-2026-0142")
        XCTAssertTrue(stops[0].hasRecipientPhone)
        XCTAssertFalse(stops[1].hasLocation)
        XCTAssertNil(stops[1].location)
        XCTAssertEqual(stops[1].duplicateOfStopId, "0a4b1a70-1111-4c1e-9a53-0f4b8e2d1a01")
        XCTAssertEqual(stops[2].status, .delivered)
        XCTAssertEqual(stops[2].evidenceIds?.count, 1)
        XCTAssertNotNil(stops[2].completedAt)
    }

    func testRouteDecoding() throws {
        let route = try Fixture.decode(Route.self, "route")
        XCTAssertEqual(route.orderedStopIds.count, 2)
        XCTAssertFalse(route.feasible)
        XCTAssertEqual(route.travelTimeSource, .estimated)
        XCTAssertEqual(route.violations?.first?.type, .time_window_late)
        XCTAssertEqual(route.legs?[1].lateMinutes, 12)
        XCTAssertNil(route.breaks?.first?.afterStopId)
        XCTAssertEqual(route.status, .planned)
    }

    func testJobSearchDecodingWithUnknownCategory() throws {
        let page = try Fixture.decode(JobSearchPage.self, "job_search")
        XCTAssertEqual(page.items.count, 2)
        XCTAssertEqual(page.nextCursor, "cursor-2")
        let job = page.items[0]
        XCTAssertEqual(job.category, .shopping_assist)
        XCTAssertEqual(job.contractType, .contractor)
        XCTAssertEqual(job.expensesReimbursedYen, 200)
        XCTAssertEqual(job.cancellationPolicy.freeCancelHoursBefore, 24)
        XCTAssertEqual(job.steps.count, 3)
        XCTAssertEqual(job.matchReasons ?? [], ["近い", "時間に合う", "資格適合"])
        XCTAssertEqual(job.termsHash, "sha256:abc123")
        XCTAssertEqual(job.effectiveDurationMinutes, 30)
        // 未知のカテゴリでもデコードは失敗しない
        XCTAssertEqual(page.items[1].category, .unknown)
        XCTAssertEqual(page.items[1].contractType, .employment)
        XCTAssertTrue(page.items[1].isFull)
        XCTAssertEqual(page.items[1].effectiveDurationMinutes, 25)
    }

    func testAssignmentDecoding() throws {
        let a = try Fixture.decode(Assignment.self, "assignment")
        XCTAssertEqual(a.state, .working)
        XCTAssertEqual(a.job?.checkInRadiusMeters, 200)
        XCTAssertEqual(a.steps?.count, 5)
        XCTAssertEqual(a.evidence?.first?.status, .verified)
        XCTAssertEqual(a.earning?.scheduledPayoutDate, "2026-10-15")
        XCTAssertEqual(a.termsSnapshot?["amountYen"], .number(900))
        XCTAssertEqual(a.termsSnapshot?["flags"], .array([.bool(true), .null]))
    }

    func testMiscDecoding() throws {
        let home = try Fixture.decode(HomeSummary.self, "home")
        XCTAssertEqual(home.expectedEarningsYen, 8400)
        XCTAssertNil(home.todayRoute)

        let earnings = try Fixture.decode([EarningEntry].self, "earnings")
        XCTAssertEqual(earnings[0].breakdown?.count, 2)
        XCTAssertEqual(earnings[2].state, .reversed)
        XCTAssertEqual(earnings[1].stableId, "assignment-5a6b7c8d-1111-4c1e-9a53-0f4b8e2d1a62")

        let summary = try Fixture.decode(EarningsSummary.self, "earnings_summary")
        XCTAssertEqual(summary.totalYen, 36450)

        let payouts = try Fixture.decode([Payout].self, "payouts")
        XCTAssertEqual(payouts[1].status, .failed)

        let course = try Fixture.decode(Course.self, "course")
        XCTAssertEqual(course.questions.first?.choices.count, 3)

        let quiz = try Fixture.decode(QuizResult.self, "quiz_result")
        XCTAssertTrue(quiz.passed)
        XCTAssertEqual(quiz.grantedSkill?.validUntil, "2027-09-26")

        let notifications = try Fixture.decode([AppNotification].self, "notifications")
        XCTAssertTrue(notifications[0].isUnread)
        XCTAssertFalse(notifications[1].isUnread)

        let deletion = try Fixture.decode(DeletionRequest.self, "deletion")
        XCTAssertEqual(deletion.status, .confirmation_required)
        XCTAssertEqual(deletion.blockers?.count, 1)

        let error = try Fixture.decode(APIErrorBody.self, "error")
        XCTAssertEqual(error.code, "capacity_full")
        XCTAssertEqual(error.details?["waitlistAvailable"], .bool(true))

        let importResult = try Fixture.decode(StopImportResult.self, "import_result")
        XCTAssertEqual(importResult.duplicates.count, 2)
        XCTAssertEqual(importResult.duplicates[1].duplicateOfRow, 2)
        XCTAssertEqual(importResult.errors.first?.row, 5)

        let messages = try Fixture.decode([Message].self, "messages")
        XCTAssertEqual(messages[1].senderRole, .operator_)
    }

    func testStopUpdateEncodesExplicitNull() throws {
        var update = StopUpdate(version: 3)
        update.note = .null
        update.packageNumber = .value("HD-1")
        update.priority = 2
        let data = try HDJSON.makeEncoder().encode(update)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["version"] as? Int, 3)
        XCTAssertTrue(obj["note"] is NSNull)
        XCTAssertEqual(obj["packageNumber"] as? String, "HD-1")
        XCTAssertNil(obj["recipientName"], "変更しない項目は送らない")
        XCTAssertNil(obj["timeWindowStart"])
        XCTAssertEqual(obj["priority"] as? Int, 2)
    }

    func testNewStopEncodingOmitsNilsAndUsesUTC() throws {
        let start = try XCTUnwrap(HDFormat.date(on: "2026-09-26", hour: 10, minute: 0))
        let stop = NewStop(address: "横浜市中区山下町1-2-3", scheduledDate: "2026-09-26", location: GeoPoint(latitude: 35.44, longitude: 139.65), timeWindowStart: start, source: .manual, allowDuplicate: true)
        let data = try HDJSON.makeEncoder().encode(stop)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["timeWindowStart"] as? String, "2026-09-26T01:00:00Z", "JST 10:00 は UTC 01:00")
        XCTAssertEqual(obj["source"] as? String, "manual")
        XCTAssertEqual(obj["allowDuplicate"] as? Bool, true)
        XCTAssertNil(obj["note"])
        XCTAssertNil(obj["timeWindowEnd"])
    }

    func testStopEventValidation() {
        XCTAssertNotNil(StopEventRequest(eventType: .failed).validationError())
        XCTAssertNil(StopEventRequest(eventType: .failed, failureReason: .absent).validationError())
        XCTAssertNotNil(StopEventRequest(eventType: .deferred, failureReason: .absent).validationError())
        XCTAssertNil(StopEventRequest(eventType: .deferred, failureReason: .absent, deferredUntil: Date()).validationError())
        XCTAssertNil(StopEventRequest(eventType: .delivered, handoff: .in_person).validationError())
    }

    func testUnknownEnumRoundTrip() throws {
        let data = Data(#"["accepted","teleporting"]"#.utf8)
        let states = try HDJSON.makeDecoder().decode([AssignmentState].self, from: data)
        XCTAssertEqual(states, [.accepted, .unknown])
        let encoded = try HDJSON.makeEncoder().encode([AssignmentState.checked_in])
        XCTAssertEqual(String(data: encoded, encoding: .utf8), #"["checked_in"]"#)
    }

    func testJobSearchQueryItems() {
        var q = JobSearchQuery()
        q.latitude = 35.443712
        q.longitude = 139.650301
        q.areaQuery = "中区"
        q.category = .life_support
        q.minAmountYen = 0
        q.eligibleOnly = true
        q.sort = .recommended
        q.limit = 100
        let items = Dictionary(uniqueKeysWithValues: q.queryItems.map { ($0.name, $0.value) })
        XCTAssertEqual(items["latitude"], "35.444")
        XCTAssertEqual(items["longitude"], "139.650")
        XCTAssertNil(items["areaQuery"], "位置がある場合はエリア文字列を送らない")
        XCTAssertNil(items["minAmountYen"])
        XCTAssertEqual(items["eligibleOnly"], "true")
        XCTAssertEqual(items["limit"], "50")
        XCTAssertEqual(items["category"], "life_support")

        var denied = JobSearchQuery()
        denied.areaQuery = " 横浜市中区 "
        let deniedItems = Dictionary(uniqueKeysWithValues: denied.queryItems.map { ($0.name, $0.value) })
        XCTAssertEqual(deniedItems["areaQuery"], "横浜市中区")
        XCTAssertNil(deniedItems["latitude"])
    }
}
