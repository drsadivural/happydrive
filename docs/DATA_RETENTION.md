# データ保管・削除ポリシー（実装値）

法務確認前の**既定値**です（DECISIONS_REQUIRED D-14）。値を変更する場合は下表の「設定箇所」を更新し、本書を改訂してください。

| データ | 保存形式 | 保管期間（既定） | 削除・匿名化の方法 | 設定箇所 |
|---|---|---|---|---|
| 電話番号 | AES-256-GCM 暗号化 + HMAC 照合用ハッシュ | 退会まで | 退会時に削除。照合用ハッシュのみ30日（再登録防止）後に削除 | `deleted_identities`, `applyRetention` |
| 本人情報（氏名・生年月日・住所）・口座 | 暗号化（口座は末尾4桁のみ平文表示用） | 退会まで | 退会時に削除 | `requestAccountDeletion` |
| 本人確認・資格書類画像 | 暗号化オブジェクトストレージ | 3年 | 期限到来でオブジェクト削除。退会時は即時失効 | `RETENTION_DAYS.identity_document` |
| 業務写真（証跡） | 同上、EXIF/GPS等のメタデータを除去して保存 | 1年 | 期限到来でオブジェクト削除 | `RETENTION_DAYS.work_photo` |
| 配送写真・署名 | 同上 | 90日 | 同上 | `RETENTION_DAYS.delivery_photo` / `signature` |
| 配送先住所・メモ・受取人氏名 | 暗号化 | 退会まで（削除した配送先は論理削除） | 退会時に上書き | `delivery_stops` |
| 受取人電話番号 | 暗号化 | 完了・未配達確定から7日 | 自動削除（以後 410） | `RECIPIENT_CONTACT_RETENTION_DAYS` |
| 業務中の位置（限定共有） | PostGIS | 30日 | 自動削除。発注者には業務中の最新1点のみ表示、軌跡は非公開 | `LOCATION_RETENTION_DAYS` |
| チェックイン位置 | 割当に1点 | 取引記録と同じ | — | `assignments.checkin_point` |
| 確認コード（OTP）・ログイン試行 | ハッシュ | 1日 | 自動削除 | `applyRetention` |
| 冪等キー（応答の再送用） | 応答JSON | 7日 | 自動削除 | `applyRetention` |
| 推薦の表示記録（公平性監査） | 利用者ID・案件ID・理由 | 180日 | 自動削除 | `applyRetention` |
| 報酬台帳・振込・監査イベント | 追記専用（UPDATE/DELETE 禁止トリガー） | 7年（税務・取引記録） | 利用者削除後は氏名を「退会済みユーザー」に匿名化し記録は保持 | `ledger_entries`, `domain_events` |
| アプリログ | 構造化JSON（電話・住所・トークン・座標・署名URLを出力しない） | 運用基盤の設定による（推奨90日） | — | `server.ts` のシリアライザ |

アクセス記録: 受取人電話番号の表示、証跡画像URLの発行、運営によるPII閲覧は `domain_events` に記録されます。
