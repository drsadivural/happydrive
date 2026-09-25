# @happydrive/web-ui

企業ポータル・運営Web の共通コード（ソースのまま `transpilePackages` で取り込む）。

- `format` — JST 表示・JST⇔UTC 変換・円表示
- `labels` — 契約の列挙値の日本語ラベルと表示トーン
- `errors` / `idempotency` / `csv` / `nav`
- `bff/*` — BFF（許可リスト・CSRF・セッション Cookie・リフレッシュ・プロキシ・認証ハンドラ・ページガード・セキュリティヘッダー）
- `client/*` — ブラウザ用 API クライアント（openapi-fetch + CSRF）、`useQuery` / `useMutation`（Idempotency-Key 再利用）
- `components` — AppShell・フォーム・ダイアログ・状態表示・ログイン（TOTP QR）・証跡ギャラリー
- `styles.css` — design-tokens の CSS 変数に基づく共通スタイル

`pnpm --filter @happydrive/web-ui test` で単体テスト（JST/円・ラベル・許可リスト・CSRF・リフレッシュ・セッション Cookie・Idempotency・CSV・CSP）。
