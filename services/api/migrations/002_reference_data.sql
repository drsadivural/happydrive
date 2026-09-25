-- Reference data: skill catalogue (training-derived and document-verified) and the sandbox payout simulator table.
INSERT INTO skill_definitions(code, name, source, description, course_id, restricted) VALUES
  ('life_support_training',   '生活支援講習',               'training', '買い物付き添い・生活支援の基本（HappyDrive講習）', 'life_support_basic', false),
  ('elderly_watch_training',  '見守り講習',                 'training', '高齢者見守り訪問の基本（医療判断を含まない）', 'elderly_watch_basic', false),
  ('privacy_training',        '個人情報の取扱い講習',       'training', '訪問先・配送先の個人情報の扱い', 'privacy_basics', false),
  ('delivery_safety_training','安全運転・配送マナー講習',   'training', '安全運転と配送時のマナー', 'safe_delivery', false),
  ('drivers_license',         '普通自動車運転免許',         'document', '有効期限内の運転免許証', NULL, false),
  ('kei_cargo_registration',  '貨物軽自動車運送事業の届出', 'document', '黒ナンバー（事業用軽自動車）の届出書類', NULL, false),
  ('first_aid',               '普通救命講習',               'document', '消防署等の普通救命講習修了証', NULL, false),
  ('caregiver_initial_training','介護職員初任者研修',       'document', '身体介護を伴う業務の前提資格（事業審査確定まで案件公開不可）', NULL, true)
ON CONFLICT (code) DO NOTHING;

-- Only used when PAYOUT_PROVIDER=sandbox (never in production; enforced by config).
CREATE TABLE sandbox_transfers(
  reference text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  amount_yen bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','paid','failed')),
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
