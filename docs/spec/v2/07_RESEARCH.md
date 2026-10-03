# 07 一次資料を使った設計根拠（2026-10-03確認）

| 資料 | 参照内容 | HappyDriveへの適用 |
|---|---|---|
| [Uber 料金事前表示](https://help.uber.com/riders/article/how-do-upfront-fares-work?nodeId=5073140f-3d5f-4046-80da-2db9ed7b11b3) | リクエスト前の料金表示 | 依頼前に月額枠・個別料金と条件を表示 |
| [Uber Eats 依頼受諾](https://help.uber.com/driving-and-delivering/article/receiving-a-delivery-request?nodeId=6f280659-2876-4d2f-b641-1b7e38e45887) | 配達側が提示案件を受諾 | 供給者が選び原子的にロック |
| [Uber Eats PIN/受取](https://help.uber.com/ja-JP/ubereats/restaurants/article/how-to-receive-your-order?nodeId=a5e5ae9b-30cd-4f46-8b04-9cf27a1a31a1) | 顧客側PINで受渡確認する場合がある | QRを顧客表示・担当者読取として設計 |
| [Stripe Billing Trial](https://docs.stripe.com/billing/subscriptions/trials) | 無料期間とその後の請求 | 顧客30日、供給者7日を別Subscription |
| [Stripe Webhooks](https://docs.stripe.com/billing/subscriptions/webhooks) | trial end、invoice paid/failed等 | 権限と枠をWebhookで同期 |
| [Stripe Connect](https://docs.stripe.com/connect/separate-charges-and-transfers) | プラットフォームの個別代金と供給者への送金 | 商用決定後にサービス代金と分配を実装 |
| [Apple 審査](https://developer.apple.com/jp/app-store/review/guidelines/) | 対面サービス/デジタル課金区分、アカウント削除等 | 顧客/供給者の課金導線を分離 |
| [AVFoundation QR](https://developer.apple.com/documentation/avfoundation/machine-readable-object-types) | QRコード読取のネイティブ認識 | 供給者iOSスキャナ |
| [MCP 仕様](https://modelcontextprotocol.io/specification/) | remote MCPの認証・ツール呼出 | 供給者のサービス取込のみを権限分離 |

公開機能から業務フローの原則を抽出した。Uberの画面、ロゴ、ソースコードや独自の運用規則は複製しない。
