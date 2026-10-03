import { randomInt } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { HandlerMap, AppContext } from '../context.js';
import { body, requireUser } from '../context.js';
import { withTx } from '../db/pool.js';
import { hashPassword, safeEqual, verifyPassword } from '../lib/crypto.js';
import { AppError, conflict, forbidden, tooMany, unauthorized } from '../lib/errors.js';
import { recordEvent } from '../lib/events.js';
import { normalizePhone } from '../lib/phone.js';
import { issueTokens, revokeRefreshToken, rotateRefreshToken, signMfaToken, verifyMfaToken } from '../auth/tokens.js';
import { loadMe } from './identity.js';

const OTP_TTL_SEC = 300;
const OTP_RESEND_SEC = 60;
const OTP_MAX_PER_PHONE_HOUR = 5;
const OTP_MAX_PER_IP_HOUR = 20;
const OTP_MAX_ATTEMPTS = 5;
const WEB_LOGIN_MAX_FAILS = 10;
const DEVICE_SIGNUPS_PER_IP_HOUR = 20;
const WEB_LOGIN_WINDOW_MIN = 15;

const codeHash = (ctx: AppContext, phoneHash: Buffer, code: string) => ctx.cipher.blindIndex(`otp:${phoneHash.toString('hex')}:${code}`);

async function countAttempts(ctx: AppContext, key: string, minutes: number): Promise<number> {
  const r = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_attempts WHERE key = $1 AND created_at > now() - make_interval(mins => $2)`,
    [key, minutes],
  );
  return r.rows[0]!.n;
}

function totpFor(secretBase32: string, label: string) {
  return new OTPAuth.TOTP({ issuer: 'HappyDrive', label, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secretBase32) });
}

async function verifyPhoneProof(ctx: AppContext, phone: string, code: string) {
  const phoneHash = ctx.cipher.blindIndex(phone);
  const isReview = !!ctx.cfg.reviewAccount && normalizePhone(ctx.cfg.reviewAccount.phone) === phone;
  if (isReview) {
    if (!safeEqual(code, ctx.cfg.reviewAccount!.code)) throw unauthorized('確認コードが正しくありません', 'otp_invalid');
  } else {
    const ok = await withTx(ctx.db, async (c) => {
    const r = await c.query(
      `SELECT id, code_hash, attempts, expires_at FROM otp_challenges
       WHERE phone_hash = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [phoneHash],
    );
    const ch = r.rows[0];
    if (!ch) return 'missing';
    if (ch.expires_at < new Date()) return 'expired';
    if (ch.attempts >= OTP_MAX_ATTEMPTS) return 'locked';
    if (!safeEqual(ch.code_hash, codeHash(ctx, phoneHash, code))) {
      await c.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
      return 'invalid';
    }
    await c.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [ch.id]);
    return 'ok';
    });
    if (ok === 'expired' || ok === 'missing') throw unauthorized('確認コードの有効期限が切れました。再送信してください', 'otp_expired');
    if (ok === 'locked') throw tooMany('入力回数の上限に達しました。確認コードを再送信してください');
    if (ok === 'invalid') throw unauthorized('確認コードが正しくありません', 'otp_invalid');
  }

}

export const authHandlers: HandlerMap = {
  async requestOtp(ctx, req, reply) {
    const phone = normalizePhone(body<{ phone: string }>(req).phone);
    const phoneHash = ctx.cipher.blindIndex(phone);
    const ip = req.ip;

    if (ctx.cfg.reviewAccount && normalizePhone(ctx.cfg.reviewAccount.phone) === phone) {
      reply.code(202);
      return { expiresAt: new Date(Date.now() + OTP_TTL_SEC * 1000).toISOString(), resendAfterSeconds: OTP_RESEND_SEC };
    }

    const tomb = await ctx.db.query(`SELECT 1 FROM deleted_identities WHERE phone_hash = $1 AND deleted_at > now() - interval '30 days'`, [phoneHash]);
    if (tomb.rowCount) throw forbidden('この電話番号のアカウントは退会済みです。再登録はサポートへお問い合わせください', 'account_deleted');

    const stats = await ctx.db.query(
      `SELECT
         count(*) FILTER (WHERE phone_hash = $1)::int AS per_phone,
         count(*) FILTER (WHERE ip = $2)::int AS per_ip,
         max(created_at) FILTER (WHERE phone_hash = $1) AS last_sent
       FROM otp_challenges WHERE created_at > now() - interval '1 hour' AND (phone_hash = $1 OR ip = $2)`,
      [phoneHash, ip],
    );
    const s = stats.rows[0];
    if (s.last_sent && Date.now() - new Date(s.last_sent).getTime() < OTP_RESEND_SEC * 1000) {
      const wait = Math.ceil((OTP_RESEND_SEC * 1000 - (Date.now() - new Date(s.last_sent).getTime())) / 1000);
      throw tooMany(`再送信は${wait}秒後にお試しください`, { retryAfterSeconds: wait });
    }
    if (s.per_phone >= OTP_MAX_PER_PHONE_HOUR || s.per_ip >= OTP_MAX_PER_IP_HOUR) {
      throw tooMany('確認コードの送信回数が上限に達しました。1時間ほど時間をおいてお試しください');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + OTP_TTL_SEC * 1000);
    await ctx.db.query('INSERT INTO otp_challenges(phone_hash, code_hash, ip, expires_at) VALUES ($1,$2,$3,$4)', [
      phoneHash, codeHash(ctx, phoneHash, code), ip, expiresAt,
    ]);
    await ctx.sms.sendOtp(phone, code);
    reply.code(202);
    return { expiresAt: expiresAt.toISOString(), resendAfterSeconds: OTP_RESEND_SEC };
  },

  async verifyOtp(ctx, req) {
    const b = body<{ phone: string; code: string; deviceName?: string }>(req);
    const phone = normalizePhone(b.phone);
    const phoneHash = ctx.cipher.blindIndex(phone);

    await verifyPhoneProof(ctx, phone, b.code);

    return withTx(ctx.db, async (c) => {
      const tomb = await c.query(`SELECT 1 FROM deleted_identities WHERE phone_hash = $1 AND deleted_at > now() - interval '30 days'`, [phoneHash]);
      if (tomb.rowCount) throw forbidden('この電話番号のアカウントは退会済みです。再登録はサポートへお問い合わせください', 'account_deleted');
      const existing = await c.query('SELECT id, roles, mfa_enabled, suspended_at, deleted_at FROM app_users WHERE phone_hash = $1', [phoneHash]);
      let userId: string;
      let isNewUser = false;
      if (existing.rows[0]) {
        const account = existing.rows[0];
        if (account.deleted_at || account.suspended_at) throw forbidden('このアカウントは利用できません', 'account_unavailable');
        if (account.mfa_enabled || account.roles.some((role:string)=>role.startsWith('admin_'))) throw forbidden('メールアドレスと多要素認証でログインしてください', 'mfa_required');
        userId = account.id;
        if (!existing.rows[0].roles.includes('worker')) {
          await c.query(`UPDATE app_users SET roles = array_append(roles, 'worker') WHERE id = $1`, [userId]);
        }
      } else {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO app_users(display_name, phone_ciphertext, phone_hash, roles, preferences)
           VALUES ('ドライバー', $1, $2, '{worker}', $3) RETURNING id`,
          [ctx.cipher.encrypt(phone), phoneHash, { useLocationForMatching: true, useHistoryForMatching: true, notifyNewJobs: true, notifyMessages: true, showRatingToOrganizations: true, maxDistanceKm: 10 }],
        );
        userId = ins.rows[0]!.id;
        isNewUser = true;
        await recordEvent(c, { entityType: 'user', entityId: userId, eventType: 'registered', actor: { id: userId, role: 'worker' } });
      }
      const tokens = await issueTokens(ctx, c, userId, b.deviceName);
      return { tokens, user: await loadMe(ctx, userId, c), isNewUser };
    });
  },

  async linkPhone(ctx, req) {
    const user = requireUser(req);
    const b = body<{ phone: string; code: string; deviceName?: string }>(req);
    const phone = normalizePhone(b.phone);
    await verifyPhoneProof(ctx, phone, b.code);
    const hash = ctx.cipher.blindIndex(phone);
    return withTx(ctx.db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [hash.toString('hex')]);
      const tomb = await c.query(`SELECT 1 FROM deleted_identities WHERE phone_hash=$1 AND deleted_at>now()-interval '30 days'`, [hash]);
      if (tomb.rowCount) throw forbidden('退会済みの電話番号です', 'account_deleted');
      const owner = (await c.query('SELECT id FROM app_users WHERE phone_hash=$1', [hash])).rows[0];
      if (owner && owner.id !== user.id) throw conflict('phone_already_linked', 'この電話番号は別のアカウントで登録済みです。既存の方法でログインしてください');
      const current = (await c.query('SELECT phone_hash,deleted_at,suspended_at FROM app_users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      if (!current || current.deleted_at || current.suspended_at) throw forbidden('このアカウントは利用できません', 'account_unavailable');
      if (current.phone_hash && !safeEqual(current.phone_hash,hash)) throw conflict('phone_already_linked', '別の電話番号が登録済みです。変更はサポートへお問い合わせください');
      await c.query('UPDATE app_users SET phone_hash=$2,phone_ciphertext=$3 WHERE id=$1', [user.id,hash,ctx.cipher.encrypt(phone)]);
      await recordEvent(c, { entityType:'user',entityId:user.id,eventType:'phone_linked',actor:{id:user.id,role:'self'} });
      return { tokens: await issueTokens(ctx,c,user.id,b.deviceName), user:await loadMe(ctx,user.id,c), isNewUser:false };
    });
  },

  async deviceLogin(ctx, req) {
    const b = body<{ deviceSecret: string; deviceName?: string }>(req);
    const hash = ctx.cipher.blindIndex(`device:${b.deviceSecret}`);
    const existing = await ctx.db.query('SELECT id FROM app_users WHERE device_secret_hash = $1 AND deleted_at IS NULL', [hash]);
    if (!existing.rows[0]) {
      const key = `device-signup-ip:${req.ip}`;
      if ((await countAttempts(ctx, key, 60)) >= DEVICE_SIGNUPS_PER_IP_HOUR) throw tooMany('短時間に多くの登録が行われました。時間をおいてお試しください');
      await ctx.db.query('INSERT INTO auth_attempts(key) VALUES ($1)', [key]);
    }
    return withTx(ctx.db, async (c) => {
      let userId = existing.rows[0]?.id as string | undefined;
      let isNewUser = false;
      if (!userId) {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO app_users(display_name, device_secret_hash, roles, preferences) VALUES ('ドライバー', $1, '{worker}', $2)
           ON CONFLICT (device_secret_hash) DO UPDATE SET updated_at = now() RETURNING id, (xmax = 0) AS inserted`,
          [hash, { useLocationForMatching: true, useHistoryForMatching: true, notifyNewJobs: true, notifyMessages: true, showRatingToOrganizations: true, maxDistanceKm: 10 }],
        );
        userId = ins.rows[0]!.id;
        isNewUser = (ins.rows[0] as any).inserted;
        if (isNewUser) await recordEvent(c, { entityType: 'user', entityId: userId, eventType: 'registered_device', actor: { id: userId, role: 'worker' } });
      }
      const tokens = await issueTokens(ctx, c, userId, b.deviceName);
      return { tokens, user: await loadMe(ctx, userId, c), isNewUser };
    });
  },

  async refreshTokens(ctx, req) {
    return rotateRefreshToken(ctx, body<{ refreshToken: string }>(req).refreshToken);
  },

  async logout(ctx, req, reply) {
    const u = requireUser(req);
    await revokeRefreshToken(ctx, body<{ refreshToken: string }>(req).refreshToken, u.id);
    reply.code(204);
  },

  async webSignup(ctx, req, reply) {
    const b = body<{ email: string; password: string; displayName: string }>(req);
    const email = b.email.trim().toLowerCase();
    if ((await countAttempts(ctx, `signup-ip:${req.ip}`, 60)) >= 10) throw tooMany('短時間に多くの登録が行われました。時間をおいてお試しください');
    await ctx.db.query('INSERT INTO auth_attempts(key) VALUES ($1)', [`signup-ip:${req.ip}`]);
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const pw = await hashPassword(b.password);
    const r = await ctx.db.query<{ id: string }>(
      `INSERT INTO app_users(display_name, email, password_hash, totp_secret_ciphertext, roles)
       VALUES ($1,$2,$3,$4,'{}') ON CONFLICT (email) DO NOTHING RETURNING id`,
      [b.displayName, email, pw, ctx.cipher.encrypt(secret)],
    );
    if (!r.rows[0]) throw conflict('email_taken', 'このメールアドレスは既に登録されています');
    reply.code(201);
    return { mfaToken: await signMfaToken(ctx, r.rows[0].id), mfaEnrollmentRequired: true, totpUri: totpFor(secret, email).toString() };
  },

  async webLogin(ctx, req) {
    const b = body<{ email: string; password: string }>(req);
    const email = b.email.trim().toLowerCase();
    if ((await countAttempts(ctx, `login:${email}`, WEB_LOGIN_WINDOW_MIN)) >= WEB_LOGIN_MAX_FAILS ||
        (await countAttempts(ctx, `login-ip:${req.ip}`, WEB_LOGIN_WINDOW_MIN)) >= WEB_LOGIN_MAX_FAILS * 5) {
      throw tooMany('ログイン失敗が続いたため一時的にロックしました。15分後にお試しください');
    }
    const r = await ctx.db.query('SELECT id, password_hash, totp_secret_ciphertext, mfa_enabled, deleted_at FROM app_users WHERE email = $1', [email]);
    const u = r.rows[0];
    const valid = u && !u.deleted_at && u.password_hash && (await verifyPassword(b.password, u.password_hash));
    if (!valid) {
      await ctx.db.query('INSERT INTO auth_attempts(key) VALUES ($1), ($2)', [`login:${email}`, `login-ip:${req.ip}`]);
      throw unauthorized('メールアドレスまたはパスワードが正しくありません', 'invalid_credentials');
    }
    let totpUri: string | undefined;
    if (!u.mfa_enabled) {
      // Enrollment not finished: (re)issue a fresh secret and show it once.
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      await ctx.db.query('UPDATE app_users SET totp_secret_ciphertext = $2 WHERE id = $1', [u.id, ctx.cipher.encrypt(secret)]);
      totpUri = totpFor(secret, email).toString();
    }
    return { mfaToken: await signMfaToken(ctx, u.id), mfaEnrollmentRequired: !u.mfa_enabled, totpUri };
  },

  async webMfaVerify(ctx, req) {
    const b = body<{ mfaToken: string; code: string }>(req);
    const userId = await verifyMfaToken(ctx, b.mfaToken);
    const key = `mfa:${userId}`;
    if ((await countAttempts(ctx, key, WEB_LOGIN_WINDOW_MIN)) >= WEB_LOGIN_MAX_FAILS) throw tooMany('認証コードの入力回数が上限に達しました。15分後にお試しください');
    const result = await withTx(ctx.db, async (c) => {
      const r = await c.query('SELECT email, totp_secret_ciphertext, last_totp_step, mfa_enabled, deleted_at FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
      const u = r.rows[0];
      if (!u || u.deleted_at || !u.totp_secret_ciphertext) throw unauthorized();
      const totp = totpFor(ctx.cipher.decrypt(u.totp_secret_ciphertext), u.email);
      const delta = totp.validate({ token: b.code, window: 1 });
      const step = Math.floor(Date.now() / 30_000) + (delta ?? 0);
      if (delta === null || (u.last_totp_step !== null && step <= Number(u.last_totp_step))) {
        await ctx.db.query('INSERT INTO auth_attempts(key) VALUES ($1)', [key]);
        return null;
      }
      await c.query('UPDATE app_users SET last_totp_step = $2, mfa_enabled = true WHERE id = $1', [userId, step]);
      if (!u.mfa_enabled) await recordEvent(c, { entityType: 'user', entityId: userId, eventType: 'mfa_enrolled', actor: { id: userId, role: 'web' } });
      const tokens = await issueTokens(ctx, c, userId, 'web');
      return { tokens, user: await loadMe(ctx, userId, c), isNewUser: false };
    });
    if (!result) throw new AppError(401, 'mfa_invalid', '認証コードが正しくありません');
    return result;
  },
};

