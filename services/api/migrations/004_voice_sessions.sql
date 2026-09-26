-- Realtime voice assistant sessions: issuance for rate limiting / cost control and operational metrics only.
-- No audio and no transcript content is stored.
CREATE TABLE voice_sessions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  status text NOT NULL CHECK (status IN ('pending','issued','failed','ended')),
  model text NOT NULL,
  voice text NOT NULL,
  previous_session_id uuid REFERENCES voice_sessions(id),
  failure_code text,
  end_reason text,
  metrics jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX voice_sessions_user_time ON voice_sessions(user_id, created_at DESC);
CREATE INDEX voice_sessions_open ON voice_sessions(created_at) WHERE ended_at IS NULL;
