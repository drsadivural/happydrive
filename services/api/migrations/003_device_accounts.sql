-- Device-bound worker accounts: the app signs in with a random secret kept in the device Keychain
-- (phone verification removed from the driver app). Only an HMAC of the secret is stored.
ALTER TABLE app_users ADD COLUMN device_secret_hash bytea UNIQUE;

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'app_users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%phone_hash IS NOT NULL%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE app_users DROP CONSTRAINT %I', c); END IF;
END $$;

ALTER TABLE app_users ADD CONSTRAINT app_users_has_login
  CHECK (deleted_at IS NOT NULL OR phone_hash IS NOT NULL OR email IS NOT NULL OR device_secret_hash IS NOT NULL);
