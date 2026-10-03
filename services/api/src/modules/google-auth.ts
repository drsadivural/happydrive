import type { AppContext, HandlerMap, HdRequest } from '../context.js';
import { body, requireUser } from '../context.js';
import { withTx } from '../db/pool.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { conflict, forbidden, tooMany, unauthorized, unavailable } from '../lib/errors.js';
import { signMfaToken, issueTokens } from '../auth/tokens.js';
import { recordEvent } from '../lib/events.js';
import { loadMe } from './identity.js';

async function challenge(ctx: AppContext, req: HdRequest, link: boolean) {
  const platform = body<{ platform: 'web' | 'ios' }>(req).platform;
  const clientId = platform === 'ios' ? ctx.cfg.google?.iosClientId : ctx.cfg.google?.webClientId;
  if (!clientId) throw unavailable('google_unconfigured', 'Googleログインは準備中です。電話番号でログインしてください');
  const user = link ? requireUser(req) : undefined;
  if (user?.roles.some(r => r.startsWith('admin_'))) throw forbidden('管理者は多要素認証でログインしてください', 'google_mfa_required');
  const key = `google-challenge:${req.ip}`;
  const n = await ctx.db.query(`SELECT count(*)::int AS n FROM auth_attempts WHERE key=$1 AND created_at>now()-interval '1 hour'`, [key]);
  if (n.rows[0].n >= 20) throw tooMany('ログインをしばらく待ってから再試行してください');
  await ctx.db.query('INSERT INTO auth_attempts(key) VALUES ($1)', [key]);
  const nonce = randomToken();
  const expiresAt = new Date(Date.now() + 300_000);
  const r = await ctx.db.query(`INSERT INTO google_auth_challenges(nonce_hash,client_id,user_id,expires_at) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.cipher.blindIndex(nonce), clientId, user?.id ?? null, expiresAt]);
  // Clean expired challenges opportunistically, without retaining login attempts indefinitely here.
  await ctx.db.query(`DELETE FROM google_auth_challenges WHERE expires_at < now()-interval '1 day'`);
  return { challengeId: r.rows[0].id, nonce, clientId, expiresAt: expiresAt.toISOString() };
}

async function verify(ctx: AppContext, req: HdRequest, link: boolean) {
  const b = body<{ challengeId: string; idToken: string; deviceName?: string }>(req);
  const owner = link ? requireUser(req).id : null;
  const r = await ctx.db.query('SELECT * FROM google_auth_challenges WHERE id=$1', [b.challengeId]);
  const ch = r.rows[0];
  if (!ch || ch.user_id !== owner || ch.consumed_at || ch.expires_at <= new Date()) throw unauthorized('Googleログインの有効期限が切れました。もう一度お試しください', 'google_challenge_invalid');
  const claims = await ctx.googleVerifier(b.idToken, ch.client_id);
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.email_verified !== true ||
      typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || claims.email.length > 254 ||
      typeof claims.nonce !== 'string' || !safeEqual(ctx.cipher.blindIndex(claims.nonce), ch.nonce_hash)) {
    throw unauthorized('Googleアカウントの確認ができませんでした', 'google_token_invalid');
  }
  const subjectHash = ctx.cipher.blindIndex(`google:${claims.sub}`);
  const email = claims.email.toLowerCase();
  return withTx(ctx.db, async c => {
    // Serialize a subject across browsers/devices before creating or linking an identity.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [subjectHash.toString('hex')]);
    const consumed = await c.query(`UPDATE google_auth_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING id`, [b.challengeId]);
    if (!consumed.rowCount) throw unauthorized('このGoogleログインは使用済みです', 'google_challenge_invalid');
    let identity = (await c.query(`SELECT u.* FROM google_identities g JOIN app_users u ON u.id=g.user_id WHERE g.subject_hash=$1 FOR UPDATE OF u`, [subjectHash])).rows[0];
    if (identity?.deleted_at) {
      if (new Date(identity.deleted_at).getTime() > Date.now()-30*86400_000) throw forbidden('退会済みです。再登録はサポートへお問い合わせください', 'account_deleted');
      await c.query('DELETE FROM google_identities WHERE subject_hash=$1', [subjectHash]);
      identity = undefined;
    }
    let userId: string; let isNewUser = false;
    if (owner) {
      if (identity && identity.id !== owner) throw conflict('google_already_linked', 'このGoogleアカウントは別のアカウントに連携されています');
      const target = (await c.query('SELECT * FROM app_users WHERE id=$1 FOR UPDATE', [owner])).rows[0];
      if (!target || target.deleted_at || target.suspended_at) throw forbidden();
      if (target.roles.some((role: string) => role.startsWith('admin_'))) throw forbidden('管理者は多要素認証でログインしてください', 'google_mfa_required');
      const current = (await c.query('SELECT subject_hash FROM google_identities WHERE user_id=$1', [owner])).rows[0];
      if (current && !safeEqual(current.subject_hash, subjectHash)) throw conflict('google_already_linked', '別のGoogleアカウントが連携済みです');
      userId = owner;
      if (!identity) await c.query('INSERT INTO google_identities(subject_hash,user_id) VALUES ($1,$2)', [subjectHash, owner]);
      await recordEvent(c, { entityType: 'user', entityId: owner, eventType: 'google_linked', actor: { id: owner, role: 'self' } });
    } else if (identity) {
      if (identity.suspended_at) throw forbidden('アカウントは停止されています', 'account_suspended');
      // Google cannot bypass a pre-existing second factor or grant administration.
      if (identity.roles.some((role: string) => role.startsWith('admin_'))) throw forbidden('このアカウントはメールアドレスと多要素認証でログインしてください', 'google_mfa_required');
      if (identity.mfa_enabled) return {mfaToken:await signMfaToken(ctx,identity.id),mfaEnrollmentRequired:false};
      userId = identity.id;
    } else {
      if ((await c.query('SELECT 1 FROM app_users WHERE email=$1', [email])).rowCount) throw conflict('google_link_required', '同じメールのアカウントがあります。既存の方法でログイン後、設定からGoogleを連携してください');
      const u = await c.query(`INSERT INTO app_users(display_name,email,roles) VALUES ($1,$2,'{worker}') RETURNING id`, [typeof claims.name === 'string' ? claims.name.slice(0,60) : 'HappyDrive 利用者', email]);
      userId = u.rows[0].id; isNewUser = true;
      await c.query('INSERT INTO google_identities(subject_hash,user_id) VALUES ($1,$2)', [subjectHash, userId]);
      await recordEvent(c, { entityType: 'user', entityId: userId, eventType: 'registered_google', actor: { id: userId, role: 'self' } });
    }
    const tokens = await issueTokens(ctx, c, userId, b.deviceName);
    return { tokens, user: await loadMe(ctx, userId, c), isNewUser };
  });
}
export const googleAuthHandlers: HandlerMap = {
  googleChallenge: (ctx, req) => challenge(ctx, req, false),
  async googleVerify(ctx, req, reply) { const result = await verify(ctx, req, false); if ('mfaToken' in result) reply.code(202); return result; },
  googleLinkChallenge: (ctx, req) => challenge(ctx, req, true),
  googleLink: (ctx, req) => verify(ctx, req, true),
};
