-- Google subjects are blind-indexed: no provider tokens or raw subjects are retained.
CREATE TABLE google_identities (
  subject_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE google_auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce_hash bytea NOT NULL,
  client_id text NOT NULL,
  user_id uuid REFERENCES app_users(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_auth_challenges_expiry ON google_auth_challenges(expires_at);
