# 04 Stripe契約・件数・精算

## Stripeオブジェクト
顧客にStripe Customer、SetupIntentでカード保存、選択したPriceによるSubscription（30日trial）。供給者組織には別のStripe CustomerとSubscription（7日trial、Priceは商用決定後）。`stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id` を自社DBへ保存。カード番号/CVCは保持しない。顧客の請求や供給者の支払いはユーザー/組織IDで分離。製品価格の税込/税別を公開画面とStripe請求書で一致させる。

## 登録と権限
カード登録完了だけで有効とはせず、Stripeに作成したsubscriptionの状態をWebhookで同期。trialing は提供期間中のみ、active は支払確認済みの期間のみ投稿/受諾できる。未決済・incomplete・past_due・unpaid・canceled・paused は新規投稿/受諾停止を原則とし、進行中の依頼や履歴へのアクセスは維持。支払失敗通知、カード更新、復旧を提供。トライアル3日前の通知と解約。解約後は期間末まで権利維持し、顧客が現在の依頼を確認できる。supplier subscription trial after payment method capture. 次の更新日の実表示はStripeデータによる。

## 枠台帳
`quota_period` = Stripeの各subscription billing period。trialも一期間として扱い、プランの月間件数をその期間に適用。各投稿につき `quota_reservation` を一件作成。キーはrequest_idで一意。投稿/取消/QR完了/紛争の同一DBトランザクションで状態遷移。Basic 5/Standard 12 の期間内 `reserved+consumed ≤ limit`。Careの同一JST日（現場予定日）`reserved+consumed ≤ 2`。プラン変更時の枠/日次制約は既存予約を損なわない移行規則に従い、即時ダウングレードで予約を自動取消しない。繰越は初版なし。作業が翌日へ変更されたら旧日を開放して新日を確保する原子的移動。

## 個別業務代金
月額に個別業務代金を含むかは契約上未定義。初版の技術設計は `service_charge` を別に持つが、価格承認前は本番請求しない。別途請求する場合: 受諾前に総額/材料/交通費/キャンセル費/税を確定表示し、必要に応じPaymentIntentの事前オーソリ・決済・返金とStripe Connectによる供給者への精算を使う。月額会費と現場業務代金の台帳/領収書を分ける。無制限プランでも供給者の無制限無料労務を約束しない。

## Webhook
署名をraw bodyで検証、`event.id` を一意保存、順不同時はSubscription/InvoiceをStripe APIで最新取得して再計算する。少なくとも `customer.subscription.created/updated/deleted`, `customer.subscription.trial_will_end`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required` を処理。イベントはoutbox処理し成功確認前の重複付与なし。3DS/支払失敗時に再認証画面。Stripe Customer Portalは解約/支払方法更新のWebで利用し、アプリ内契約管理の導線はApp Review区分を確認してから実装。

## 商用決定ゲート（値を発明しない）
- 供給者の無料7日後の月額、課税、初回課金日、複数拠点料金。
- 顧客料金の税込/税別、30日trial中の5/12/2件上限の正式承認。
- 月額に現場サービス原価を含むか、個別見積/請求か、材料/交通費負担。
- キャンセル/当日不在/紛争時に枠と料金をどう扱うか、未完了時の供給者補償。
- Stripe Connectで供給者精算する場合の責任主体、KYC、振込、返金、手数料。
- 供給者向けデジタル契約のiOSからの購入導線（App Store規則の審査）。Web申込を基本とし、iOS内Stripe購入画面は初版に入れない。
