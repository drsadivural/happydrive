# HappyDrive 企業・自治体ポータル（apps/partner-web）

発注企業・自治体の担当者が、組織登録・拠点・案件の作成/審査申請/取消・応募の承認・実施の監視・検収・請求明細・メッセージを行う Next.js（App Router, TypeScript strict）アプリです。API 契約は `packages/contracts/openapi.yaml`（v1.1）で、型は `@happydrive/contracts` の生成型を `openapi-fetch` で利用します。

## セットアップ

```bash
# リポジトリのルートで
pnpm install
cp apps/partner-web/.env.example apps/partner-web/.env.local   # 必要に応じて編集
pnpm --filter @happydrive/partner-web dev     # http://localhost:3001
```

| スクリプト | 内容 |
|---|---|
| `dev` | 開発サーバー（ポート 3001） |
| `build` / `start` | 本番ビルド / 起動（ポート 3001） |
| `lint` | ESLint（eslint-config-next core-web-vitals + typescript） |
| `typecheck` | `next typegen && tsc --noEmit` |
| `test` | Vitest（単体テスト） |

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `HD_API_BASE_URL` | `http://localhost:8080/v1` | API のベースURL。BFF（サーバー側）からのみ使用し、ブラウザには出ません |
| `HD_EVIDENCE_IMAGE_ORIGINS` | なし | 証跡画像の署名URLの配信元（カンマ区切り）。CSP の `img-src` に追加。API と同一オリジンなら不要 |
| `HD_COOKIE_SECURE` | `NODE_ENV=production` で `true` | Cookie の Secure 属性。http の検証環境でのみ `false` にする（`upgrade-insecure-requests`・HSTS も連動して外れます） |

## 認証・セキュリティ設計（BFF）

- ログイン: `POST /api/auth/login`（→ API `POST /auth/web/login`）→ MFA チャレンジ。`mfaToken` は httpOnly Cookie（5分）に保存し、ブラウザには `mfaEnrollmentRequired` と（初回のみ）`totpUri` だけを返します。初回は `qrcode` で QR と手入力用キーを表示します。
- 新規登録: `POST /api/auth/signup`（→ `POST /auth/web/signup`）→ 同じ MFA 登録フロー → 組織登録（オンボーディング）へ。
- MFA 確認: `POST /api/auth/mfa`（→ `POST /auth/web/mfa/verify`）。アクセス/リフレッシュトークンは **httpOnly・SameSite=Strict・（本番）Secure・`__Host-` 接頭辞** の Cookie にのみ保存し、レスポンスボディには含めません。
- API 呼び出しはすべて同一オリジンのプロキシ `app/api/hd/[...path]/route.ts` 経由。
  - パス許可リスト（`lib/allowlist.ts`）。`/admin/*`・認証系・ドライバー専用 API は中継しません。パスは `..`・エンコード済み `/` などを拒否して正規化します。
  - Bearer を付与し、401 なら `POST /auth/refresh` でローテーションして **1回だけ** 再送。同一プロセス内では同じリフレッシュトークンの更新を1回にまとめ（並行リクエストによる再利用検知・全失効を防止）、直後30秒は同じ結果を返します。複数インスタンス運用ではスティッキーセッションか共有ストアが必要です。
  - 変更系は CSRF 対策（ダブルサブミット Cookie `hdp_csrf` とヘッダー `x-hd-csrf` の定数時間比較 + Origin / Sec-Fetch-Site 検査）。
  - `Idempotency-Key` を転送。利用者の1回の送信ごとに `prefix-UUID` を生成し、結果不明の失敗（通信断・5xx・429）後の同一内容の再送では同じキーを再利用します（`useMutation`）。
  - 上流の Set-Cookie 等は転送せず、`cache-control: no-store`。API に接続できない場合は 502/503/504 と日本語メッセージ（偽の成功は返しません）。
- `proxy.ts`（Next 16 の旧 middleware）: リフレッシュトークン Cookie が無い保護ページは `/login?next=...` へリダイレクト（open redirect 対策済み）、CSRF Cookie を発行。
- セキュリティヘッダー（`next.config.ts`）: CSP（本番は `unsafe-eval` なし、`frame-ancestors 'none'`、`object-src 'none'`）、`Referrer-Policy: same-origin`、`X-Frame-Options: DENY`、`nosniff`、`Permissions-Policy`、HSTS（https 時）。Next のハイドレーション用インラインスクリプトのため `script-src` に `'unsafe-inline'` が残ります（nonce 方式は既知の改善点）。

## 機能

- **組織登録・審査状況**（`/onboarding`）: `POST /organizations`。審査中/却下/停止の理由を表示し、未承認の間は審査申請ボタンを無効化（API も拒否）。複数組織は右上で切替。
- **ダッシュボード**（`/dashboard`）: モックアップ準拠（公開中の案件・本日の稼働・検収待ち、進行状況の色付きピル）。
- **拠点**（`/sites`）: CRUD。有料ジオコーダーは使わず、緯度・経度の手入力／「35.44, 139.64」形式の貼り付け／住所を外部地図で開くリンク／入力座標の確認リンク（日本国外なら警告）。
- **案件管理**（`/jobs`）: 状態別一覧、NewJob の全項目の作成・編集（draft/rejected のみ）、身体介護・医療関連は選択不可（理由表示）、契約区分の説明（その他は公開不可・雇用は労働条件必須・業務委託は支払条件必須）、手順エディタ（追加/削除/並べ替え）、キャンセル規定、支払条件、拠点選択で住所/位置/地域名を自動入力、`publishChecks` 表示、審査申請、理由付き取消、複製（既存案件をフォームに複製 → 新規作成）。日時入力は JST として UTC ISO に変換。
- **応募・マッチング**（`/matching`）: 案件別の応募・割当、空き待ち人数、予約（reserved）の承認/却下（`/assignments/{id}/reservation`）、ドライバーは表示名と評価のみ。30秒ごとに自動更新。
- **実施・検収**（`/assignments`）: 状態別一覧と詳細（経過・手順・証跡サムネイル（「画像を表示」で `/evidence/{id}/url` の署名URLを都度取得）・業務中のみ最新位置1点を30秒ごとに取得し業務外では停止・承認/差戻し（理由必須）/紛争・開始30分後からの無断欠勤報告・検収後の評価）。
- **請求・支払**（`/billing`）: 月次明細、CSV をブラウザで生成（UTF-8 BOM、数式インジェクション対策）。
- **メッセージ**（`/messages`）: 割当ごとのチャット（10秒ごとに `after` で差分取得）、メッセージの通報（`/reports`）。
- **組織・設定**（`/settings`）: 組織情報の編集（再審査の警告と確認ダイアログ）、メンバー追加（メール + 権限）・削除。
- 共通: 読込/空/失敗/再試行の表示、409/422 は API の `message` を表示、JST 表示（`Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo' })`）、円表示、幅 900px 以下でサイドバーがメニューに折りたたみ、ライト/ダーク（design-tokens）。アプリ内にモックデータはありません。

## テスト（Vitest）

- `test/job-form.test.ts`: NewJob 検証（必須・文字数・金額/人数・日時・要資格カテゴリ・契約区分ごとの必須項目・手順・範囲）と JST→UTC 変換、編集/複製の往復
- `test/allowlist.test.ts`: 企業ポータルのプロキシ許可リスト（`/admin/*` を中継しない等）
- `test/geo.test.ts`: 座標の貼り付け解釈・拠点の検証
- `test/assignment-rules.test.ts`: 無断欠勤（開始+30分）・検収・評価の可否
- `test/invoice-csv.test.ts`, `test/chat.test.ts`
- プロキシ/CSRF/リフレッシュ/JST/円/状態ラベルは `packages/web-ui/test` にあります。

## 実施した確認（2026-09-26）

### 静的検査・単体テスト
```bash
pnpm --filter @happydrive/partner-web lint       # 0 problems
pnpm --filter @happydrive/partner-web typecheck  # OK（契約 v1.1 更新後の生成型で）
pnpm --filter @happydrive/partner-web test       # 6 files / 27 tests passed
pnpm --filter @happydrive/partner-web build      # OK
```

### 実 API との結合（HappyDrive API http://localhost:8088/v1、開発シード）
```bash
pnpm --filter @happydrive/partner-web build
HD_API_BASE_URL=http://localhost:8088/v1 HD_COOKIE_SECURE=false npx next start -p 3911
```
Playwright（Chromium）で操作。TOTP は `otpauth` で生成。

| 手順 | 結果 |
|---|---|
| partner@happydrive.local でログイン → TOTP 入力 | 成功。httpOnly Cookie のセッションでダッシュボードへ遷移 |
| ダッシュボード | シードの公開案件4件（高齢者の見守り訪問・道路状況の撮影・書類の回収・買い物付き添い）と統計を表示（`docs/screenshots/web/partner-dashboard.png`） |
| 案件作成フォーム（拠点選択で住所/位置/地域名を自動入力、業務委託、報酬「3,000」） | 下書き作成成功（`POST /organizations/{id}/jobs`、Idempotency-Key 付き）→ 詳細で publishChecks 13項目すべて OK を表示（`docs/screenshots/web/partner-job-publish-checks.png`） |
| 審査を申請 | `POST .../submit` 成功、状態が「審査中」に |
| 運営Web で公開後 | 状態「募集中」 |

注意: 最初のログイン試行で API のレート制限（`x-ratelimit-limit: 300`、IP 単位）により 429 となり、画面にはエラーを表示（偽の成功なし）。BFF 経由の通信はすべて同一 IP になるため、本番では API 側で `X-Forwarded-For` の信頼設定が必要です。
