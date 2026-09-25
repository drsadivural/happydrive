# テスト結果（apps/ios）

## HappyDriveCore（swift test）

| 項目 | 内容 |
|---|---|
| 実行日時 | 2026-09-25 23:22 UTC（2026-09-26 08:22 JST） |
| 環境 | Ubuntu 26.04.1 LTS（x86_64）、Linux。Xcode なし |
| ツールチェーン | Swift version 6.1.3 (swift-6.1.3-RELEASE)、Target: x86_64-pc-linux-gnu（apt パッケージ `swiftlang` 6.1.3-4build1） |
| 依存 | apple/swift-crypto 3.15.1、apple/swift-asn1 1.7.3（Package.resolved） |
| コマンド | `cd apps/ios/HappyDriveCore && swift build && swift test` |
| ビルド | 成功。StrictConcurrency（実験的機能）有効で警告 0 |
| 結果 | **67 件実行、失敗 0**（XCTest） |

スイート別：

| スイート | 件数 | 結果 |
|---|---|---|
| APIClientTests | 12 | 成功 |
| CSVTests | 8 | 成功 |
| FormattingTests | 6 | 成功 |
| LogicTests | 19 | 成功 |
| ModelDecodingTests | 12 | 成功 |
| OfflineQueueTests | 10 | 成功 |

出力の末尾（抜粋）：

```
Test Suite 'OfflineQueueTests' passed
	 Executed 10 tests, with 0 failures (0 unexpected) in 0.016 (0.016) seconds
Test Suite 'debug.xctest' passed
	 Executed 67 tests, with 0 failures (0 unexpected) in 0.716 (0.716) seconds
Test Suite 'All tests' passed
	 Executed 67 tests, with 0 failures (0 unexpected) in 0.716 (0.716) seconds
```

経過：初回実行で 2 件失敗（日時を秒単位で再エンコードするため、端末で記録した小数秒付きの時刻が暗号化キャッシュ・キューの往復で一致しない）。
`HDJSON.formatDateTime` を「秒未満がある場合のみミリ秒を付ける」に修正して再実行し、67 件すべて成功。

## 実施していない試験

| 試験 | 状態 | 理由 |
|---|---|---|
| Xcode でのアプリ（HappyDrive ターゲット）ビルド | **未実施** | Linux 環境のため Xcode・iOS SDK がない。SwiftUI 層は未コンパイル |
| シミュレータ / 実機での起動・操作 | **未実施** | 同上 |
| HappyDriveUITests（通し UI テスト） | **未実施** | 同上。実行には Xcode と `HD_UITEST_API` 等の設定が必要 |
| ローカル API との結合 | **未実施** | services/api は並行して実装中 |
| docs/spec/ACCEPTANCE.md の iOS 実機項目（UI-01〜03, PRI-01/02, DEL-01〜03, JOB-02/04, APP-01 等） | **未実施** | 実機・API・審査環境が必要 |

`project.pbxproj` は生成スクリプトで作成し、構文（OpenStep plist として解析可能）と全オブジェクト参照の整合性のみ機械的に確認済み。Xcode で開けることは未確認。

## コンパイル確認（静的レビュー）

| 項目 | 内容 |
|---|---|
| 実施日 | 2026-09-26 |
| 環境 | 上記と同じ Linux（Swift 6.1.3）。**Xcode・iOS SDK がないため、アプリ（HappyDrive）と HappyDriveUITests のコンパイルは一度も実行できていない** |
| 前提としたビルド設定 | Xcode 16 / iOS 17.0 以上 / `SWIFT_VERSION = 5.0`（Swift 5 言語モード）/ `SWIFT_STRICT_CONCURRENCY = targeted`（xcconfig・project.pbxproj） |
| 結論 | 以下の「修正」を適用した。これはコードを読んで行った静的レビューの結果であり、**Xcode でビルドが通ることの確認ではない**。最初の Xcode ビルドで残る指摘があれば修正すること |

### 確認した内容

- HappyDrive/（39 ファイル）と HappyDriveUITests/（1 ファイル）の全 Swift ファイルを通読し、HappyDriveCore の公開 API（`Sources/` を全読）と照合：型名・メンバー名・引数ラベル・`public` の有無・Optional の有無・`async`/`throws` の有無、公開イニシャライザの有無（`Job` 等 init が internal の型をアプリ側で生成していないこと）
- SwiftUI / MapKit / iOS 17 API の使い方：`Map` のコンテンツビルダー（`MapPolyline` / `Annotation` / `Marker` / `UserAnnotation` / `ForEach` / `if`）、`onChange(of:)` の 2 引数形式、`PhotosPicker`、`ToolbarContentBuilder` 内の `if`、`@Observable` + `@Bindable` / `@Environment(Type.self)`、`NavigationStack(path:)` と `NavigationPath`、`ContentUnavailableView`、`ShareLink`、`fileImporter`、PencilKit（`UIViewRepresentable`）、`UIImagePickerController`、Vision（`VNRecognizeTextRequest`）。VisionKit（`DataScannerViewController`）は使っていない
- 並行処理：Swift 5 モード + targeted のため、SDK 由来のメインアクター分離の不一致は警告止まりと判断。`@MainActor` クラスの `nonisolated` デリゲートメソッドは `MainActor.assumeIsolated` で分離されていることを確認
- 必要な `import`（`@Observable` は Observation モジュールのマクロで、Foundation のみの import では使えない）
- アセットカタログ参照：`Image("Wordmark")`・`Image("AppLogo")`、Info.plist の `LaunchBackground`・`AppLogo`、`AccentColor`・`AppIcon` がすべて Assets.xcassets に存在。各 Contents.json・Localizable.xcstrings（JSON）・PrivacyInfo.xcprivacy・Info.plist・Info-Debug.plist・entitlements（plist）が解析できること
- Info.plist の権限文言：カメラ（`UIImagePickerController`）→ `NSCameraUsageDescription` あり、位置（When In Use のみ）→ `NSLocationWhenInUseUsageDescription` あり（ja.lproj/InfoPlist.strings も同内容）。`PhotosPicker` は読み取りのみで写真ライブラリへの書き込みはないため `NSPhotoLibrary(Add)UsageDescription` は不要。通知は Info.plist キー不要（entitlements の `aps-environment` あり）。PrivacyInfo は UserDefaults（CA92.1）を宣言済み
- `project.pbxproj`：`scripts/gen_xcodeproj.py` を再実行して差分がないこと（全 Swift 40 ファイル＝アプリ 39 + UI テスト 1、リソース 6 件を参照）、Info-Debug.plist も差分なし
- 機械的確認：全 40 ファイルに `swiftc -parse`（構文エラー 0）。Apple フレームワークに依存しない `App/AppConfig.swift` は Linux 上で HappyDriveCore モジュールに対して `swiftc -typecheck` し成功
- 修正後に `swift test --package-path apps/ios/HappyDriveCore` を再実行し、67 件実行・失敗 0

### 修正

| ファイル | 問題 | 修正 |
|---|---|---|
| App/LocationSharingController.swift | `@Observable` / `@ObservationIgnored` を使うが import が Foundation のみ（未知の属性でエラー） | `import Observation` を追加 |
| Features/Delivery/DeliveryViewModel.swift | 同上 | `import Observation` を追加 |
| Platform/LocationService.swift | 同上（CoreLocation/Foundation のみ） | `import Observation`（と Logger 用に `import os`）を追加 |
| Platform/MediaServices.swift | `AddressSearchService` の `@Observable`（MapKit/UIKit/Vision のみ） | `import Observation` を追加 |
| Platform/SystemServices.swift | `NetworkMonitor` の `@Observable`（SwiftUI を import していない） | `import Observation` を追加 |
| Features/Delivery/RouteMapView.swift | `.annotationTitles(.hidden)` を `Map`（View）に付けていた。これは `MapContent` の修飾子で View にはない | `ForEach` 内の `Annotation` に付け替え（表示は同じ） |
| Features/Workflow/AssignmentWorkflowView.swift | `.toolbar { toolbar }` で `@ToolbarContentBuilder` のプロパティ名が View の `toolbar(...)` メソッドと同名で曖昧になり得る | プロパティ名を `toolbarContent` に変更 |
| App/SessionStore.swift | `@Observable` クラスの保存プロパティ `onboardingDeferred` に `didSet`（マクロが get/set を合成するプロパティとの組み合わせに依存しない形にする） | 追跡対象の保存プロパティ `onboardingDeferredStorage` と、setter で UserDefaults に保存する計算プロパティ `onboardingDeferred` に分離（初期化時は保存しない点も従来と同じ） |
| Features/MyPage/MyPageView.swift | `async let` の初期化式でメインアクター分離の View の `env` を子タスクから参照していた | `let session = env.session` を先に取り出してから `async let` |
| HappyDriveUITests/HappyDriveUITests.swift | Xcode 16 SDK では `XCUIApplication`/`XCUIElement` がメインアクター分離。非分離のテストクラスから使っていた（Swift 5 モードでは警告、Swift 6 ではエラー） | クラスを `@MainActor` にし、同期の `setUpWithError()` を分離を変えられる `setUp() async throws` に変更（XCTSkip の扱い・処理内容は同じ） |
| App/AppEnvironment.swift, App/HappyDriveApp.swift, Features/MyPage/AccountViews.swift | 別ファイルの import に依存して `Logger` のメッセージリテラル／`CLAuthorizationStatus` を使っていた（現行の Swift 5 モードでは通るが、import の可視性が厳密になると失敗する） | `import os` / `import CoreLocation` を明示 |

### 確認したが変更していない点（Xcode ビルド時に要確認）

- `@MainActor` 型の既定値付きプロパティ（`AppEnvironment` の `let network = NetworkMonitor()` 等）、`CameraPicker`/`SignatureCanvas` の Coordinator からの `dismiss()`・Binding 更新、`TextRecognizer` の `Task.detached` への `CGImage` の受け渡しなどは、Swift 5 モードでは並行処理の**警告**になる可能性がある（エラーにはならない想定）。Swift 6 言語モードへ移行する際に対応が必要
- ローカルパッケージはフォルダ参照 + `XCSwiftPackageProductDependency`（`package` 指定なし）で接続している（XcodeGen と同じ旧来形式）。Xcode 16 で解決されることは未確認
- `HappyDrive.entitlements` の `aps-environment` は `development` 固定。配布（Release）時は署名・書き出しで `production` になることを確認すること
