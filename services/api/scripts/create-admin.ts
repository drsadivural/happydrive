// Creates (or re-roles) an operator web account and prints its one-time TOTP enrollment URI.
// Usage: pnpm admin:create --email ops@example.jp --name "運営 太郎" --role admin_operator
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { FieldCipher, hashPassword } from '../src/lib/crypto.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'admin_operator' } } });
if (!values.email || !values.name) throw new Error('--email と --name は必須です');
if (!['admin_operator', 'admin_support', 'admin_auditor'].includes(values.role!)) throw new Error('--role は admin_operator / admin_support / admin_auditor');

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, 1);
const cipher = new FieldCipher(cfg.dataEncryptionKey, cfg.dataHmacKey);
const password = randomBytes(18).toString('base64url');
const secret = new OTPAuth.Secret({ size: 20 });
const email = values.email.toLowerCase();
await db.query(
  `INSERT INTO app_users(display_name, email, password_hash, totp_secret_ciphertext, mfa_enabled, roles) VALUES ($1,$2,$3,$4,false,ARRAY[$5])
   ON CONFLICT (email) DO UPDATE SET roles = ARRAY[$5], password_hash = EXCLUDED.password_hash, totp_secret_ciphertext = EXCLUDED.totp_secret_ciphertext, mfa_enabled = false`,
  [values.name, email, await hashPassword(password), cipher.encrypt(secret.base32), values.role],
);
await db.end();
console.warn(`作成しました: ${email} (${values.role})`);
console.warn(`初期パスワード（一度だけ表示）: ${password}`);
console.warn('初回ログイン時に認証アプリの登録（MFA）が求められます。');
