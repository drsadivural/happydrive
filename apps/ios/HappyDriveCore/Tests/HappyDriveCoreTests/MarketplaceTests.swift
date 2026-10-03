import XCTest
@testable import HappyDriveCore

final class MarketplaceTests: XCTestCase {
    func testCompletionPayloadRejectsUntrustedAndWrongIdentifiers() throws {
        let id = "11111111-2222-4333-8444-555555555555"
        let token = String(repeating:"a",count:43)
        let payload = CompletionPayload(requestId:id,token:token)
        let data = try JSONEncoder().encode(payload)
        XCTAssertEqual(CompletionPayload.parse(String(decoding:data,as:UTF8.self)),payload)
        XCTAssertNil(CompletionPayload.parse("https://example.test/redirect"))
        XCTAssertNil(CompletionPayload.parse("{\"requestId\":\"other\",\"token\":\"\(token)\"}"))
        XCTAssertNil(CompletionPayload.parse("{\"requestId\":\"\(id)\",\"token\":\"short\"}"))
        XCTAssertNil(CompletionPayload.parse(String(repeating:"a",count:513)))
    }
    func testExpiryBoundaryAndQrPayload() throws {
        let json = "{\"requestId\":\"11111111-2222-4333-8444-555555555555\",\"token\":\"\(String(repeating:"b",count:43))\",\"expiresAt\":\"2026-10-03T12:00:00.000Z\"}"
        let token = try HDJSON.makeDecoder().decode(CompletionToken.self,from:Data(json.utf8))
        XCTAssertFalse(token.isExpired(at:token.expiresAt.addingTimeInterval(-0.001)))
        XCTAssertTrue(token.isExpired(at:token.expiresAt))
        XCTAssertTrue(token.isExpired(at:token.expiresAt.addingTimeInterval(0.001)))
        XCTAssertEqual(CompletionPayload.parse(String(decoding:try XCTUnwrap(token.qrPayload),as:UTF8.self))?.requestId,token.requestId)
    }
    func testTerminalStatesNeverOfferFurtherWork() {
        for status in ["completed","cancelled","disputed","open","awaiting_customer_confirmation"] { XCTAssertNil(MarketplaceStatus.next(status)) }
        XCTAssertEqual(MarketplaceStatus.next("in_progress"),"awaiting_customer_confirmation")
    }
}
