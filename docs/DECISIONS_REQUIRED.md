# 事業判断が必要な事項（DECISIONS_REQUIRED）

実装では「未確定の事項は本番で閉じる（fail closed）」を原則にしています。下表の各項目は、決定・契約が揃うまで本番構成で機能が無効になるか、安全側の既定値で動作します。決定したら担当者・日付・根拠を追記し、対応する設定/コードを変更してください。

| ID | 事項 | 現在の実装（本番での挙動） | 決定後の作業 | 関連 |
|---|---|---|---|---|
| D-01 | 契約主体（運営会社）・発注者との契約形態・利用規約/プライバシーポリシー本文 | 規約バージョンは `TERMS_VERSION` / `PRIVACY_VERSION`。本文URLは未設定。同意は版ごとに記録 | 本文公開URLをiOS/Webに設定、版を更新すると全利用者に再同意を要求 | `POST /me/terms` |
| D-02 | 雇用/業務委託の区分と、雇用案件の給与支払（源泉徴収・社会保険・労働条件通知） | 「その他（法務審査中）」は公開不可。雇用案件は労働条件の明示と最低賃金チェックを必須化。**雇用の賃金は自動振込の対象外**（照合画面に「給与計算が必要」と表示） | 給与計算の方法（給与システム連携/委託先）を決定し、雇用分の支払経路を実装 | `publishChecks`, `adminReconciliation` |
| D-03 | 最低賃金の判定基準（都道府県別・毎年10月改定） | `MIN_HOURLY_WAGE_YEN`（既定 1,300円、全国一律の安全側）で時給換算を判定 | 就業場所の都道府県別テーブルに置換し、改定時の更新手順を運用に追加 | `publishChecks.minimum_wage` |
| D-04 | 振込（決済）事業者の選定・契約 | `PAYOUT_PROVIDER=none` の本番では振込機能は 503（画面に未契約と表示）。台帳・照合・Webhook検証・二重振込防止は実装済み（サンドボックスで試験） | 事業者のAPIに合わせ `PayoutProvider` アダプタを追加（createTransfer/getTransfer/verifyWebhook） | `services/api/src/adapters/payouts.ts` |
| D-05 | SMS（電話番号確認）事業者 | 本番は `SMS_PROVIDER=none` → OTP送信不可（審査用アカウントのみログイン可）。開発は `console` | 事業者の契約後に `SmsAdapter` 実装を追加。送信元表示・料金上限・障害時の手順を決定 | `adapters/sms.ts` |
| D-06 | 本人確認（KYC）の方式 | 書類画像の提出＋運営による目視審査（`admin_operator`）。eKYC SDKは未接続 | eKYC事業者を採用する場合はサーバー側アダプタで結果を受け取り、運営審査を補助 | `/me/verification`, `/admin/users/{id}/verification` |
| D-07 | 手数料（ドライバー側 `WORKER_FEE_PERCENT` / 発注者側 `PLATFORM_FEE_PERCENT`）と消費税・インボイス対応 | いずれも 0%。受諾時のスナップショットと請求明細に反映される設計 | 料率・税区分・適格請求書の記載事項を決定し、請求書PDF出力を追加 | `termsSnapshot`, `listInvoices` |
| D-08 | 振込スケジュール | 「検収後3日以上経過した最初の15日または月末」を**予定日**として表示（即時払いの表現はしない） | 事業者契約・資金繰りに合わせて変更（`nextPayoutDate`） | `lib/time.ts` |
| D-09 | 講習（学ぶ）教材の監修 | 生活支援・見守り・個人情報・安全運転の基礎講習（医療/介護行為を含まない）を実装。合格で講習由来資格を付与 | 教材の監修者・改訂周期・有効期限を決定。必要なら動画等を追加 | `modules/learning.ts` |
| D-10 | 身体介護・医療関連の案件（`personal_care` / `healthcare`） | **作成も公開も不可**（`restrictedCategoriesEnabled=false` を固定値で保持） | 必要資格・事業許認可・保険を確定後、設定を環境変数化して段階的に解放 | `config.ts`, `publishChecks` |
| D-11 | 地図/経路の道路所要時間プロバイダ（ZENRIN、他） | 直線距離×道路係数の**概算**（`travelTimeSource=estimated`）で最適化し、画面に概算と明示。最適解保証の表示はしない | 契約した行列APIを `TravelTimeProvider` として追加（上限・タイムアウト・サーキットブレーカー付き） | `routing/optimizer.ts` |
| D-12 | 提携先（LocationMind、ZENRIN、Ayonix、OTERA 等）のロゴ・連携の表示 | 製品内に提携先ロゴ・連携表示は一切なし | 正式な許諾と契約後に個別追加 | docs/spec/PRODUCT.md §8 |
| D-13 | HappyDrive ロゴの正式マスター（ベクター）と利用許諾 | 提供画像からの切り出し参照（開発ビルド用）を使用 | 権利者提供マスターから 1024px 非透過アイコンとワードマークを再作成 | `assets/brand/`, `apps/ios/.../AppIcon` |
| D-14 | 証跡・個人情報の保管期間 | docs/DATA_RETENTION.md の既定値 | 法務確認のうえ期間を確定し、環境変数/定数を更新 | `RETENTION_DAYS` 等 |
| D-15 | Apple Developer（法人）アカウント、Bundle ID、APNs鍵、審査用アカウント | 未取得。APNs未設定時はアプリ内通知のみ | 取得後に `APNS_*`、`REVIEW_ACCOUNT_*` を設定し TestFlight へ | docs/spec/APPLE_RELEASE.md |
| D-16 | 本番インフラ（日本リージョンのマネージドDB/オブジェクトストレージ、Cloudflare等） | Dockerfile / CI / docker-compose（開発）まで。IaCは未作成 | 事業者比較後に IaC（Terraform等）を追加。バックアップ/復旧演習を実施 | docs/RUNBOOK.md |
| D-17 | 案件公開時の新着通知の配信範囲 | 空き待ち登録者への通知のみ（一斉配信はしない） | 配信対象（希望カテゴリ・距離）と頻度上限を決めて実装 | `releaseSlot` |
| D-19 | ドライバーのログイン方式（**2026-09-26 依頼者判断: 電話番号確認を廃止**） | 端末アカウント（キーチェーンの乱数でサインイン、`POST /auth/device`）。起動後すぐメイン画面。受諾には本人確認が必要。新規作成は IP 単位で1時間20件まで | 1人が複数アカウントを作れる・連絡手段がない・機種変更で引き継げない点の対策（本人確認書類の重複検知、連絡先登録、引き継ぎコード等）を決定 | `modules/auth.ts deviceLogin`, iOS `SessionStore` |
| D-18 | 退会後の再登録制限期間 | 電話番号の照合用ハッシュを30日保持し、その間は再登録不可 | 不正対策と個人情報保護のバランスで期間を確定 | `deleted_identities` |
