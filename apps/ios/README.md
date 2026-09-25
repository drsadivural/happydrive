# HappyDrive ドライバーアプリ（iOS）

配送（配送先登録・ルート・配達記録）と Happy案件（検索・受諾・業務実行・報酬）を 1 つにした、ドライバー / 地域サポーター向けの iPhone アプリです。SwiftUI・iOS 17 以降・日本語（ja-JP）のみ。

> **重要：このアプリは Linux 環境で作成しており、Xcode でのビルド・シミュレータ・実機での動作確認は一度も行っていません。**
> UI 層（SwiftUI）のコードはコンパイルされていないため、初回の Xcode ビルドでコンパイルエラーが出る可能性があります。
> 動作を確認できているのは `HappyDriveCore`（UI 以外のロジック）の単体テストのみです（[TEST_RESULTS.md](TEST_RESULTS.md)）。

## 構成

```
apps/ios/
├── HappyDrive.xcodeproj/        # scripts/gen_xcodeproj.py で生成（XcodeGen 不要で開ける）
├── project.yml                  # 同等の XcodeGen 定義（任意）
├── Config/                      # xcconfig（Debug=ローカルAPI / Release=本番API）
├── HappyDrive/                  # アプリ本体（SwiftUI）
│   ├── App/                     # 起動・環境・セッション・画面遷移・位置共有
│   ├── Platform/                # Keychain・通信監視・位置情報・プッシュ・住所検索・端末内OCR
│   ├── DesignSystem/            # HDTokens.swift（生成物）・フォント・共通部品・状態表示
│   ├── Features/
│   │   ├── Onboarding/          # ログイン（電話番号→確認コード）・規約・本人情報・車両・口座・本人確認・審査状況
│   │   ├── Home/                # ホーム（本日の予定・ルート・近くの案件・通知）
│   │   ├── Delivery/            # 配送先一覧・地図・追加/編集・CSV取込・写真から住所・最適化・配達記録・日報
│   │   ├── Jobs/                # 案件検索（リスト/地図）・詳細・受諾確認・マイ案件・通報・異議申立て
│   │   ├── Workflow/            # 業務を進める・チェックイン・手順・完了報告・評価・メッセージ
│   │   ├── Learning/            # 講習・確認テスト・資格期限
│   │   ├── MyPage/              # 報酬・振込・実績・資格・通知・設定・権限・サポート・退会
│   │   └── Shared/              # 写真添付（EXIF除去）・受領サイン（PencilKit）
│   ├── Resources/               # Assets（AppIcon 仮・ワードマーク）・Noto Sans JP・PrivacyInfo・文字列
│   ├── Supporting/              # Info.plist（Release）/ Info-Debug.plist（生成）/ entitlements
│   └── Preview Content/         # Xcode プレビュー専用のサンプル（#if DEBUG、リリースに含まれない）
├── HappyDriveUITests/           # 通し UI テスト（HD_UITEST_API 未設定ならスキップ）
├── HappyDriveCore/              # Swift Package：UI 以外のロジック（Linux / macOS でテスト可能）
│   ├── Sources/HappyDriveCore/
│   │   ├── Models/              # 契約 openapi.yaml v1.1 の Codable モデル
│   │   ├── Networking/          # APIClient（Bearer・401時のリフレッシュ単一実行・冪等キー・日本語エラー）
│   │   ├── Offline/             # オフラインキュー（同じ冪等キーで再送・対象ごとの順序保証・証跡の後送）
│   │   ├── Storage/             # AES-GCM 暗号化ストア（今日の配送キャッシュ・キュー）
│   │   ├── CSV/                 # CSV 解析/生成・配送先 CSV の事前検証・住所の重複判定
│   │   ├── Formatting/          # JST 日時・円・所要時間・状態ラベル（日本語）
│   │   └── Logic/               # 登録手順・業務進行・受諾失敗の扱い・チェックイン判定・運転中判定・ルート要約
│   └── Tests/HappyDriveCoreTests/  # XCTest（契約どおりのサンプル JSON を含む）
├── scripts/gen_xcodeproj.py
└── TEST_RESULTS.md
```

`HappyDrive/DesignSystem/HDTokens.swift` は `packages/design-tokens/tokens.json` から生成された `packages/design-tokens/dist/HDTokens.swift` のコピーです。直接編集せず、トークンを変更したら `pnpm --filter @happydrive/design-tokens build` 後に再コピーしてください。

## Xcode で開く・ビルドする（Xcode 16 以降）

1. `apps/ios/HappyDrive.xcodeproj` を開く（ローカルパッケージ `HappyDriveCore` と依存する `swift-crypto` が自動で解決されます。初回はネットワークが必要）。
2. Signing & Capabilities で Team を選ぶ（`Config/Shared.xcconfig` の `DEVELOPMENT_TEAM` に設定しても可）。Bundle ID は `jp.happydrive.driver`。
3. スキーム `HappyDrive` / シミュレータ（iPhone, iOS 17 以降）で Run。

プロジェクトファイルを作り直す場合（ファイルを追加・削除したとき）:

```sh
python3 apps/ios/scripts/gen_xcodeproj.py     # Info-Debug.plist と project.pbxproj・共有スキームを再生成
# または XcodeGen: cd apps/ios && xcodegen generate
```

### 設定（xcconfig → Info.plist）

| 設定 | Debug | Release |
|---|---|---|
| `API_BASE_URL` | `http://localhost:8080/v1` | `https://api.happydrive.jp/v1` |
| ATS | `Info-Debug.plist` で localhost（と LAN）への HTTP のみ許可 | 例外なし（HTTPS のみ） |
| `HD_APNS_ENVIRONMENT` | sandbox | production |

- 実機からローカル API に接続する場合は `Config/Debug.xcconfig` の `API_BASE_URL` を Mac の LAN IP（例 `http:/$()/192.168.0.10:8080/v1`）に変更してください（xcconfig では `//` がコメントになるため `/$()/` と書きます）。
- Debug ビルドに限り、環境変数 `HD_API_BASE_URL` で接続先を上書きできます（UI テスト用）。
- 利用規約・プライバシーポリシーの版（`HD_TERMS_VERSION` / `HD_PRIVACY_VERSION`、`/me/terms` に送信）と公開 URL（`HD_TERMS_URL` 等）は `Config/Shared.xcconfig` にあります。**事業者が公開する正式な版・URL に差し替えてください。**

## ローカル API への接続と確認コード（OTP）

1. `services/api` をローカルで起動（`http://localhost:8080/v1`）。
2. アプリで電話番号を入力 → 「確認コードを送信」。
3. **開発モードの API は SMS を送らず、確認コードを API のログに出力します。** ログに表示された 6 桁を入力してください。
4. 新規登録の場合は規約同意 → 本人情報 → 車両 → 口座 → 本人確認書類の順に進みます（規約以外は「あとで」で後回しにして閲覧できますが、受諾は審査承認後のみ）。審査の承認は運営 Web（admin-web）または API の管理操作で行います。

## HappyDriveCore のテスト（Linux / macOS）

```sh
cd apps/ios/HappyDriveCore
swift build
swift test
```

Linux では Swift 6.1 以降（Ubuntu は `sudo apt-get install swiftlang` または swiftly）で実行できます。Apple の CryptoKit と同じ API の `swift-crypto` を使っているため、同じコードが iOS でもそのまま動きます。結果の記録は [TEST_RESULTS.md](TEST_RESULTS.md)。

テスト範囲：契約サンプル JSON のデコード（未知の列挙値を含む）、日時の UTC/JST 変換、PATCH の null 送信、APIClient（Bearer・401 → リフレッシュ → 同じ冪等キーで 1 回再送・同時 401 でもリフレッシュ 1 回・リフレッシュ失敗時のセッション失効・日本語エラー）、オフラインキュー（記録順・対象ごとの順序・4xx 破棄/408・429・5xx・圏外は保持・再起動後の再送・同じ冪等キー・並行再送で二重送信しない・証跡を 1 回だけアップロードして evidenceIds に追加・暗号化保存）、書式（円・所要時間・JST）、CSV（引用符・改行・BOM・CR・未終端・日本語見出し・全角住所の重複）、登録手順・業務進行・受諾失敗の扱い・チェックイン判定・運転中判定・ルート要約・並べ替え・通知の遷移先・入力検証・AES-GCM。

## UI テスト

`HappyDriveUITests` はローカル API に対して「ログイン → 案件検索 → 受諾 → チェックイン → 手順完了 → 完了報告 → 報酬画面」を操作します。環境変数 `HD_UITEST_API` が無い場合はスキップします。スキームの Test の環境変数（`HD_UITEST_API` / `HD_UITEST_PHONE` / `HD_UITEST_OTP`）を有効にし、審査済みのテスト用ドライバーと受諾可能な案件を API 側で用意して、シミュレータの位置を集合場所に合わせて実行してください。**このテストもまだ一度も実行していません。**

## 設計上のポイント

- **契約**：`packages/contracts/openapi.yaml`（v1.1）に合わせた JSON（camelCase、日時は UTC の ISO 8601、金額は整数円）。エラーは契約の `{code, message, requestId, details}` を `APIError` にして、`message`（日本語）を優先表示。
- **認証**：トークンは Keychain（この端末のみ）。401 でリフレッシュトークンをローテーション（同時多発でも 1 回だけ）。失敗したらログイン画面に戻る。
- **冪等性**：受諾・配送/業務イベント・取込・証跡作成などは `Idempotency-Key` を付与し、再試行では同じキーを使う（受諾確認シートを開いている間は固定）。本文が変わる再送（重複承知の登録等）は新しいキー。
- **オフライン**：配送イベント・業務イベントは端末に暗号化保存してから送信。圏外・5xx・408・429 は保持して接続回復時（NWPathMonitor）とアプリ復帰時に再送。4xx は破棄して利用者に通知。同じ配送先/案件の操作は記録順を守る。写真・サインも暗号化して一時保存し、再送時に先にアップロード。今日の配送先（停止順・住所・メモ）は AES-GCM で暗号化キャッシュ（地図タイルのオフライン利用は約束しない）。
- **位置情報**：When In Use のみ（バックグラウンド追跡なし）。案件検索はおおよその位置（小数 3 桁）、位置が拒否されていればエリア名で手動検索。業務中（移動中/チェックイン後/実行中）だけ発注者に最新 1 点を限定共有し、報告送信・状態変化・利用者の停止・アプリのバックグラウンド移行で止める。
- **運転中の操作抑止**：ルート開始後は速度を監視し、約 10km/h 超で編集操作を無効化して「安全のため、停車中に操作してください」を表示（約 5km/h 未満が 5 秒続いたら解除）。
- **ルート**：最適化はサーバー（`/delivery/routes/optimize`）。「推奨ルート」と表示し、厳密な最適解を保証しない旨を明記。`travelTimeSource` が `provider` 以外は「概算」を表示。制約違反と警告を配送先ごとに表示し、手動の並べ替え（`/reorder`）も可能。地図の線は順番の目安（直線）で、道路経路ではない。ナビは Apple マップへ引き継ぎ。
- **住所**：MKLocalSearchCompleter / MKLocalSearch / CLGeocoder で候補を出し、地図で確認して位置を確定。位置未確定の配送先はルートに含めない。写真からの住所読み取りは Vision（端末内、ja-JP）で行い、必ずドライバーが確認・修正する。
- **個人情報**：受取人の電話番号は「受取人に電話」を押した時だけ `/contact` で取得。写真は再エンコードして EXIF（撮影位置）を除去。ログ（os.Logger）に氏名・住所・電話・トークン・位置を出さない。
- **報酬**：見込み / 確定待ち / 支払予定 / 振込済 / 振込失敗 / 取消 を区別し、即時払いと誤解される表現を使わない。雇用（賃金）と業務委託（報酬）を分けて表示。
- **アクセシビリティ**：固定サイズのフォントは使わず `Font.custom(_:size:relativeTo:)`（Noto Sans JP、無ければシステムフォント）で Dynamic Type に追従。状態は必ずアイコン＋文字で表示（色だけに頼らない）。主要なタップ領域は 44pt 以上。VoiceOver ラベル（地図のピン・金額・状態・アイコンボタン）を設定。ライト/ダーク対応（トークンの色）。

## 画面と API の対応（主なもの）

| 画面 | API |
|---|---|
| ログイン | `POST /auth/otp/request`（`resendAfterSeconds` で再送カウントダウン）, `POST /auth/otp/verify`, `POST /auth/refresh`, `POST /auth/logout` |
| 登録 | `POST /me/terms`, `PUT /me/profile`, `PUT /me/vehicle`, `PUT /me/bank-account`, `POST /evidence/uploads` → 署名 URL へ PUT → `POST /evidence/{id}/complete` → `POST /me/verification`, `GET /me` |
| ホーム | `GET /home`, `GET /delivery/stops` |
| 配送 | `GET/POST /delivery/stops`, `POST /delivery/stops/import`（dryRun → 取込）, `GET/PATCH/DELETE /delivery/stops/{id}`, `GET /delivery/stops/{id}/contact`, `POST /delivery/routes/optimize`, `GET /delivery/routes`, `POST /delivery/routes/{id}/reorder`, `POST /delivery/routes/{id}/start`, `POST /delivery/stops/{id}/events`（キュー経由）, `GET /delivery/reports/daily` |
| 案件 | `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/accept`（termsHash）, `PUT/DELETE /jobs/{id}/favorite`, `PUT/DELETE /jobs/{id}/waitlist`, `POST /matching/appeals`, `POST /reports`, `POST /blocks` |
| 業務 | `GET /assignments`, `GET /assignments/{id}`, `POST /assignments/{id}/events`（キュー経由）, `POST /assignments/{id}/location`, `POST /assignments/{id}/rating`, `GET/POST /assignments/{id}/messages` |
| 学ぶ | `GET /learning/courses`, `GET /learning/courses/{id}`, `POST /learning/courses/{id}/attempts` |
| マイページ | `GET /earnings/summary`, `GET /earnings`, `GET /payouts`, `GET /notifications`, `POST /notifications/read`, `GET /skills/catalog`, `POST /me/skills`, `PUT /me/preferences`, `PATCH /me`, `GET/POST /support/tickets`, `DELETE /me`（confirm=false → true の 2 段階）, `POST/DELETE /me/devices` |

## 審査用アカウントについて

- App Store 審査用に、**本人確認済み（verified）のドライバー**の電話番号と、審査期間中に使える確認コードの入手方法（固定コードの審査用番号など、API 側の仕組み）を用意して App Store Connect の「審査メモ」に記載してください（docs/spec/APPLE_RELEASE.md）。本アプリには審査用の裏口や固定コードは実装していません。
- 審査で全導線を確認できるよう、受諾可能な公開案件と配送先のサンプルデータを API 側に用意してください。
- アカウント削除はアプリ内（マイページ → アカウント・設定 → 退会）から完結します。

## 検証していないこと（必読）

- **Xcode でのビルド、シミュレータ・実機での起動や操作、UI テストの実行はいずれも未実施です**（この環境は Linux で Xcode がありません）。SwiftUI・MapKit・Vision・PencilKit 等を使う UI 層は一度もコンパイルしていません。
- 実機での GPS・低精度位置・位置拒否・圏外・低電力・通知拒否・ダークモード・最大の文字サイズ・VoiceOver の確認は未実施です（docs/spec/ACCEPTANCE.md の UI-01〜03, PRI-01, DEL-03 等は未合格扱い）。
- Noto Sans JP（可変フォント）の名前付きインスタンス（`NotoSansJP-Bold` 等）が iOS で個別に解決されるかは未確認です。解決できない場合はシステムフォントに自動で切り替わります。
- ローカル API（`services/api`）は別担当が並行して実装中のため、実 API との結合は未確認です。
- AppIcon は `assets/brand/app-icon-reference.png` から作った**仮アイコン**、ワードマークも参照画像です（背景付き）。**提出前に権利者提供の正式マスター（1024px・不透明）に差し替えてください。**

## リリース前チェックリスト

[docs/spec/APPLE_RELEASE.md](../../docs/spec/APPLE_RELEASE.md) と [docs/spec/ACCEPTANCE.md](../../docs/spec/ACCEPTANCE.md) に従ってください。特に：

- [ ] Xcode でビルドし、コンパイルエラー・警告を解消（本リポジトリでは未ビルド）
- [ ] 正式ロゴから AppIcon（1024px 不透明）とワードマークを差し替え
- [ ] Team / Bundle ID / APNs 鍵 / `aps-environment`（本番）を設定
- [ ] 利用規約・プライバシーポリシーの版と URL、サポート URL を正式なものに
- [ ] `PrivacyInfo.xcprivacy` と App Store Connect のプライバシー回答を実際のビルド・SDK と照合（電話番号・氏名・住所・正確な位置・写真・ユーザーID・支払い情報（振込口座）・その他のユーザーコンテンツ・サポート・デバイスID(APNs)）
- [ ] 権限文（位置・カメラ）が実際の機能と一致しているか確認（写真ライブラリは PhotosPicker のため権限不要）
- [ ] 実機 2 機種以上・旧/新 iOS で、位置拒否/低精度・圏外→復帰での重複なし送信・通知拒否・ダークモード・大きい文字・VoiceOver を確認
- [ ] 審査用アカウントと手順書、サンプル案件
- [ ] TestFlight でクラッシュ 0、P0/P1 バグ 0
