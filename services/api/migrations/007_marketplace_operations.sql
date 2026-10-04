-- Encrypt cached mutation responses, including short-lived QR and invitation secrets.
ALTER TABLE public.idempotency_keys ADD COLUMN response_ciphertext bytea;
CREATE TABLE marketplace.supplier_applications (
 supplier_id uuid PRIMARY KEY REFERENCES marketplace.suppliers(id),
 details_ciphertext bytea NOT NULL, evidence_ids uuid[] NOT NULL DEFAULT '{}',
 submitted_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
 reviewed_by uuid REFERENCES public.app_users(id), review_reason text
);
CREATE TABLE marketplace.staff_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES marketplace.suppliers(id),
 phone_hash bytea NOT NULL, phone_ciphertext bytea NOT NULL,
 role text NOT NULL CHECK(role IN ('manager','staff')), token_hash bytea NOT NULL UNIQUE,
 invited_by uuid NOT NULL REFERENCES public.app_users(id),
 expires_at timestamptz NOT NULL, accepted_by uuid REFERENCES public.app_users(id), accepted_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX marketplace_live_invite ON marketplace.staff_invitations(supplier_id,phone_hash) WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE marketplace.dispute_reviews ADD COLUMN rejected_by uuid REFERENCES public.app_users(id);
ALTER TABLE marketplace.dispute_reviews ADD COLUMN decided_at timestamptz;
CREATE UNIQUE INDEX marketplace_pending_review ON marketplace.dispute_reviews(request_id) WHERE approved_by IS NULL AND rejected_by IS NULL;
CREATE TABLE marketplace.ratings (
 request_id uuid PRIMARY KEY REFERENCES marketplace.requests(id), customer_id uuid NOT NULL REFERENCES marketplace.users(id),
 supplier_id uuid NOT NULL REFERENCES marketplace.suppliers(id), score integer NOT NULL CHECK(score BETWEEN 1 AND 5),
 comment_ciphertext bytea, created_at timestamptz NOT NULL DEFAULT now()
);
