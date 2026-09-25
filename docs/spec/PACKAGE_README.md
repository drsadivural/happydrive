# HappyDrive「Happyアプリ」実装パッケージ

2026-09-26 / 日本語 / iPhone向け設計資料・画面モック・Claude Code実装指示

## このパッケージの状態
これは**開発に着手できる設計パッケージ**です。iOSアプリ、稼働中のAPI、決済契約、実機テスト結果、App Store審査通過を含みません。「Apple提出準備」を完了条件とするための実装・検証手順を定義しています。画面の住所、氏名、金額、地図は説明用の架空データです。スクリーンショットは完成アプリを実機またはシミュレータで撮り直してください。

## 収録内容
- `assets/` 提供画像4点の原本と、提供画像から切り出したワードマーク・アイコン参照。これらは権利者の提供を前提とする参照画像。元画像の背景を含むため、入稿時は権利者提供のベクターマスターで再制作すること。
- `mockups/01`～`08` ドライバー画面PNG。`render.py` はレイアウトを再生成する編集用スクリプト。
- `docs/PRODUCT.md` 要件、業務フロー、機能一覧、状態遷移、非機能要件。
- `docs/ARCHITECTURE.md` システム構成、セキュリティ、AI、外部サービス。
- `docs/APPLE_RELEASE.md` 提出準備と審査項目。
- `docs/RESEARCH.md` 競合機能と根拠URL。
- `contracts/openapi.yaml` MVP用API契約と主要ペイロード。
- `database/schema.sql` PostgreSQL/PostGIS中核スキーマ。
- `tests/ACCEPTANCE.md` E2E・失敗系・実機受け入れ項目。
- `claude/CLAUDE_CODE_PROMPT.md` Claude Codeに渡す実装指示。

## 推奨構成
SwiftUI iOSアプリ + TypeScript/Fastify API + PostgreSQL/PostGIS + Redis/ジョブキュー + S3互換証跡保存 + Next.js発注/管理画面。iOSはMapKitとCore Location、ナビはAppleマップへの引き継ぎ。決済・本人確認は日本でサービス契約可能な事業者を選定後、サーバー側アダプタで接続。機密情報はキーチェーン/サーバーシークレットへ。

## Claude Codeでの使い方
1. このZIPを作業リポジトリに展開する。
2. `claude/CLAUDE_CODE_PROMPT.md` をClaude Codeへ入力し、同梱仕様をすべて参照させる。
3. 契約主体、雇用/業務委託、報酬支払主体、実運用の提携先、ロゴ原本、開発者アカウントを確定する。
4. 実装、結合試験、実機試験、TestFlight、提出前レビューを順に行う。

## 対象範囲の判断
提供画像のロゴ以外の企業・団体の表示は将来連携を説明する図として扱う。LocationMind、ZENRIN、Ayonix、OTERA等とのAPI接続や正式提携は提供画像だけでは証明できないため、契約/仕様取得をリリース条件とする。初版は自社の企業ポータルと自社案件を動作させ、承認済みの接続を個別に追加する。
