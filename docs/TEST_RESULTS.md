# 試験結果記録

- 実施日時: 2026-09-26（JST）/ 2026-09-25T23:36Z
- ビルドSHA: `b10abb7`（GitHub Actions CI 全6ジョブ合格: contracts / api / web / ios-core / ios-app / security）
- 環境: Ubuntu 26.04 x86_64、Node.js 24.21、pnpm 11.16、PostgreSQL 18 + PostGIS 3.6（ローカル）、Redis 7（ローカル, :6380）、Swift 6.1.3（Linux）
- 実施者: Claude Code（自動試験）。人による実機確認は未実施。

## 実施した試験と結果
| 対象 | コマンド | 結果 |
|---|---|---|
| API契約 | `pnpm --filter @happydrive/contracts lint` / `check-generated` | 合格（Redocly エラー0、生成型が最新） |
| API | `pnpm --filter @happydrive/api lint` / `typecheck` / `build` | 合格 |
| API 結合試験（実 PostgreSQL/PostGIS） | `pnpm --filter @happydrive/api test` | **65件 合格 / 失敗0**（9ファイル、端末ログイン4件を含む）。全応答を OpenAPI 契約で自動検証 |
| web-ui | lint / typecheck / test | 合格、69件 |
| partner-web | lint / typecheck / test / `next build` | 合格、27件 |
| admin-web | lint / typecheck / test / `next build` | 合格、14件 |
| iOS コア（HappyDriveCore） | `swift test --package-path apps/ios/HappyDriveCore` | **67件 合格 / 失敗0** |
| iOS アプリ（SwiftUI） | CI `ios-app`: `xcodebuild ... -destination 'iPhone 16' build`（macOS 15 ランナー） | **BUILD SUCCEEDED**（警告はSwift 6モードの並行性警告のみ）。シミュレータでの起動・UIテストは未実施 |
| 公開ステージング | `https://happydrive-api.ayonix.com/v1` に端末ログイン→ホーム→規約同意 | 合格（iOS Debug の接続先） |
| Docker イメージ | `docker build -f services/api/Dockerfile .` → 起動 → `/v1/readyz` | 合格。本番設定で必須設定なしでは起動拒否を確認 |
| 実 API 結合（Web） | 本番ビルドの partner/admin を実 API（:8088）に接続し Playwright で操作 | 企業: ログイン+MFA→ダッシュボード→案件作成→公開前チェック13項目→申請。運営: 審査→公開、監査連鎖検証、照合、振込バッチ等。不整合なし（`docs/screenshots/web/`） |
| 実 API スモーク（HTTP） | OTP ログイン → `/home` | 合格（推薦理由付きで近隣案件、資格不足の案件は除外） |
| 性能（開発機、`scripts/loadtest.ts`、200人/同一案件） | c=20 / c=50 | 検索 p95 169ms / 135ms、ホーム p95 117ms / 132ms、**受諾 p95 375ms / 353ms**（目標 読取<500ms・受諾<1s）。200枠ちょうど充足 |
| コードレビュー（独立エージェント） | API の認可・台帳・並行性・プライバシー | 確度の高い欠陥なし |

## 受け入れ項目との対応
`docs/TRACEABILITY.md` の表を参照。P0 のうち ID-01, ID-02, DEL-01〜03, JOB-01〜05, PAY-01/02, PRI-01/02, SEC-01/02 はサーバー側の自動試験で合格。

## 未実施（完了と主張しない項目）
- iOS アプリのシミュレータ／実機での動作確認と UI テスト（ビルドは CI で成功済み）。
- 実機での GPS・省電力・圏外・VoiceOver・Dynamic Type 最大・ダークモード確認（UI-01〜03 の iOS 部分）。
- TestFlight・App Store 提出（APP-01）。Apple Developer アカウント・署名・APNs 鍵が必要。`aps-environment` はリリース署名で production にすること。
- 実際の SMS 事業者・振込事業者・道路所要時間 API・eKYC との接続（未契約。docs/DECISIONS_REQUIRED.md）。振込はサンドボックス事業者でのみ試験。
- 本番基盤での監視・バックアップ復旧演習（OPS-01 の一部）。
- 管理画面一覧のページング（現在は最大200〜300件）。
