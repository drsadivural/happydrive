-- PostgreSQL 16 + PostGIS. Run migrations in transactional order; encryption keys live outside DB.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_name text NOT NULL, given_name text NOT NULL,
 phone_e164 text NOT NULL UNIQUE, email text, address_ciphertext bytea, photo_object_key text,
 phone_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE user_roles (
 user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('customer','supplier','admin')),
 PRIMARY KEY(user_id,role)
);
CREATE TABLE suppliers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), legal_name text NOT NULL UNIQUE,
 supplier_type text NOT NULL CHECK(supplier_type IN ('company','sole_proprietor')),
 review_status text NOT NULL CHECK(review_status IN ('invited_unverified','pending','approved','rejected')),
 address_ciphertext bytea, contact_user_id uuid REFERENCES users(id),
 stripe_customer_id text UNIQUE, stripe_subscription_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE supplier_members (
 supplier_id uuid NOT NULL REFERENCES suppliers(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('owner','manager','staff')),
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(supplier_id,user_id)
);
CREATE TABLE supplier_services (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES suppliers(id),
 name text NOT NULL, category text NOT NULL, description text NOT NULL,
 area_codes text[] NOT NULL, duration_minutes integer NOT NULL CHECK(duration_minutes>0),
 price_policy text NOT NULL, required_qualifications text[] NOT NULL DEFAULT '{}',
 status text NOT NULL CHECK(status IN ('draft','pending_review','published','paused')),
 source text NOT NULL CHECK(source IN ('manual','mcp')), external_id text, source_updated_at timestamptz,
 reviewed_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX unique_mcp_service ON supplier_services(supplier_id,external_id) WHERE external_id IS NOT NULL;
CREATE TABLE mcp_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES suppliers(id),
 server_url text NOT NULL, credentials_secret_ref text, status text NOT NULL CHECK(status IN ('pending','authorized','disabled','error')),
 last_sync_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mcp_sync_diffs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), connection_id uuid NOT NULL REFERENCES mcp_connections(id),
 external_id text NOT NULL, proposed_json jsonb NOT NULL, state text NOT NULL CHECK(state IN ('pending','approved','rejected')),
 reviewed_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_pending_mcp_diff ON mcp_sync_diffs(connection_id,external_id) WHERE state='pending';
CREATE TABLE supplier_qualifications (
 supplier_id uuid NOT NULL REFERENCES suppliers(id), staff_id uuid REFERENCES users(id), qualification_code text NOT NULL,
 valid_until date, verified_at timestamptz, evidence_object_key text,
 id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE TABLE supplier_availability (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES suppliers(id), staff_id uuid REFERENCES users(id),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, active boolean NOT NULL DEFAULT true,
 CHECK(ends_at>starts_at)
);
CREATE TABLE subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid REFERENCES users(id), supplier_id uuid REFERENCES suppliers(id),
 stripe_customer_id text NOT NULL, stripe_subscription_id text NOT NULL UNIQUE, stripe_price_id text NOT NULL,
 plan_code text NOT NULL, status text NOT NULL, trial_ends_at timestamptz,
 current_period_start timestamptz, current_period_end timestamptz, cancel_at_period_end boolean NOT NULL DEFAULT false,
 last_stripe_sync_at timestamptz NOT NULL DEFAULT now(),
 CHECK((customer_user_id IS NOT NULL)::int+(supplier_id IS NOT NULL)::int=1)
);
CREATE UNIQUE INDEX active_customer_subscription ON subscriptions(customer_user_id) WHERE customer_user_id IS NOT NULL AND status IN ('trialing','active','past_due');
CREATE UNIQUE INDEX active_supplier_subscription ON subscriptions(supplier_id) WHERE supplier_id IS NOT NULL AND status IN ('trialing','active','past_due');
CREATE TABLE quota_periods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id uuid NOT NULL REFERENCES subscriptions(id),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 plan_code text NOT NULL CHECK(plan_code IN ('basic','standard','care')),
 period_limit integer, daily_limit integer,
 UNIQUE(subscription_id,starts_at), CHECK(ends_at>starts_at),
 CHECK((plan_code='care' AND period_limit IS NULL AND daily_limit=2) OR (plan_code='basic' AND period_limit=5 AND daily_limit IS NULL) OR (plan_code='standard' AND period_limit=12 AND daily_limit IS NULL))
);
CREATE TABLE requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES users(id), service_id uuid NOT NULL REFERENCES supplier_services(id),
 title text NOT NULL, details_ciphertext bytea NOT NULL, address_ciphertext bytea NOT NULL,
 public_area_code text NOT NULL, location geography(Point,4326), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('draft','open','accepted','en_route','arrived','in_progress','awaiting_customer_confirmation','completed','cancelled','expired','disputed','resolved_completed','resolved_cancelled')),
 accepted_supplier_id uuid REFERENCES suppliers(id), assigned_staff_id uuid REFERENCES users(id),
 total_charge_yen bigint NOT NULL CHECK(total_charge_yen>=0), accepted_terms_json jsonb,
 accepted_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at>starts_at),
 CHECK((status IN ('draft','open','cancelled','expired') OR accepted_supplier_id IS NOT NULL)),
 CHECK(assigned_staff_id IS NULL OR accepted_supplier_id IS NOT NULL)
);
CREATE INDEX open_requests_area_time ON requests(public_area_code,starts_at) WHERE status='open';
CREATE INDEX customer_requests ON requests(customer_id,created_at DESC);
CREATE TABLE quota_reservations (
 request_id uuid PRIMARY KEY REFERENCES requests(id), quota_period_id uuid NOT NULL REFERENCES quota_periods(id),
 scheduled_jst_date date NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','consumed','released','held_dispute')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_state_period ON quota_reservations(quota_period_id,state);
CREATE INDEX quota_care_day ON quota_reservations(quota_period_id,scheduled_jst_date,state);
CREATE TABLE completion_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES requests(id),
 token_hash bytea NOT NULL UNIQUE, customer_id uuid NOT NULL REFERENCES users(id),
 supplier_id uuid NOT NULL REFERENCES suppliers(id), staff_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_live_qr_per_request ON completion_tokens(request_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE TABLE domain_events (
 id bigserial PRIMARY KEY, entity_type text NOT NULL, entity_id uuid NOT NULL, event_type text NOT NULL,
 actor_id uuid REFERENCES users(id), reason_code text, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_events_entity ON domain_events(entity_type,entity_id,created_at);
CREATE TABLE outbox (
 id bigserial PRIMARY KEY, domain_event_id bigint NOT NULL UNIQUE REFERENCES domain_events(id),
 topic text NOT NULL, payload jsonb NOT NULL, processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency_keys (
 actor_id uuid NOT NULL REFERENCES users(id), scope text NOT NULL, key text NOT NULL,
 request_hash text NOT NULL, response_code integer NOT NULL, response_body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,scope,key)
);
CREATE TABLE stripe_events (
 stripe_event_id text PRIMARY KEY, type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE TABLE payment_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id uuid REFERENCES subscriptions(id), request_id uuid REFERENCES requests(id),
 entry_type text NOT NULL CHECK(entry_type IN ('subscription_invoice','service_charge','supplier_transfer','refund','reversal')),
 amount_yen bigint NOT NULL, stripe_reference text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((subscription_id IS NOT NULL)::int+(request_id IS NOT NULL)::int>=1)
);
CREATE TABLE evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES requests(id), uploaded_by uuid NOT NULL REFERENCES users(id),
 object_key text NOT NULL UNIQUE, sha256 char(64) NOT NULL, mime_type text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES requests(id), sender_id uuid NOT NULL REFERENCES users(id),
 body_ciphertext bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE delivery_stops (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES suppliers(id), staff_id uuid NOT NULL REFERENCES users(id),
 scheduled_date date NOT NULL, address_ciphertext bytea NOT NULL, location geography(Point,4326),
 time_start timestamptz, time_end timestamptz,
 status text NOT NULL CHECK(status IN ('draft','ready','en_route','arrived','delivered','failed','deferred')),
 evidence_object_key text, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(time_end IS NULL OR time_start IS NULL OR time_end>time_start)
);
CREATE INDEX delivery_stops_staff_date ON delivery_stops(staff_id,scheduled_date);
CREATE TABLE dispute_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES requests(id),
 proposed_decision text NOT NULL CHECK(proposed_decision IN ('resolved_completed','resolved_cancelled')),
 proposed_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id),
 reason text NOT NULL, evidence_summary text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(approved_by IS NULL OR approved_by<>proposed_by)
);

-- Transaction invariant: lock quota_periods row before inserting reservation, count reserved+consumed/held_dispute.
-- Care daily count is based on scheduled_jst_date, under the same quota_period row lock.
-- Accept transaction: conditional UPDATE requests SET status='accepted' WHERE id=? AND status='open' RETURNING id.
-- QR verify transaction: lock request and token, validate actor+hash+expiry+state, consume exactly once, update quota+outbox.
-- Initial invitations require confirmed company ownership; no live supplier accounts or published services are seeded.
INSERT INTO suppliers(legal_name,supplier_type,review_status)
VALUES ('OTERA','company','invited_unverified'),('トーカイ','company','invited_unverified'),('Nurse and Craft','company','invited_unverified')
ON CONFLICT(legal_name) DO NOTHING;
