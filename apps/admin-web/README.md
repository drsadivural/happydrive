# HappyDrive 運営管理（apps/admin-web）

運営・サポート・監査担当が、利用者/組織/案件の審査、業務監視と紛争裁定、通報・問い合わせ、振込・決済照合、監査ログ、マッチング監査、削除要求の確認を行う Next.js（App Router, TypeScript strict）アプリです。

## セットアップ

```bash
pnpm install                                   # リポジトリのルートで
cp apps/admin-web/.env.example apps/admin-web/.env.local
pnpm --filter @happydrive/admin-web dev        # http://localhost:3002
```

スクリプト: `dev`（3002）/ `build` / `start`（3002）/ `lint` / `typecheck`（`next typegen && tsc --noEmit`）/ `test`（Vitest）。

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `HD_API_BASE_URL` | `http://localhost:8080/v1` | API のベースURL（BFF のサーバー側のみ） |
| `HD_EVIDENCE_IMAGE_ORIGINS` | なし | 本人確認書類・証跡画像の署名URLの配信元（CSP `img-src`） |
| `HD_COOKIE_SECURE` | 本番で `true` | Cookie の Secure 属性（http 検証環境のみ `false`） |

## 認証・権限

- 企業ポータルと同じ BFF 方式（`@happydrive/web-ui` の共通実装）。トークンは httpOnly・SameSite=Strict・（本番）Secure の Cookie（接頭辞 `hda_`、企業ポータルとは別）にのみ保存します。新規登録はありません。
- MFA 確認時に `roles` が `admin_operator` / `admin_support` / `admin_auditor` のいずれも含まない場合は **セッションを発行せず**、発行済みトークンを `POST /auth/logout` で失効させて 403 を返します。画面側でも `/me` のロールを確認し、権限が無ければ「権限がありません」を表示します。
- `admin_auditor` のみの利用者は閲覧専用（変更ボタンを表示しない。API 側でも拒否される前提）。
- プロキシの許可リスト（`lib/allowlist.ts`）は運営画面で使う `/admin/*`・`/me`・`/assignments/{id}`（参照）・`/evidence/{id}/url` 等のみ。企業・ドライバー向けの変更系は中継しません。
- CSRF・Idempotency-Key・リフレッシュ・セキュリティヘッダーは企業ポータルの README を参照。

## 機能

- **ダッシュボード**: `/admin/analytics`（期間指定、JST の日付）
- **利用者審査**: 本人確認状態で絞り込み・検索、詳細（本人情報は住所・生年月日・郵便番号を既定でマスクし「表示」で確認、車両ナンバーはマスク、口座は API のマスク値）、本人確認書類・資格証の画像を署名URLで都度表示、本人確認の承認/却下（理由必須）、利用停止/解除（理由必須）、資格の確認（有効期限）/却下
- **組織審査**: 承認/却下/停止（理由必須・確認ダイアログ）
- **案件審査**: 審査待ちキュー、公開前チェックと全条件の表示、公開/却下/違反取消（理由必須）
- **業務監視・紛争**: 状態別一覧、詳細（経過・証跡・受諾時スナップショット）、紛争裁定（満額/一部（金額）/支払なし）、報酬の取消（逆仕訳）、ドライバーIDへの再割当
- **通報**: 対応内容（対応不要/非表示/対象停止/案件取消）と理由で対応済みに
- **問い合わせ**: 回答・完了、マッチング異議申立ての絞り込み
- **振込**: 状態別一覧、締め日指定の振込バッチ作成（決済事業者未契約時の 503 は API のメッセージを表示）、失敗分の再試行
- **決済照合**: 月次の各合計と差異一覧
- **監査ログ**: 対象の種類/ID/件数で絞り込み、ハッシュ連鎖の検証
- **マッチング監査**: 重みの編集（理由必須・変更前後の確認ダイアログ、監査記録）、除外理由の分布・上位10%集中度・受諾率
- **削除要求**: 一覧（保持の説明・削除を妨げる要因）

すべての変更操作は確認ダイアログを経由し、契約で `reason` が必須の操作は理由未入力で確定できません。

## テスト

- `test/allowlist.test.ts`: 運営プロキシの許可リスト、ロール判定（監査は閲覧専用）
- `test/admin-forms.test.ts`: 紛争裁定の金額、取消額、再割当先 UUID、マッチング重み、月、異議申立ての判定
- `test/mask.test.ts`: 画面マスク
- 共通ロジックは `packages/web-ui/test`。

## 実施した確認（2026-09-26）

### 静的検査・単体テスト
```bash
pnpm --filter @happydrive/admin-web lint       # 0 problems
pnpm --filter @happydrive/admin-web typecheck  # OK（契約 v1.1 更新後の生成型で）
pnpm --filter @happydrive/admin-web test       # 3 files / 14 tests passed
pnpm --filter @happydrive/admin-web build      # OK
```

### 実 API との結合（http://localhost:8088/v1、開発シード）
```bash
HD_API_BASE_URL=http://localhost:8088/v1 HD_COOKIE_SECURE=false npx next start -p 3912
```

| 画面・操作 | 結果 |
|---|---|
| admin@happydrive.local ログイン + TOTP | 成功 |
| 案件審査（審査待ち） | 企業ポータルで申請した「WEB結合試験 見守り訪問」が一覧に表示。**詳細パネルの `GET /admin/jobs/{jobId}` は 404**（稼働中の API プロセスが新エンドポイント追加前に起動していたため。API 再起動後に再確認が必要）。公開は BFF 経由の `POST /admin/jobs/{id}/review {decision: published}` で実行し 200・「募集中」になることを確認（`docs/screenshots/web/admin-job-review.png` は詳細 404 の状態） |
| 利用者審査（すべて）・利用者詳細 | 一覧・詳細（マスク表示）ともに表示 |
| 監査ログ → ハッシュ連鎖を検証 | 「改ざんは検出されませんでした（403件）」、イベント100件表示 |
| 決済照合（2026年8月） | 各合計 ¥0・差異なし |
| 振込バッチ作成（締め日 2026/09/26） | 成功「0件・合計 ¥0」（サンドボックス事業者） |
| ダッシュボード / マッチング監査 / 組織審査 / 業務監視 / 問い合わせ / 通報 / 削除要求 | すべて実データで表示（空の一覧は空表示） |
