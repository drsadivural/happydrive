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
│   │   ├── Voice/               # AIアシスタント（WebRTC による音声会話・文字入力）
│   │   └── Shared/              # 写真添付（EXIF除去）・受領サイン（PencilKit）
│   ├── Resources/               # Assets（AppIcon 仮・ワードマーク）・Noto Sans JP・PrivacyInfo・文字列
│   ├── Supporting/              # Info.plist（Release）/ Info-Debug.plist（生成）/ entitlements
│   └── Preview Content/         # Xcode プレビュー専用のサンプル（#if DEBUG、リリースに含まれない）
├── HappyDriveUITests/           # 通し UI テスト（HD_UITEST_API 未設定ならスキップ）
├── HappyAvatarKit/              # Swift Package：音声アシスタントのアバター（SwiftUI。ロジックは Linux でもテスト可能）
├── HappyDriveCore/              # Swift Package：UI 以外のロジック（Linux / macOS でテスト可能）
│   ├── Sources/HappyDriveCore/
│   │   ├── Models/              # 契約 openapi.yaml v1.1 の Codable モデル
│   │   ├── Networking/          # APIClient（Bearer・401時のリフレッシュ単一実行・冪等キー・日本語エラー）
│   │   ├── Offline/             # オフラインキュー（同じ冪等キーで再送・対象ごとの順序保証・証跡の後送）
│   │   ├── Storage/             # AES-GCM 暗号化ストア（今日の配送キャッシュ・キュー）
│   │   ├── CSV/                 # CSV 解析/生成・配送先 CSV の事前検証・住所の重複判定
│   │   ├── Formatting/          # JST 日時・円・所要時間・状態ラベル（日本語）
│   │   ├── Logic/               # 登録手順・業務進行・受諾失敗の扱い・チェックイン判定・運転中判定・ルート要約
│   │   └── Voice/               # 音声アシスタントの状態遷移・イベント解析・ツール・指標
│   └── Tests/HappyDriveCoreTests/  # XCTest（契約どおりのサンプル JSON を含む）
├── scripts/gen_xcodeproj.py
└── TEST_RESULTS.md
```

`HappyDrive/DesignSystem/HDTokens.swift` は `packages/design-tokens/tokens.json` から生成された `packages/design-tokens/dist/HDTokens.swift` のコピーです。直接編集せず、トークンを変更したら `pnpm --filter @happydrive/design-tokens build` 後に再コピーしてください。

## Xcode で開く・ビルドする（Xcode 16 以降）

1. `apps/ios/HappyDrive.xcodeproj` を開く（ローカルパッケージ `HappyDriveCore` と依存する `swift-crypto`、音声アシスタント用の `WebRTC` が自動で解決されます。初回はネットワークが必要）。
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

`HappyDriveUITests` はローカル API に対して「ログイン → 案件検索 → 受諾 → チェックイン → 手順完了 → 完了報告 → 報酬画面」を操作します。環境変数 `HD_UITEST_API` が無い場合はスキップします。スキームの Test の環境変数 `HD_UITEST_API` を有効にし、シミュレータの端末アカウント（初回起動で自動作成）を運営Webで本人確認済みにし、受諾可能な案件を用意して、シミュレータの位置を集合場所に合わせて実行してください。**このテストもまだ一度も実行していません。**

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

## リアルタイム音声（AIアシスタント）

ホームの「音声で話す」ボタン（またはマイページ →「AIアシスタント（音声で話す）」）から、**HappyDrive AIアシスタント**と日本語で会話できます。音声が主で、同じ会話の中で文字入力（キーボード）も使えます。

### しくみ

```
アプリ ──POST /voice/realtime-session（Bearer）──▶ HappyDrive API ──▶ OpenAI（一時キーを発行。指示文・声・VAD・ツールはサーバー側で設定）
アプリ ──SDP offer（Bearer 一時キー, application/sdp）──▶ callUrl（OpenAI Realtime / WebRTC）
アプリ ◀══ 音声（WebRTC）＋ データチャネル "oai-events"（JSON イベント）══▶ OpenAI
アプリ ──ツール呼び出し──▶ 既存の HappyDrive API（本人の権限で読み取りのみ）
アプリ ──POST /voice/sessions/{id}/end（品質指標のみ・本文なし）──▶ HappyDrive API
```

| 層 | 場所 | 内容 |
|---|---|---|
| 純粋ロジック（Linux でテスト） | `HappyDriveCore/Sources/HappyDriveCore/Voice/` | `VoiceConfiguration`（再接続は最大3回・0.5秒起点の指数バックオフ＋ジッター・上限8秒、接続タイムアウト15秒、ツール8秒、アイドル/最大時間はサーバー値で上書き）、`VoiceStateMachine`（状態遷移）、`VoiceError`（日本語メッセージ・API エラーの変換）、`RealtimeEventParser` / `RealtimeClientEvent`（型付きのイベント解析・Encodable での送信）、`TranscriptAssembler`（差分の組み立て・割り込み）、`RealtimeTurnTracker`（バージイン・ツール結果の返送と続きの応答を1回だけ）、`VoiceToolDispatcher`（許可リスト×サーバー有効ツール、引数検証、タイムアウト、既存 API のみ）、`VoiceMetricsRecorder`（P50/P95）、`HappyDriveAPI.createVoiceSession` / `endVoiceSession` |
| アプリ | `HappyDrive/Features/Voice/` | `WebRTCClient`（音声のみの PeerConnection・データチャネル・SDP 交換・後片付け）、`AudioSessionManager`（`.playAndRecord` + `.voiceChat` でエコーキャンセル、Bluetooth は HFP のみ、スピーカー/受話口、割り込み・経路変更・メディアサービス再起動の監視、RTCAudioSession は手動モード）、`RealtimeVoiceService`（全体の進行）、画面（`VoiceConversationView` / `VoiceOrbView` / `VoiceTranscriptView` / `VoiceControlsView`） |

- **依存**：WebRTC は Swift Package `https://github.com/stasel/WebRTC`（153.0.0 以上の同メジャー、バイナリ xcframework）。アプリ本体のみにリンクし、`HappyDriveCore` には入れません（Linux のテストに影響しない）。`scripts/gen_xcodeproj.py` の `REMOTE_PACKAGES` と `project.yml` で定義。
- **割り込み（バージイン）**：サーバー VAD（semantic_vad・interrupt_response）に加えて、回答の再生中に利用者が話し始めたら端末から `output_audio_buffer.clear`（応答中なら `response.cancel` も）を送り、その回答に「途中で止めました」を付けます。停止までの時間を指標に記録します。
- **ツール**：`get_today_overview` / `list_delivery_stops` / `search_jobs` / `get_job_details` / `list_my_assignments` / `get_earnings_summary` / `list_unread_notifications`。端末の許可リストとサーバーが返す `tools` の両方にあるものだけ実行し、引数（日付 YYYY-MM-DD、月 YYYY-MM、UUID、列挙値）を検証してから既存の API を呼びます。不正な引数・未知のツールは実行せず `{"error":{"code","message"}}` を返します。受取人の氏名・電話・正確な位置はモデルに渡しません。
- **文字入力**：キーボードに切り替えると、文字はデータチャネルの `conversation.item.create`（input_text）で送り、応答は文字だけ（`output_modalities: ["text"]`）を求めます。文字入力中はマイクをオフにします。
- **会話記録**：`AppEnvironment.voice` がメモリ上だけに保持します（端末・サーバーに保存せず、音声も保存しません）。画面を閉じて開き直したときや再接続したときは、直近 12 発話を会話に入れ直して文脈を引き継ぎます。ログアウト・退会で消去します。
- **終了**：終了ボタン・✕（閉じる）・ミニアバターの ×・アイドル（双方の発話なし、既定 120 秒）・最大時間（既定 900 秒）・アプリのバックグラウンド移行・電話などの音声割り込み。バックグラウンドでは音声を使いません（`UIBackgroundModes` の audio は使用しない）。「最小化」で全画面を閉じたときは会話を続けます（下記「アバター」）。
- **再接続**：通信断（NWPathMonitor）・ICE の失敗/切断（3 秒の猶予）・データチャネルの切断で、新しい一時キーを取得して最大 3 回まで再接続し、文脈を入れ直します。
- **秘密情報**：一時キー（clientSecret）はメモリ上で接続にだけ使い、保存・ログ出力しません（`VoiceSession` の description も伏せ字）。ログには会話の本文を出しません。
- **権限**：マイク（`NSMicrophoneUsageDescription`「AIアシスタントとの音声会話にマイクを使用します。」）。許可ダイアログは未確認のときだけ表示します。拒否されている場合は説明と「設定を開く」を表示し、文字入力で会話を続けられます。`PrivacyInfo.xcprivacy` に「音声データ（ユーザーに紐付けない・トラッキングなし・アプリの機能）」を追加しました。

### テスト

- `swift test --package-path apps/ios/HappyDriveCore`：状態遷移（割り込み・再接続・上限到達・終了）、全イベントの解析（未知・不正 JSON を含む）、送信 JSON、文字起こしの組み立て（差分・交互・割り込み・文脈）、ツール（許可リスト・未知・不正な引数・型違い・タイムアウト・成功時の API 呼び出しと要約）、エラーの変換、再接続の待ち時間（上限・ジッターの範囲）、指標のパーセンタイル、`VoiceSession` のデコード。
- UI テスト `testVoiceAssistantOpensFromHome`（`HD_UITEST_API` 設定時のみ）：ホームから開き、見出し・閉じる・マイク・スピーカー・文字入力・終了、アバター（`voiceAvatar`）、「最小化」→ ミニアバター（`voiceMiniAvatar` / `voiceMiniEndButton` / `voiceMiniMicIndicator`、「音声で話す」が隠れる）→ タップで全画面に戻る、を確認。API が `voice_unavailable` を返す環境では「もう一度試す」が出ることを確認。

### 実機での確認手順（未実施）

> **実際の音声・割り込み・エコーの挙動は、iPhone 実機と、API 側に `OPENAI_API_KEY` を設定した環境が必要です。この実装では実機での確認を一度も行っていません。** シミュレータではマイク・エコーキャンセル・Bluetooth の挙動が実機と異なります。

1. 通常の速さ・早口・長い発話（30 秒以上）で、文字起こしと回答が崩れないこと
2. 回答中に話しかけて、すぐに音声が止まり「途中で止めました」が付くこと（連続で何度か）
3. 人名・数字・日付・金額・住所（例「9月28日の10時から」「1万2千円」「横浜市中区山下町1-2-3」）の聞き取りと読み上げ
4. 静かな場所・騒がしい場所（車内・道路沿い）・音楽を流しながら
5. スピーカー / 受話口の切り替え、AirPods・Bluetooth ヘッドセット・車の Bluetooth（HFP）への切り替えと切断
6. 会話中の圏外 → 復帰（「再接続中…」→ 文脈を保って再開、3 回失敗で「通信が切れました」）
7. Wi-Fi ↔ モバイル通信の切り替え
8. 会話中の電話着信（会話が終了し、案内が出ること）
9. バックグラウンド → 復帰（マイクが止まり、再度開くと文脈が続くこと）
10. 画面の開閉を繰り返してもマイクが残らない・二重に接続しないこと（コントロールセンターのマイク使用表示を確認）
11. マイク拒否 → 説明と「設定を開く」、文字入力での会話
12. 「今日の予定は？」「近くの案件を探して」「今月の報酬は？」「未読のお知らせは？」でツールが呼ばれ、正しい内容を答えること

## アバター（HappyAvatarKit）

音声アシスタントの「Happy AI」を、HappyDrive のマスコット（ピンクの鳥）のアバターで表示します。支給された「HappyDrive Live Avatar Kit」をローカル Swift パッケージ `HappyAvatarKit/` として取り込み、本番向けに修正しました（Example は取り込んでいません）。

### しくみ

```
VoiceStateMachine（唯一の状態機械）
   │ state の遷移
   ▼
RealtimeVoiceService.transition ──AvatarCue.transition(from:to:)──▶ HappyVoiceAvatarBridge ──▶ HappyAvatarController ──▶ HappyAvatarView
   │ バージイン（clear / cancel 送信直後）  ─ .assistantInterrupted ─┘            ▲
   │ WebRTC 統計の出力音量（回答中は約30Hz）─ .assistantAudioLevel ─┘            │
   └ handleHappyDriveEvent（案件・配送・ルート・通信） ─ handleHappyDriveEvent ──┘
```

| 層 | 場所 | 内容 |
|---|---|---|
| 純粋ロジック（Linux でテスト） | `HappyDriveCore/Sources/HappyDriveCore/Voice/AvatarCue.swift` | `AvatarCue.transition(from:to:)`（状態遷移 → アバターの出来事。同じ状態では出さない）、`VoiceLevelMeter`（dB 変換・取得間隔）、`AvatarDomainSignal.containsJobs`（ツール結果に案件があるか）、`DestinationApproachTracker`（200m 以内・1 配送先 1 回） |
| アバター | `HappyAvatarKit/` | `HappyAvatarController`（状態・感情・口・まばたき・視線。描画に依存しない）、`HappyVoiceAvatarBridge`（出来事 → コントローラー）、`HappyAvatarView`（SwiftUI の描画）、`HappyVoiceScreen`（最小構成の画面。アプリでは未使用） |
| アプリ | `HappyDrive/Features/Voice/` | `RealtimeVoiceService`（会話ごとにコントローラーとブリッジを 1 つ作成し、`avatar` として公開。終了で `.ended` を送って解放。エラー時は表示のため残し、✕ で解放）、`VoiceConversationView`（全画面）、`VoiceMiniAvatarView`（ミニアバター） |

キットから変えた点：iOS 17 / macOS 14 に変更（`@Observable` のため iOS 16 ではビルドできなかった）、使っていなかった 60fps の `TimelineView` を削除し、呼吸・しっぽは状態が変わっても止まらない位相アニメーション（`phaseAnimator`）に変更、まばたきのタスクは非表示で取り消しコントローラーを弱参照で保持、`connectionRecovered` で「喜ぶ」が直後の `setIdle` で消えていた不具合を修正、`connecting` で前回のエラー表示を残さない、感情（嬉しい・わくわく・驚き・心配・眠い）を目・ほっぺ・眉で表示、NaN/範囲外の音量を無視、表示部分は `#if canImport(SwiftUI)` で囲み Linux でもロジックをテスト可能に。公開 API の名前は変えていません。

### 会話の状態との対応

| `VoiceConversationState` の遷移 | ブリッジへ | アバター |
|---|---|---|
| → requestingPermission / connecting（開始時 1 回） | `.connecting` | 待機（前回のエラーを消す） |
| → listening（接続・回答終了など） | `.idle` | 待機「お話しください」 |
| reconnecting → listening | `.connectionRecovered` | 待機＋喜ぶ |
| → userSpeaking | `.userSpeechStarted` | 聞く（口を閉じる） |
| → thinking | `.assistantThinking` | 考える（上を見る） |
| → assistantSpeaking | `.assistantSpeechStarted` | 話す（口が音量で動く） |
| 回答中の割り込み（`output_audio_buffer.clear` / `response.cancel` 送信直後。文字送信で止めたときも） | `.assistantInterrupted` | 口をすぐ閉じて聞く |
| → reconnecting | `.reconnecting` | 心配 |
| → error | `.failed` | 心配（エラー） |
| → disconnected / idle（終了） | `.ended` | 初期状態に戻して解放 |

- **口の動き**：WebRTC の `audioLevel`（線形振幅）を、スペクトラムと同じ `(20·log10(x)+50)/50`（-50dB〜0dB → 0〜1）で変換して渡します。キット側でノイズフロア（0.045）→ 正規化 → 低域通過（0.65）→ 小さければ閉じる、を行います。統計の取得は回答中だけ 33ms（約30Hz）、それ以外は 80ms（約12Hz）。上限 60Hz。集計は WebRTC のスレッドで行い、メインスレッドには最終値だけを渡します。音声データそのものには触れません。
- **業務イベント**（会話中のときだけ。それ以外は何もしない）：`search_jobs` / `get_today_overview` の結果に案件が 1 件以上 → `.nearbyJob`（わくわく）、案件の受諾成功 → `.jobAccepted`（嬉しい）、配達完了の記録（送信済み・圏外で保留のどちらも）→ `.deliveryCompleted`（嬉しい）、ルートの最適化・並べ替えの開始 → `.routeRecalculation`（考える）、運行中に移動中（en_route）の配送先から 200m 以内 → `.destinationApproaching`（驚き、1 配送先 1 回。配送タブの位置更新を使用）、会話中に圏外 → `.connectionProblem`（心配）。

### 表示モード

- **全画面**（`.full`）：音声モードではアバター（画面に合わせて約 220〜260pt）と小さなスペクトラム（高さ 56）と状態。話した内容の文字は表示しません（文字入力モードのときだけ会話を文字で表示）。マイク使用中の表示・マイク/スピーカー/文字入力・終了・再試行・エラー・権限の案内は従来どおり。
- **運転中**（`.driving`、`LocationService.isDriving`）：状態の文字だけ（案内・候補は出さない）、文字入力への切り替えを出さず、文字入力中なら音声に戻す（マイク拒否時を除く）。マイク・終了は 76pt、スピーカーは 64pt。
- **ミニ**（`.mini`）：見出しの「最小化」（下向き矢印）で会話を続けたまま全画面を閉じると、すべてのタブの上（右下・タブバーの上）に 88pt のミニアバターを表示します。タップで全画面に戻る、× で会話を終了、下に「マイク使用中」（赤い点）/「マイクはオフ」/「接続中…」/「接続エラー」を常に表示。ドラッグで上下に動かせ、左右は近い端に吸着します（VoiceOver では「反対側へ移動」操作）。表示中はホームの「音声で話す」を隠します。読み上げは「Happy AI、回答中。タップで音声画面を開く」のように状態を含めます。
- 画面が閉じられただけでは会話を終了しません。終了するのは ✕・「音声会話を終了」・ミニアバターの ×・バックグラウンド移行・無操作・最大時間・電話などの割り込みです。
- 「視差効果を減らす」がオンなら、揺れ・まばたきを止め、口の開閉だけを反映します。

### Rive などに置き換える

`HappyAvatarController` と `HappyVoiceAvatarBridge`（と `AvatarCue`）はそのまま使い、`HappyAvatarView` だけを差し替えます。Rive の State Machine の入力に、`state`（数値化）・`emotion.rawValue`・`mouthLevel`（0〜1）・`eyeOpen`・`lookX`/`lookY` を渡してください。アプリ側は `HappyAvatarView(controller:mode:)` の呼び出し 2 か所（`VoiceConversationView`・`VoiceMiniAvatarView`）を置き換えるだけです。

### テスト

- `swift test --package-path apps/ios/HappyDriveCore`（`AvatarCueTests`）：全状態の遷移 → 出来事、同じ状態では出さない、実際の会話の流れ（接続 → 発話 → 回答 → 割り込み → 再接続 → 終了）、dB 変換（境界・単調・NaN）、取得間隔（回答中のみ 30Hz・60Hz 以下）、ツール結果の案件判定（実際の出力形式・空・エラー・他のツール）、目的地接近（200m 境界・1 回だけ・en_route のみ・運行中のみ・位置なし・リセット）。
- `HappyAvatarKit` のテスト（CI の ios-app ジョブで `xcodebuild test -scheme HappyAvatarKit`、iOS シミュレータ）：ブリッジの全イベント、音量のノイズフロア・平滑化・範囲外/NaN、割り込みで口がすぐ閉じる（遅れて届いた音量でも開かない）、業務イベントの感情（全件）、`connectionRecovered` で喜ぶ、リセット。Linux でも `swift test -Xlinker --allow-shlib-undefined`（Swift 6.1 の Linux 版 libswiftObservation のリンク不具合の回避）で実行できます。

### 実機での確認手順（未実施）

> **口の動きと声の合い方、ナビ中のミニアバター、運転中モードは iPhone 実機でしか確認できません。この実装では実機での確認を一度も行っていません**（シミュレータでも未確認。CI ではビルドとキットの単体テストのみ）。

1. 回答中、口の開閉が声とずれない・遅れない（スピーカー / AirPods / 車の Bluetooth）。無音で口が閉じる
2. 回答中に話しかけると、音声が止まると同時に口が閉じる（連続で何度か）
3. 考え中・再接続中・エラー・回復時の表情と、「視差効果を減らす」オンで揺れが止まること
4. 「最小化」→ 配送タブの地図・ホーム・案件の上でミニアバターが操作の邪魔にならない。ドラッグ・端への吸着・タップで戻る・× で終了（コントロールセンターのマイク表示が消えること）
5. ミニアバター表示中もマイク使用中の表示が常に見えること。ミュートで「マイクはオフ」に変わること
6. 運転中（配送のルート開始後、約10km/h 超）に音声画面が状態の文字だけ・大きいボタンになること
7. 近くの案件の検索・受諾・配達完了・ルート再計算・目的地 200m 手前・圏外で表情が変わること
8. 最大の文字サイズ・VoiceOver（ミニアバターのラベル・「反対側へ移動」）・ダークモード
9. 開始・最小化・再表示・終了を繰り返して、メモリが増え続けない・まばたきが止まらない/二重にならないこと

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


## ログイン方式（2026-09-26 変更）
電話番号の確認（SMS）は行いません。初回起動時に端末で256bitの乱数を生成してキーチェーンに保存し、`POST /v1/auth/device` でこの端末のアカウントに自動でサインインしてメイン画面を開きます（`SessionStore.signInWithDevice`、`DeviceCredential`）。登録・本人確認はマイページと案件の受諾時に案内され、受諾には従来どおり本人確認が必要です。退会すると端末の秘密値も消去され、次回起動時は新しいアカウントになります。アプリを削除・機種変更すると元のアカウントには戻れません（引き継ぎ機能は未実装）。
