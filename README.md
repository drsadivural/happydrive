# HappyDrive（Happyアプリ）

配送効率化（配達先登録・ルート・完了報告）と地域の有償業務（Happy案件）をひとつにした、日本国内向けのドライバー／地域サポーター用プラットフォームです。

- `apps/ios` — ドライバー用 iPhone アプリ（SwiftUI / iOS 17+）。非UIロジックは Swift Package `HappyDriveCore`（Linux でもビルド・テスト可能）
- `apps/partner-web` — 発注企業・自治体用 Web（Next.js、BFF でトークンを httpOnly Cookie に保持）
- `apps/admin-web` — 運営用 Web（審査・紛争・振込・照合・監査・分析）
- `services/api` — API（Node.js / TypeScript / Fastify、PostgreSQL 16 + PostGIS、Redis 任意）と Worker
- `packages/contracts` — **API 契約（OpenAPI 3.1）が唯一の起点**。API のルートと入力検証はここから生成、TS 型も生成
- `packages/design-tokens` — 色・角丸・余白（CSS / TS / Swift を生成）
- `packages/web-ui` — Web 共通部品（BFF、CSRF、JST 変換など）
- `docs/` — 仕様原本（`docs/spec/`）、要件トレーサビリティ、事業判断待ち事項、運用 Runbook、保管ポリシー、試験結果
- `infra/`, `.github/workflows/` — ローカル用 compose、CI

## 現在の状態（2026-09-26）

| 領域 | 状態 | 根拠 |
|---|---|---|
| API / DB | 実装済み。P0 受け入れ項目の自動試験が合格 | `docs/TEST_RESULTS.md`（61件、契約適合の自動検証を含む） |
| 企業 Web / 運営 Web | 実装済み。lint・型・単体試験・本番ビルド合格、実APIとの結合確認 | 各 `apps/*/README.md` |
| iOS | Xcode ビルド成功（CI の macOS ランナー）。コア部の単体試験67件合格。Debug の接続先は公開ステージング `https://happydrive-api.ayonix.com/v1` | `apps/ios/README.md`, `apps/ios/TEST_RESULTS.md` |
| iOS 実機試験・UIテスト・TestFlight・App Store 提出 | **未実施** | `docs/spec/APPLE_RELEASE.md` の手順で実施が必要 |
| 外部契約が必要な機能（SMS、振込、道路所要時間、eKYC、APNs） | 事業者未定のため本番構成では**無効**（fail closed）。開発用アダプタは本番で起動拒否 | `docs/DECISIONS_REQUIRED.md` |

「動いた」と言えるのは試験記録のある範囲のみです。未実施の試験は `docs/TEST_RESULTS.md` に明記しています。

## クイックスタート（開発）

前提: Node.js 22+（24 推奨）、pnpm 11、PostgreSQL 16+ と PostGIS（または Docker）。

```bash
pnpm install
```

```bash
docker compose -f infra/docker/docker-compose.yml up -d db redis
```

```bash
cp .env.example .env
```

```bash
pnpm --filter @happydrive/api migrate
```

```bash
NODE_ENV=development pnpm --filter @happydrive/api seed:dev
```

```bash
pnpm --filter @happydrive/api dev
```

```bash
pnpm --filter @happydrive/api dev:worker
```

```bash
HD_API_BASE_URL=http://localhost:8080/v1 pnpm --filter @happydrive/partner-web dev
```

```bash
HD_API_BASE_URL=http://localhost:8080/v1 pnpm --filter @happydrive/admin-web dev
```

`seed:dev` が表示する開発用アカウント（運営／企業の TOTP シークレット）で Web にログインできます。ドライバーアプリは電話番号確認なしで、起動時に端末のアカウントへ自動でサインインします（docs/DECISIONS_REQUIRED.md D-19）。iOS は `apps/ios/README.md` を参照してください。

## 試験

```bash
pnpm --filter @happydrive/api test
```

```bash
pnpm -r --if-present test
```

```bash
swift test --package-path apps/ios/HappyDriveCore
```

API の試験は実際の PostgreSQL/PostGIS（`TEST_DATABASE_URL`、既定 `localhost:5433/happydrive_test`）を使います。すべての応答は `packages/contracts/openapi.yaml` に照らして自動検証されます。

## 設計の要点
- **契約駆動**: `openapi.yaml` の operationId ごとにハンドラを登録し、未実装の操作があると API は起動しません。
- **整合性**: 受諾は案件行ロック＋部分一意インデックス＋冪等キー（同一キーの再送は同じ応答）。100 並列で最後の1枠に1件のみ成功することを試験済み。
- **監査**: すべての状態変更を追記専用・ハッシュ連鎖の `domain_events` に記録（改ざんを検出）。報酬台帳も追記専用、取消は逆仕訳。
- **プライバシー**: PII は AES-256-GCM で暗号化、照合は HMAC。位置は業務中のみ・発注者には最新1点のみ。証跡画像は EXIF/GPS を除去。ログに電話・住所・トークン・座標を出さない。
- **マッチング**: 資格・時間重複・距離・停止などのハード条件で除外し、残りを説明可能なスコアで順位付け（理由を表示）。評価で自動排除しない。運営が重み・除外理由・偏りを監査できる。
- **ルート最適化**: 時間枠・優先度・作業時間・休憩を考慮するヒューリスティック。道路所要時間の事業者と未契約のため**概算**と明示し、最適解を保証しない。

## ドキュメント
- 要件→画面→API→試験: `docs/TRACEABILITY.md`
- 事業判断が必要な事項: `docs/DECISIONS_REQUIRED.md`
- 運用: `docs/RUNBOOK.md` / 保管期間: `docs/DATA_RETENTION.md` / 初期データ移行: `docs/DATA_MIGRATION.md`
- 契約の変更履歴: `docs/CONTRACT_CHANGELOG.md`
- 試験結果: `docs/TEST_RESULTS.md`
- 仕様原本（提供パッケージ）: `docs/spec/`、画面モック: `docs/mockups/`、ブランド参照: `assets/brand/`
