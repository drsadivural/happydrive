import XCTest
@testable import HappyDriveCore

final class FormattingTests: XCTestCase {
    func testYen() {
        XCTAssertEqual(HDFormat.yen(0), "¥0")
        XCTAssertEqual(HDFormat.yen(900), "¥900")
        XCTAssertEqual(HDFormat.yen(8400), "¥8,400")
        XCTAssertEqual(HDFormat.yen(36450), "¥36,450")
        XCTAssertEqual(HDFormat.yen(1_000_000), "¥1,000,000")
        XCTAssertEqual(HDFormat.yen(-300), "-¥300")
        XCTAssertEqual(HDFormat.yenSpoken(1500), "1,500円")
    }

    func testDuration() {
        XCTAssertEqual(HDFormat.duration(minutes: 0), "0分")
        XCTAssertEqual(HDFormat.duration(minutes: 30), "30分")
        XCTAssertEqual(HDFormat.duration(minutes: 60), "1時間")
        XCTAssertEqual(HDFormat.duration(minutes: 260), "4時間20分")
        XCTAssertEqual(HDFormat.duration(minutes: -5), "0分")
        XCTAssertEqual(HDFormat.countdown(seconds: 45), "0:45")
        XCTAssertEqual(HDFormat.countdown(seconds: 65), "1:05")
    }

    func testJSTDateFormatting() throws {
        // UTC 06:00 = JST 15:00
        let start = try XCTUnwrap(HDJSON.parseDateTime("2026-09-26T06:00:00Z"))
        let end = try XCTUnwrap(HDJSON.parseDateTime("2026-09-26T06:30:00Z"))
        XCTAssertEqual(HDFormat.time(start), "15:00")
        XCTAssertEqual(HDFormat.timeRange(start, end), "15:00–15:30")
        XCTAssertEqual(HDFormat.monthDay(start), "9月26日(土)")
        XCTAssertEqual(HDFormat.fullDate(start), "2026年9月26日(土)")
        XCTAssertEqual(HDFormat.dateTime(start), "2026/09/26 15:00")

        // UTC 16:00 は JST 翌日 01:00（日付の境界）
        let lateUTC = try XCTUnwrap(HDJSON.parseDateTime("2026-09-26T16:00:00Z"))
        XCTAssertEqual(HDFormat.apiDate(lateUTC), "2026-09-27")
        XCTAssertEqual(HDFormat.apiMonth(lateUTC), "2026-09")

        let now = try XCTUnwrap(HDJSON.parseDateTime("2026-09-26T00:30:00Z")) // JST 9:30
        XCTAssertEqual(HDFormat.relativeDayTime(start, now: now), "本日 15:00")
        let tomorrow = start.addingTimeInterval(86400)
        XCTAssertEqual(HDFormat.relativeDayTime(tomorrow, now: now), "明日 15:00")
        XCTAssertEqual(HDFormat.relativeDay(start.addingTimeInterval(-86400), now: now), "昨日")
        XCTAssertEqual(HDFormat.relativeDay(start.addingTimeInterval(86400 * 2), now: now), "9月28日(月)")
        XCTAssertEqual(HDFormat.schedule(start, end, now: now), "本日 15:00–15:30")
        XCTAssertEqual(HDFormat.greeting(now: now), "おはようございます")
    }

    func testAPIDateHelpers() throws {
        let d = try XCTUnwrap(HDFormat.parseAPIDate("2026-01-05"))
        XCTAssertEqual(HDFormat.apiDate(d), "2026-01-05")
        XCTAssertEqual(HDFormat.displayAPIDate("2026-01-05"), "1月5日(月)")
        XCTAssertEqual(HDFormat.displayAPIDate(nil), "-")
        XCTAssertEqual(HDFormat.displayMonth("2026-09"), "2026年9月")
        XCTAssertEqual(HDFormat.shiftMonth("2026-01", by: -1), "2025-12")
        XCTAssertEqual(HDFormat.shiftMonth("2026-12", by: 1), "2027-01")
        let tenAM = try XCTUnwrap(HDFormat.date(on: "2026-09-26", hour: 10, minute: 30))
        XCTAssertEqual(HDJSON.formatDateTime(tenAM), "2026-09-26T01:30:00Z")
    }

    func testDistance() {
        XCTAssertEqual(HDFormat.distance(km: 1.24), "1.2 km")
        XCTAssertEqual(HDFormat.meters(350.4), "350m")
        XCTAssertEqual(HDFormat.meters(1520), "1.5 km")
    }

    func testLabels() {
        XCTAssertEqual(JobCategory.life_support.label, "生活支援")
        XCTAssertEqual(ContractType.employment.label, "雇用")
        XCTAssertEqual(ContractType.contractor.label, "業務委託")
        XCTAssertEqual(AssignmentState.working.presentation.label, "実行中")
        XCTAssertEqual(StopStatus.en_route.presentation.label, "配達中")
        XCTAssertEqual(EarningState.estimated.presentation.label, "見込み")
        XCTAssertEqual(EarningState.pending.presentation.label, "確定待ち")
        XCTAssertEqual(EarningState.payable.presentation.label, "支払予定")
        XCTAssertEqual(EarningState.paid.presentation.label, "振込済")
        XCTAssertEqual(EarningState.failed.presentation.label, "振込失敗")
        XCTAssertEqual(EarningState.reversed.presentation.label, "取消")
        for state in EarningState.allCases {
            XCTAssertFalse(state.presentation.label.contains("即時"))
            XCTAssertFalse(state.presentation.symbol.isEmpty, "色だけで状態を表さない")
        }
        for state in AssignmentState.allCases {
            XCTAssertFalse(state.presentation.label.isEmpty)
            XCTAssertFalse(state.presentation.symbol.isEmpty)
        }
        XCTAssertEqual(FailureReason.absent.label, "不在")
        XCTAssertEqual(HandoffType.delivery_box.label, "宅配ボックス")
    }
}

final class CSVTests: XCTestCase {
    func testParseQuotesNewlinesAndBOM() throws {
        let text = "\u{FEFF}address,note\r\n\"横浜市中区山下町1-2-3\",\"置き配不可, 受付で\"\"お渡し\"\"\"\r\n\"横浜市西区1-1\",\"2行目\n続き\"\n\n"
        let rows = try CSV.parse(text)
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0], ["address", "note"])
        XCTAssertEqual(rows[1], ["横浜市中区山下町1-2-3", "置き配不可, 受付で\"お渡し\""])
        XCTAssertEqual(rows[2][1], "2行目\n続き")
    }

    func testParseEdgeCases() throws {
        XCTAssertEqual(try CSV.parse(""), [])
        XCTAssertEqual(try CSV.parse("a,b"), [["a", "b"]], "末尾改行なし")
        XCTAssertEqual(try CSV.parse("a,,c\n"), [["a", "", "c"]], "空フィールド")
        XCTAssertEqual(try CSV.parse("a,\n"), [["a", ""]], "末尾の空フィールド")
        XCTAssertEqual(try CSV.parse(" a , b \r"), [["a", "b"]], "CR のみの改行・前後空白")
        XCTAssertEqual(try CSV.parse("\" a \",b\n"), [[" a ", "b"]], "引用符内の空白は保持")
        XCTAssertEqual(try CSV.parse("a\"b,c\n"), [["a\"b", "c"]], "途中の引用符は文字として扱う")
        XCTAssertThrowsError(try CSV.parse("a,\"unterminated\nb")) { error in
            XCTAssertEqual(error as? CSVError, .unterminatedQuote(line: 1))
        }
    }

    func testBuildRoundTrip() throws {
        let header = ["address", "note"]
        let rows = [["横浜市, 中区", "\"引用\""], ["改行\nあり", " 前後空白 "]]
        let text = CSV.build(header: header, rows: rows)
        XCTAssertEqual(try CSV.parse(text), [header] + rows)
    }

    func testStopCSVPreview() throws {
        let text = """
        住所,開始時刻,終了時刻,優先度,電話番号,荷物番号,色
        横浜市中区山下町1-2-3,10:00,10:20,1,045-000-0000,HD-1,赤
        横浜市中区山下町１－２－３,,,,,HD-2,
        ,25:00,10:00,5,abc,,
        横浜市西区1-1,11:30,11:00,,,,
        """
        let preview = try StopCSV.preview(text)
        XCTAssertEqual(preview.rows.count, 4)
        XCTAssertEqual(preview.rows[0].values["time_start"], "10:00", "日本語見出しを変換")
        XCTAssertTrue(preview.errors.contains { $0.row == 1 && $0.message.contains("色") }, "未知の列を警告")
        XCTAssertEqual(preview.localDuplicates[3], 2, "全角・ハイフン違いの住所も重複と判定")
        let row4 = preview.errors.filter { $0.row == 4 }.map(\.message)
        XCTAssertTrue(row4.contains("住所が空欄または短すぎます"))
        XCTAssertTrue(row4.contains("time_start は HH:MM 形式で入力してください"))
        XCTAssertTrue(row4.contains("priority は 0〜2 で入力してください"))
        XCTAssertTrue(row4.contains("電話番号の形式が正しくありません"))
        XCTAssertTrue(preview.errors.contains { $0.row == 5 && $0.message == "指定時間の終了が開始より前です" })
        XCTAssertEqual(preview.validCount, 2)
        let normalized = try CSV.parse(preview.normalizedCSV)
        XCTAssertEqual(normalized.first, StopCSV.columns)
        XCTAssertEqual(normalized[1][0], "横浜市中区山下町1-2-3")
    }

    func testStopCSVMissingAddressColumn() throws {
        let preview = try StopCSV.preview("name,phone\nA,090\n")
        XCTAssertTrue(preview.rows.isEmpty)
        XCTAssertEqual(preview.errors.first?.message, "見出し行に address（住所）列がありません")
        XCTAssertThrowsError(try StopCSV.preview("\n\n"))
    }

    func testLatLonValidation() throws {
        let preview = try StopCSV.preview("address,latitude,longitude\n横浜市中区1-1,35.4,\n横浜市中区2-2,95,139\n横浜市中区3-3,35.4,139.6\n")
        XCTAssertTrue(preview.errors.contains { $0.row == 2 && $0.message.contains("両方") })
        XCTAssertTrue(preview.errors.contains { $0.row == 3 && $0.message.contains("正しくありません") })
        XCTAssertFalse(preview.errors.contains { $0.row == 4 })
    }

    func testAddressNormalizer() {
        XCTAssertEqual(AddressNormalizer.key("横浜市中区山下町1丁目2番3号"), AddressNormalizer.key("横浜市中区 山下町1-2-3"))
        XCTAssertEqual(AddressNormalizer.key("ＡＢＣビル１０１"), "abcビル101")
        XCTAssertNotEqual(AddressNormalizer.key("山下町1-2-3"), AddressNormalizer.key("山下町1-2-4"))
        XCTAssertEqual(AddressNormalizer.key("コーポ・ハイツー"), "コーポ・ハイツー", "カタカナの長音は維持")
    }

    func testDecodeUTF8() {
        XCTAssertEqual(CSV.decode(Data("住所\n".utf8)), "住所\n")
    }
}
