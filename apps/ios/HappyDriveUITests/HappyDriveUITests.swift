import XCTest

/// ローカル API に対する通し試験（ログイン → 案件検索 → 受諾 → 業務完了 → 報酬）。
///
/// 実行条件（環境変数。Xcode のスキームまたは `xcodebuild test` で指定）:
/// - HD_UITEST_API    : 接続先 API（例 http://localhost:8080/v1）。未設定なら試験全体をスキップ
/// 電話番号確認は無く、起動時にこの端末のアカウントへ自動でサインインする。
/// 受諾まで進めるには、運営Webでそのアカウントを本人確認済みにしておくこと。
///
/// 事前に API 側で、受諾可能な公開案件（開始30分前以降・チェックイン半径内に位置を設定できるもの）を用意すること。
/// シミュレータの位置は Xcode の「Simulate Location」で案件の集合場所に合わせる。
/// Xcode 16 SDK では XCUIApplication / XCUIElement がメインアクター分離のため、クラス全体を @MainActor にする。
/// （同期の setUpWithError は非分離の宣言を上書きするため、分離を変えられる async の setUp を使う）
@MainActor
final class HappyDriveUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let api = env["HD_UITEST_API"], !api.isEmpty else {
            throw XCTSkip("HD_UITEST_API が未設定のため、ローカル API との通し試験をスキップします")
        }
        app = XCUIApplication()
        app.launchEnvironment["HD_API_BASE_URL"] = api
        app.launch()
        addUIInterruptionMonitor(withDescription: "権限ダイアログ") { alert in
            for label in ["Appの使用中は許可", "Allow While Using App", "許可", "Allow", "OK"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
    }

    func testOnboardingSearchAcceptCompleteEarnings() throws {
        // 1. 起動するとこの端末のアカウントに自動でサインインし、メイン画面が開く（電話番号確認なし）。
        //    受諾まで進めるには、運営Webでこの端末のアカウントを本人確認済みにしておくこと。
        if app.buttons["startButton"].waitForExistence(timeout: 5) {
            app.buttons["startButton"].tap()
        }

        // 2. 登録（規約未同意なら同意。審査済みユーザーを前提とする）
        if app.switches["agreeTermsToggle"].waitForExistence(timeout: 5) {
            app.switches["agreeTermsToggle"].tap()
            app.switches["agreePrivacyToggle"].tap()
            app.buttons["acceptTermsButton"].tap()
        }
        if app.buttons["startUsingAppButton"].waitForExistence(timeout: 3) {
            app.buttons["startUsingAppButton"].tap()
        } else if app.buttons["deferOnboardingButton"].waitForExistence(timeout: 2) {
            XCTFail("テスト用ユーザーの登録が完了していません（本人確認済みのユーザーを使用してください）")
        }

        // 3. 案件を探す
        let jobsTab = app.tabBars.buttons["案件"]
        XCTAssertTrue(jobsTab.waitForExistence(timeout: 15))
        jobsTab.tap()
        let firstJob = app.buttons.matching(identifier: "jobCard").firstMatch
        XCTAssertTrue(firstJob.waitForExistence(timeout: 15), "受諾できる公開案件が見つかりません")
        firstJob.tap()

        // 4. 受諾
        let review = app.buttons["reviewAndAcceptButton"]
        XCTAssertTrue(review.waitForExistence(timeout: 10), "受諾ボタンがありません（満員・不適格・受諾済みの可能性）")
        review.tap()
        app.switches["confirmTermsToggle"].tap()
        app.buttons["acceptJobButton"].tap()
        app.tap() // 通知許可ダイアログ用

        // 5. 業務を進める
        let start = app.buttons["移動を開始する"]
        XCTAssertTrue(start.waitForExistence(timeout: 15), "業務画面に遷移しません")
        start.tap()
        let checkIn = app.buttons["checkInButton"]
        XCTAssertTrue(checkIn.waitForExistence(timeout: 15))
        let enabled = NSPredicate(format: "isEnabled == true")
        expectation(for: enabled, evaluatedWith: checkIn)
        waitForExpectations(timeout: 30)
        checkIn.tap()
        let startWork = app.buttons["業務を開始する"]
        XCTAssertTrue(startWork.waitForExistence(timeout: 15))
        startWork.tap()

        // 手順を順に完了（写真が必要な手順がある案件はこの試験の対象外）
        while app.buttons["completeStepButton"].waitForExistence(timeout: 5) {
            app.buttons["completeStepButton"].tap()
            sleep(1)
        }
        let toReport = app.buttons["完了報告へ進む"]
        XCTAssertTrue(toReport.waitForExistence(timeout: 10))
        toReport.tap()
        let note = app.textFields["reportNoteField"]
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        note.tap()
        note.typeText("UIテストによる完了報告")
        app.buttons["submitReportButton"].tap()
        XCTAssertTrue(app.staticTexts["お疲れさまでした"].waitForExistence(timeout: 15))
        app.buttons["backHomeButton"].tap()

        // 6. 報酬
        app.tabBars.buttons["マイページ"].tap()
        let earnings = app.buttons["報酬・振込履歴"]
        XCTAssertTrue(earnings.waitForExistence(timeout: 10))
        earnings.tap()
        XCTAssertTrue(app.navigationBars["報酬・振込履歴"].waitForExistence(timeout: 10))
    }
}
