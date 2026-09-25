# 要件トレーサビリティ（要件 → 画面 → API → 試験）

略記: iOS = `apps/ios/HappyDrive/Features/…`, P = `apps/partner-web/app/(portal)/…`, A = `apps/admin-web/app/(admin)/…`, API試験 = `services/api/test/…`。
「試験」欄の自動試験はすべて実行済み（`docs/TEST_RESULTS.md`）。iOS 画面の動作確認は Xcode 環境での実施待ち（未実施）。

## 画面・業務（PRODUCT.md §2〜§6）
| 要件 | 画面 | API（operationId） | 試験 |
|---|---|---|---|
| 起動・登録（電話確認、規約、本人・車両、資格、口座、審査状況） | iOS Onboarding/AuthFlowView, OnboardingFlowView | requestOtp, verifyOtp, acceptTerms, updateProfile, updateVehicle, updateBankAccount, createEvidenceUpload, completeEvidenceUpload, submitVerification, submitSkill, getMe | auth.test（ID-01）, contract.test |
| ホーム（今日の配送・案件・予定報酬・通知・近隣提案） | iOS Home/HomeView | getHome, listNotifications | contract.test, privacy.test（位置なし） |
| 配送先（手入力・住所検索・CSV・OCR・重複・時間帯・メモ・連絡先・荷物番号） | iOS Delivery/AddStopView, CSVImportView, OCRCaptureView | addStop, importStops, updateStop, deleteStop, getStopContact | delivery.test（DEL-01） |
| 配送ルート（地図、並べ替え、出発/終点、時間枠、休憩、見込み到着、再最適化） | iOS Delivery/OptimizeSheet, RouteMapView, DeliveryView | optimizeRoute, getRoute, reorderRoute, startRoute | optimizer.test, delivery.test（DEL-02） |
| ナビ・配送詳細（Appleマップ、到着、通話、未配達理由、写真/署名/置き配） | iOS Delivery/StopDetailView, Shared/SignaturePad, PhotoAttachments | recordStopEvent, getStopContact, createEvidenceUpload | delivery.test（DEL-03） |
| 圏外時の保存と再送（重複なし） | iOS（HappyDriveCore OfflineQueue） | Idempotency-Key 全書込 | delivery.test（同一キー再送）, iOS Core OfflineQueueTests |
| 案件検索（地図/リスト、距離・日付・時刻・報酬・カテゴリ・資格、お気に入り、空き枠） | iOS Jobs/JobSearchView | searchJobs, favoriteJob, joinWaitlist | jobs.test（JOB-02） |
| 案件詳細（発注者、報酬内訳、負担費用、必要資格、キャンセル/安全条件） | iOS Jobs/JobDetailView, AcceptConfirmationSheet | getJob, acceptJob | jobs.test（JOB-03, terms_changed） |
| 業務実行（移動・チェックイン・手順・写真・メモ・危険報告・ヘルプ） | iOS Workflow/AssignmentWorkflowView, ChatView | advanceAssignment, shareLocation, sendMessage | jobs.test（JOB-04）, privacy.test（PRI-01） |
| 完了/評価（検収、差戻し、相互評価、報酬確定/振込予定） | iOS Workflow/SubmitReportView; P assignments | advanceAssignment(submitted), reviewAssignment, rateAssignment | jobs.test（JOB-04） |
| 学ぶ（マニュアル、講習、確認テスト、資格期限） | iOS Learning/LearningViews | listCourses, getCourse, submitQuizAttempt | contract.test（合格で資格付与） |
| マイページ（実績・評価・収入/明細・本人情報・通知・公開範囲・位置権限・削除・サポート） | iOS MyPage/MyPageView, AccountViews | getEarnings, getEarningsSummary, listMyPayouts, updatePreferences, requestAccountDeletion, createSupportTicket | privacy.test（PRI-02）, payments.test |
| 発注者Web（企業審査、拠点、案件作成/公開、応募・マッチング、監視、検収、請求） | P onboarding, dashboard, sites, jobs, matching, assignments, billing, messages, settings | registerOrganization, createSite, createJob, submitJobForReview, decideReservation, getLiveLocation, reviewAssignment, listInvoices, … | jobs.test（JOB-01, JOB-05）, authz.test（ID-02）, Web単体試験・実API結合確認 |
| 運営Web（ユーザー/企業審査、違反案件、問い合わせ、紛争/返金、再割当、監査、決済照合、分析） | A users, organizations, jobs, assignments, reports, support, payouts, reconciliation, audit, matching, dashboard, deletion-requests | admin* 一式 | payments.test（PAY-01/02）, privacy.test（SEC-02）, jobs.test（再割当）, contract.test |
| 業務分類（雇用/業務委託/法務審査中）と公開前チェック | P jobs（フォームとチェック表示） | publishChecks（submitJobForReview / adminReviewJob） | jobs.test（JOB-01） |
| 要資格・医療/介護案件は不可 | P jobs（選択不可と説明） | createJob（category_restricted） | jobs.test（JOB-01） |
| 原子的な受諾・予約期限・空き待ち・辞退/再募集 | iOS Jobs | acceptJob, decideReservation, joinWaitlist, releaseSlot（内部） | jobs.test（JOB-03, 予約期限, 空き待ち通知） |
| 状態遷移と追記式イベント（理由・操作主体・時刻） | 各画面のタイムライン | domain_events（全書込） | privacy.test（SEC-02 監査・改ざん検出） |
| 位置（募集時は粗い位置、稼働中のみ、軌跡非公開、終了で停止） | iOS Workflow; P assignments | searchJobs（approximateLocation）, shareLocation, getLiveLocation | privacy.test（PRI-01）, jobs.test |
| チャット・通報・ブロック・電話番号非公開 | iOS Workflow/ChatView; P messages; A reports | listMessages, sendMessage, createReport, blockOrganization, adminResolveReport | contract.test, jobs.test（公開前チェックで電話番号記載を拒否） |
| 報酬台帳（見込/確定/保留/振込予定/振込済/失敗/取消、雇用と業務委託の別会計） | iOS MyPage; A payouts, reconciliation | getEarnings, adminCreatePayoutBatch, adminReconciliation | payments.test |
| AIマッチング（ハード条件→説明可能な順位、異議申立て、公平性の監査） | iOS Jobs（理由チップ、異議申立て）; A matching | searchJobs(sort=recommended), createMatchingAppeal, adminMatchingAudit, adminUpdateMatchingConfig | jobs.test（JOB-02、除外記録）, contract.test |

## 受け入れ項目（ACCEPTANCE.md）
| ID | 自動試験 | 状態 |
|---|---|---|
| ID-01 | auth.test（無効/期限切れOTP、回数・IP制限、承認前の受諾禁止は jobs.test） | 合格 |
| ID-02 | authz.test（他社の案件/住所/証跡/報酬/位置をID直指定で取得不可） | 合格 |
| DEL-01 | delivery.test | 合格（OCR は iOS 端末での確認が未実施） |
| DEL-02 | optimizer.test（200地点）, delivery.test（24地点・時間窓・休憩・優先度・並べ替え・不成立理由） | 合格 |
| DEL-03 | delivery.test（写真必須、オフライン再送の重複なし）, iOS Core OfflineQueueTests | API/コア合格。ナビ起動は実機未確認 |
| JOB-01〜05 | jobs.test（100並列受諾を含む） | 合格 |
| PAY-01, PAY-02 | payments.test（署名不正・重複・順不同・二重払いなし・失敗/再試行/通知・逆仕訳・照合） | 合格（サンドボックス事業者） |
| PRI-01, PRI-02 | privacy.test | API合格。iOS の権限拒否時の挙動は実機未確認 |
| SEC-01, SEC-02 | privacy.test（署名URL・失効・偽装・EXIF・過大・監査連鎖・ログ） | 合格 |
| UI-01〜03 | Web: 単体試験・実API結合・スクリーンショット（docs/screenshots/web）。iOS: 未実施 | 一部 |
| OPS-01 | scripts/loadtest.ts（p95 計測）、Runbook | 開発機で計測済み。監視・復旧演習は本番基盤決定後 |
| APP-01 | — | 未実施（Mac / Apple Developer アカウントが必要） |
