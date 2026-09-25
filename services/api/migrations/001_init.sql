-- HappyDrive core schema v1.1
-- Extends docs/spec/schema.v1.0-original.sql (PostgreSQL 16+ / PostGIS). UTC at storage boundary; money = integer JPY.
-- PII columns suffixed _ciphertext are AES-256-GCM encrypted by the application; *_hash columns are HMAC-SHA256 blind indexes.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ------------------------------------------------------------------ identity
CREATE TABLE app_users(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  phone_ciphertext bytea,
  phone_hash bytea UNIQUE,
  email text UNIQUE CHECK (email = lower(email)),
  password_hash text,
  totp_secret_ciphertext bytea,
  mfa_enabled boolean NOT NULL DEFAULT false,
  last_totp_step bigint,
  roles text[] NOT NULL DEFAULT '{}',
  verification_status text NOT NULL DEFAULT 'unsubmitted' CHECK (verification_status IN ('unsubmitted','pending','verified','rejected')),
  verification_note text,
  verification_document_ids uuid[] NOT NULL DEFAULT '{}',
  terms_version text,
  privacy_version text,
  terms_accepted_at timestamptz,
  profile_ciphertext bytea,
  vehicle jsonb,
  bank_ciphertext bytea,
  bank_masked jsonb,
  preferences jsonb NOT NULL DEFAULT '{}',
  suspended_at timestamptz,
  suspension_reason text,
  token_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (deleted_at IS NOT NULL OR phone_hash IS NOT NULL OR email IS NOT NULL),
  CHECK (roles <@ ARRAY['worker','org_member','admin_operator','admin_support','admin_auditor']::text[])
);
CREATE INDEX app_users_verification ON app_users(verification_status) WHERE deleted_at IS NULL;

-- Short-lived tombstones prevent immediate re-registration of a deleted phone number (purged after 30 days).
CREATE TABLE deleted_identities(
  phone_hash bytea PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_challenges(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash bytea NOT NULL,
  code_hash bytea NOT NULL,
  ip text,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone ON otp_challenges(phone_hash, created_at DESC);
CREATE INDEX otp_challenges_ip ON otp_challenges(ip, created_at DESC);

CREATE TABLE auth_attempts(
  id bigserial PRIMARY KEY,
  key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_key ON auth_attempts(key, created_at DESC);

CREATE TABLE refresh_tokens(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  family_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  device_name text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_family ON refresh_tokens(family_id);

CREATE TABLE devices(
  apns_token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
CREATE INDEX devices_user ON devices(user_id);

-- ------------------------------------------------------------------ organizations
CREATE TABLE organizations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  kind text NOT NULL DEFAULT 'company' CHECK (kind IN ('company','municipality','npo','other')),
  corporate_number text,
  address text NOT NULL,
  contact text NOT NULL,
  representative_name text NOT NULL,
  review_status text NOT NULL CHECK (review_status IN ('pending','approved','rejected','suspended')),
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organization_members(
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  role text NOT NULL CHECK (role IN ('owner','manager','reviewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id, user_id)
);
CREATE INDEX organization_members_user ON organization_members(user_id);

CREATE TABLE sites(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  address text NOT NULL,
  location geography(Point,4326) NOT NULL,
  area_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX sites_org ON sites(org_id) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------------ skills
CREATE TABLE skill_definitions(
  code text PRIMARY KEY,
  name text NOT NULL,
  source text NOT NULL CHECK (source IN ('training','document')),
  description text,
  course_id text,
  restricted boolean NOT NULL DEFAULT false
);
CREATE TABLE worker_skills(
  worker_id uuid NOT NULL REFERENCES app_users(id),
  skill_code text NOT NULL REFERENCES skill_definitions(code),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  source text NOT NULL CHECK (source IN ('training','document')),
  valid_until date,
  verified_at timestamptz,
  verified_by uuid REFERENCES app_users(id),
  document_evidence_ids uuid[] NOT NULL DEFAULT '{}',
  note text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(worker_id, skill_code)
);

-- ------------------------------------------------------------------ jobs
CREATE TABLE jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  site_id uuid REFERENCES sites(id),
  created_by uuid NOT NULL REFERENCES app_users(id),
  title text NOT NULL,
  category text NOT NULL,
  contract_type text NOT NULL CHECK (contract_type IN ('employment','contractor','other_legal_review')),
  status text NOT NULL CHECK (status IN ('draft','pending_review','published','filled','expired','cancelled','rejected','completed')),
  description text NOT NULL,
  address_ciphertext bytea NOT NULL,
  location geography(Point,4326) NOT NULL,
  public_point geography(Point,4326) NOT NULL,
  area_label text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  amount_yen bigint NOT NULL CHECK (amount_yen > 0),
  expenses_reimbursed_yen bigint NOT NULL DEFAULT 0 CHECK (expenses_reimbursed_yen >= 0),
  worker_borne_costs_note text,
  capacity integer NOT NULL CHECK (capacity > 0),
  reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  cancellation_policy jsonb NOT NULL,
  required_skills text[] NOT NULL DEFAULT '{}',
  steps jsonb NOT NULL DEFAULT '[]',
  min_photo_count integer NOT NULL DEFAULT 0,
  requires_org_approval boolean NOT NULL DEFAULT false,
  reservation_ttl_minutes integer NOT NULL DEFAULT 60,
  check_in_radius_m integer NOT NULL DEFAULT 300,
  meeting_point_note text,
  safety_notes text,
  contact_name text,
  payment_terms_text text,
  employment_terms_text text,
  review_note text,
  terms_hash text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (reserved_count <= capacity)
);
CREATE INDEX jobs_public_geo ON jobs USING gist(public_point) WHERE status = 'published';
CREATE INDEX jobs_public_time ON jobs(starts_at) WHERE status = 'published';
CREATE INDEX jobs_org ON jobs(org_id, created_at DESC);

CREATE TABLE assignments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  worker_id uuid NOT NULL REFERENCES app_users(id),
  state text NOT NULL CHECK (state IN ('reserved','accepted','traveling','checked_in','working','submitted','needs_revision','approved','payable','paid','cancelled','declined','expired','no_show','disputed','refunded')),
  accepted_amount_yen bigint NOT NULL CHECK (accepted_amount_yen > 0),
  terms_snapshot jsonb NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  reservation_expires_at timestamptz,
  steps_completed jsonb NOT NULL DEFAULT '{}',
  checked_in_at timestamptz,
  checkin_point geography(Point,4326),
  work_started_at timestamptz,
  submitted_at timestamptz,
  report_note text,
  review_reason text,
  late_cancellation boolean NOT NULL DEFAULT false,
  location_sharing_until timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A worker can hold at most one live assignment per job (v1.0 index, extended with new terminal states).
CREATE UNIQUE INDEX one_active_assignment_per_worker_job ON assignments(job_id, worker_id)
  WHERE state NOT IN ('cancelled','declined','expired','no_show');
CREATE INDEX assignments_worker ON assignments(worker_id, accepted_at DESC);
CREATE INDEX assignments_job ON assignments(job_id);

CREATE TABLE job_waitlist(
  job_id uuid NOT NULL REFERENCES jobs(id),
  worker_id uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  PRIMARY KEY(job_id, worker_id)
);
CREATE TABLE job_favorites(
  worker_id uuid NOT NULL REFERENCES app_users(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(worker_id, job_id)
);
CREATE TABLE org_blocks(
  worker_id uuid NOT NULL REFERENCES app_users(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(worker_id, org_id)
);

CREATE TABLE location_samples(
  id bigserial PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  point geography(Point,4326) NOT NULL,
  accuracy_m real,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX location_samples_assignment ON location_samples(assignment_id, recorded_at DESC);

CREATE TABLE ratings(
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  rater_role text NOT NULL CHECK (rater_role IN ('worker','organization')),
  rater_id uuid NOT NULL REFERENCES app_users(id),
  ratee_user_id uuid REFERENCES app_users(id),
  ratee_org_id uuid REFERENCES organizations(id),
  score integer NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(assignment_id, rater_role)
);

-- ------------------------------------------------------------------ delivery
CREATE TABLE delivery_routes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id uuid NOT NULL REFERENCES app_users(id),
  scheduled_date date NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','completed','superseded')),
  ordered_stop_ids uuid[] NOT NULL,
  legs jsonb NOT NULL DEFAULT '[]',
  breaks jsonb NOT NULL DEFAULT '[]',
  violations jsonb NOT NULL DEFAULT '[]',
  warnings text[] NOT NULL DEFAULT '{}',
  estimated_minutes integer NOT NULL,
  total_distance_km numeric(10,2) NOT NULL,
  feasible boolean NOT NULL,
  travel_time_source text NOT NULL CHECK (travel_time_source IN ('estimated','provider')),
  departure_at timestamptz NOT NULL,
  start_point geography(Point,4326),
  end_point geography(Point,4326),
  request jsonb NOT NULL,
  manually_ordered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_routes_worker_date ON delivery_routes(worker_id, scheduled_date, created_at DESC);

CREATE TABLE delivery_stops(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id uuid NOT NULL REFERENCES app_users(id),
  scheduled_date date NOT NULL,
  address_ciphertext bytea NOT NULL,
  address_norm_hash bytea NOT NULL,
  location geography(Point,4326),
  time_start timestamptz,
  time_end timestamptz,
  status text NOT NULL CHECK (status IN ('draft','ready','en_route','arrived','delivered','failed','deferred')),
  note_ciphertext bytea,
  recipient_name_ciphertext bytea,
  recipient_phone_ciphertext bytea,
  package_number text,
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 2),
  service_minutes smallint NOT NULL DEFAULT 3 CHECK (service_minutes BETWEEN 0 AND 120),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv','ocr')),
  duplicate_of uuid REFERENCES delivery_stops(id),
  sequence integer,
  estimated_arrival_at timestamptz,
  failure_reason text,
  failure_note text,
  deferred_until timestamptz,
  handoff text,
  completed_at timestamptz,
  contact_purge_after timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (time_end IS NULL OR time_start IS NULL OR time_end > time_start)
);
CREATE INDEX delivery_stops_worker_date ON delivery_stops(worker_id, scheduled_date) WHERE deleted_at IS NULL;
CREATE INDEX delivery_stops_dupe ON delivery_stops(worker_id, scheduled_date, address_norm_hash) WHERE deleted_at IS NULL;

-- ------------------------------------------------------------------ evidence
CREATE TABLE evidence(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid REFERENCES assignments(id),
  delivery_stop_id uuid REFERENCES delivery_stops(id),
  purpose text NOT NULL CHECK (purpose IN ('work_photo','delivery_photo','signature','identity_document','skill_document','message_attachment')),
  status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload','verified','rejected')),
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL,
  stored_sha256 text,
  mime_type text NOT NULL,
  byte_size integer NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CHECK (num_nonnulls(assignment_id, delivery_stop_id) <= 1)
);
CREATE INDEX evidence_assignment ON evidence(assignment_id);
CREATE INDEX evidence_stop ON evidence(delivery_stop_id);

-- ------------------------------------------------------------------ idempotency / events / outbox
CREATE TABLE idempotency_keys(
  actor_id uuid NOT NULL REFERENCES app_users(id),
  key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id, key)
);

CREATE TABLE domain_events(
  id bigserial PRIMARY KEY,
  chain_seq bigint UNIQUE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_id uuid REFERENCES app_users(id),
  actor_role text,
  reason text,
  payload jsonb NOT NULL DEFAULT '{}',
  prev_hash text,
  hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_events_entity ON domain_events(entity_type, entity_id, created_at);

CREATE FUNCTION domain_event_hash(prev text, seq bigint, e domain_events) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(concat_ws('|', coalesce(prev,'genesis'), seq::text, e.entity_type, e.entity_id::text, e.event_type,
    coalesce(e.actor_id::text,''), coalesce(e.actor_role,''), coalesce(e.reason,''), e.payload::text,
    to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'sha256'), 'hex')
$$;

-- Tamper-evident hash chain. The advisory lock serialises chain assignment; callers insert events last in a transaction.
CREATE FUNCTION domain_events_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_seq bigint; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(727274001);
  SELECT chain_seq, hash INTO last_seq, last_hash FROM domain_events WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := domain_event_hash(last_hash, NEW.chain_seq, NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER domain_events_chain BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION domain_events_chain();

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER domain_events_append_only BEFORE UPDATE OR DELETE ON domain_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE outbox(
  id bigserial PRIMARY KEY,
  event_id bigint UNIQUE REFERENCES domain_events(id),
  topic text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox(next_attempt_at) WHERE delivered_at IS NULL;

-- ------------------------------------------------------------------ money
CREATE TABLE payout_batches(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cutoff_date date NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payouts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES payout_batches(id),
  worker_id uuid NOT NULL REFERENCES app_users(id),
  contract_type text NOT NULL CHECK (contract_type IN ('employment','contractor')),
  amount_yen bigint NOT NULL CHECK (amount_yen > 0),
  status text NOT NULL CHECK (status IN ('requested','processing','paid','failed')),
  provider text NOT NULL,
  provider_idempotency_key text NOT NULL UNIQUE,
  provider_reference text UNIQUE,
  failure_reason text,
  attempt_count integer NOT NULL DEFAULT 0,
  scheduled_date date NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_worker ON payouts(worker_id, created_at DESC);
CREATE TABLE payout_items(
  payout_id uuid NOT NULL REFERENCES payouts(id),
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  amount_yen bigint NOT NULL,
  released_at timestamptz,
  PRIMARY KEY(payout_id, assignment_id)
);
-- An assignment balance may be attached to only one live (non-failed) payout.
CREATE UNIQUE INDEX payout_items_live ON payout_items(assignment_id) WHERE released_at IS NULL;

CREATE TABLE ledger_entries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  worker_id uuid NOT NULL REFERENCES app_users(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  contract_type text NOT NULL CHECK (contract_type IN ('employment','contractor')),
  entry_type text NOT NULL CHECK (entry_type IN ('earned','expense','compensation','reversal','paid','refund')),
  amount_yen bigint NOT NULL,
  payout_id uuid REFERENCES payouts(id),
  provider_reference text UNIQUE,
  reason text,
  actor_id uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_type IN ('reversal','refund') AND amount_yen < 0) OR (entry_type NOT IN ('reversal','refund') AND amount_yen > 0))
);
CREATE INDEX ledger_assignment ON ledger_entries(assignment_id);
CREATE INDEX ledger_worker ON ledger_entries(worker_id, created_at);
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE provider_webhooks(
  provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text,
  payload jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY(provider, external_event_id)
);

-- ------------------------------------------------------------------ messaging / support
CREATE TABLE messages(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  sender_id uuid REFERENCES app_users(id),
  sender_role text NOT NULL CHECK (sender_role IN ('worker','organization','operator','system')),
  body text NOT NULL,
  evidence_id uuid REFERENCES evidence(id),
  hidden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_assignment ON messages(assignment_id, created_at);

CREATE TABLE reports(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES app_users(id),
  target_type text NOT NULL CHECK (target_type IN ('message','job','user','organization')),
  target_id uuid NOT NULL,
  reason text NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text,
  resolved_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_tickets(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  category text NOT NULL,
  body text NOT NULL,
  answer text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  assignment_id uuid REFERENCES assignments(id),
  job_id uuid REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE deletion_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  reason text,
  status text NOT NULL CHECK (status IN ('completed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- ------------------------------------------------------------------ learning / matching
CREATE TABLE course_attempts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id uuid NOT NULL REFERENCES app_users(id),
  course_id text NOT NULL,
  score integer NOT NULL,
  total integer NOT NULL,
  passed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX course_attempts_worker ON course_attempts(worker_id, course_id);

CREATE TABLE matching_config(
  id bigserial PRIMARY KEY,
  weights jsonb NOT NULL,
  max_distance_km numeric NOT NULL,
  reason text,
  updated_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO matching_config(weights, max_distance_km, reason) VALUES
  ('{"distance":0.30,"timeFit":0.20,"skillFit":0.15,"reliability":0.10,"preference":0.10,"fairness":0.15}', 15, '初期値');

CREATE TABLE match_impressions(
  id bigserial PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES app_users(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  score real,
  reasons text[] NOT NULL DEFAULT '{}',
  excluded_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_impressions_time ON match_impressions(created_at);

-- ------------------------------------------------------------------ metrics
CREATE TABLE metric_counters(
  name text NOT NULL,
  day date NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(name, day)
);
