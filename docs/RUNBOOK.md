# 運用 Runbook

## 構成
| プロセス | コマンド | 役割 |
|---|---|---|
| API | `node dist/main.js`（`services/api`） | HTTPS API（`/v1`）。契約から生成したルートと入力検証 |
| Worker | `node dist/worker.js` | 通知配信（outbox→APNs）、予約期限切れ、案件の締切/完了、振込の再確認、保管期間の削除 |
| PostgreSQL 16 + PostGIS | マネージドDB（日本リージョン推奨） | 業務データ・台帳・監査 |
| Redis | 任意 | API の IP レート制限の共有ストア（未設定時はプロセス内） |
| オブジェクトストレージ | S3互換（SSE 有効） | 証跡・書類画像 |
| partner-web / admin-web | Next.js | BFF（トークンはhttpOnly Cookie） |

API と Worker は同じイメージ（`services/api/Dockerfile`）。水平スケール可能（Worker のタスクは SKIP LOCKED / 集合更新で重複実行に耐える）。

## 公開ステージング（iPhone 実機の接続先）
- URL: `https://happydrive-api.ayonix.com/v1`（iOS の Debug ビルドの接続先。`apps/ios/Config/Debug.xcconfig`）
- 構成: Cloudflare Tunnel `happydrive-api`（`/etc/cloudflared/happydrive-api.yml`、systemd `cloudflared-happydrive-api`）→ API `127.0.0.1:8090`（systemd `happydrive-api` / `happydrive-worker`、`EnvironmentFile=/etc/happydrive/api.env`、root のみ読取可）→ DB `happydrive_public`
- 秘密値（JWT・暗号鍵）は構築時に生成した専用の値。開発用シード（公開リポジトリに既知のパスワード）は投入しない。
- 運営アカウント作成: `sudo bash -c 'set -a; . /etc/happydrive/api.env; set +a; cd /home/ubuntu/happydrive/services/api && sudo -u ubuntu --preserve-env=NODE_ENV,DATABASE_URL,DATA_ENCRYPTION_KEY,DATA_HMAC_KEY,JWT_SECRET node --import tsx scripts/create-admin.ts --email you@example.com --name 運営 --role admin_operator'`
- 更新手順: `git pull` → `pnpm --filter @happydrive/api build` → `sudo systemctl restart happydrive-api happydrive-worker`（マイグレーションは `node dist/db/migrate-cli.js` を同じ環境変数で実行）
- 音声アシスタント: `sudo sh -c 'echo OPENAI_API_KEY=sk-... >> /etc/happydrive/api.env'` → `sudo systemctl restart happydrive-api`（キーはこのファイルだけに置く。ログ・Git に出さない）
- 状態確認: `curl https://happydrive-api.ayonix.com/v1/readyz`、`journalctl -u happydrive-api -f`

## 初回構築
1. シークレットを生成して登録: `JWT_SECRET`（32文字以上）、`DATA_ENCRYPTION_KEY` / `DATA_HMAC_KEY`（`openssl rand -base64 32`）。**暗号鍵の紛失はデータ喪失**。鍵管理サービスに保管し、ローテーション手順は下記。
2. `MIGRATE_ON_START=true` で 1 台だけ起動するか、`pnpm --filter @happydrive/api migrate` を実行（アドバイザリロックで同時実行を防止）。
3. 運営アカウント作成: `pnpm --filter @happydrive/api admin:create --email ... --name ... --role admin_operator`（初期パスワードは1回だけ表示。初回ログインでMFA登録）。
4. `TRUST_PROXY` をロードバランサーのホップ数/CIDR に設定（`true` は起動拒否）。**企業Web/運営WebのBFFサーバーのアドレスも信頼対象に含める**こと（BFF は利用者の X-Forwarded-For を転送する。含めないと全Web利用者が同一IPとして IP レート制限を共有し、ログインが 429 になる）。`RATE_LIMIT_PER_MINUTE`（既定300/IP/分）も運用に合わせて調整。
5. `/v1/readyz` で `database: ok`、`sms`/`storage`/`payouts` の実際の接続先を確認。

## 監視・アラート（推奨）
| 指標 | 取得元 | 閾値の目安 |
|---|---|---|
| 5xx 率 / p95 レイテンシ | ロードバランサー / ログ `responseTime` | 5xx>1%、読取 p95>500ms、受諾 p95>1s |
| 受諾競合 | `metric_counters.accept_conflict` | 急増は人気案件か障害 |
| 振込失敗 | `metric_counters.payout_failed`、運営への通知 | 1件でも要対応 |
| ルート不成立 | `metric_counters.route_infeasible` | 傾向監視 |
| 通知未配信 | `outbox` の `delivered_at IS NULL AND attempts>3` | 滞留時に確認 |
| 監査連鎖 | `GET /v1/admin/audit-events/verify` を日次実行 | `valid=false` は重大インシデント |
| 照合差異 | `GET /v1/admin/reconciliation?month=` | 月次締めで差異0を確認 |

ログには request_id / 業務ID のみ。電話・住所・トークン・座標・署名URLは出力されない（`services/api/test/privacy.test.ts` で検証）。

## よくある対応
- **振込失敗**: 運営Web「振込」で理由を確認 → 利用者に口座修正を依頼 → 「再試行」（同じ振込レコード・新しい事業者冪等キー、二重振込なし）。
- **紛争**: 運営Web「業務監視」→ 紛争 → 双方の記録・証跡を確認し、満額/一部/支払なしで裁定（理由必須、監査記録）。支払済みの取消は「返金」として逆仕訳。
- **不適切投稿**: 通報一覧から「非表示」「利用停止」「案件取消」。
- **危険報告/ヘルプ**: 運営に通知と問い合わせチケットが自動作成される。必要に応じ 110/119 の案内、発注者と連絡。
- **退会**: アプリ内で完結。未払い報酬・進行中業務・紛争があると理由付きで拒否される。
- **暗号鍵ローテーション**: 新鍵で `FieldCipher` のバージョンを上げ、読込は旧/新両対応、バッチで再暗号化（未実装の手順。実施前に設計レビュー）。

## バックアップ・復旧（目標 RPO≤1h / RTO≤4h）
- マネージドDBの PITR を有効化（保持7日以上）。日次スナップショットを別リージョン/別アカウントへ。
- オブジェクトストレージはバージョニング + ライフサイクル（保管期間どおりに削除）。
- **四半期ごとの復旧演習**: 新環境にPITR復元 → `migrate` → `/readyz` → 監査連鎖検証 → 照合で差異0を確認し、所要時間を記録。

## リリース
1. CI（契約lint、API lint/型/テスト、Web lint/型/テスト/ビルド、Swiftコアテスト、依存脆弱性、シークレットスキャン）が緑。
2. ステージングで移行 → スモーク（OTP→ホーム→受諾→完了→検収→振込サンドボックス）。
3. 本番は 1 台ずつ入替（マイグレーションは後方互換で書く: 追加→コード切替→削除の2段階）。
