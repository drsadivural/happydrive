import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type pg from 'pg';
import type { AppContext, AuthUser, Role } from '../context.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { recordEvent } from '../lib/events.js';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

export async function signAccessToken(ctx: AppContext, userId: string, tokenVersion: number): Promise<{ token: string; exp: Date }> {
  const exp = new Date(Date.now() + ctx.cfg.accessTokenTtlSec * 1000);
  const token = await new SignJWT({ tv: tokenVersion, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(exp.getTime() / 1000))
    .setIssuer('happydrive')
    .sign(ctx.cfg.jwtSecret);
  return { token, exp };
}

export async function issueTokens(ctx: AppContext, c: pg.PoolClient | pg.Pool, userId: string, deviceName?: string, familyId = randomUUID()): Promise<Tokens> {
  const u = await c.query<{ token_version: number }>('SELECT token_version FROM app_users WHERE id = $1', [userId]);
  const access = await signAccessToken(ctx, userId, u.rows[0]!.token_version);
  const refresh = randomToken(32);
  const refreshExp = new Date(Date.now() + ctx.cfg.refreshTokenTtlSec * 1000);
  await c.query(
    'INSERT INTO refresh_tokens(user_id, family_id, token_hash, device_name, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [userId, familyId, sha256(refresh), deviceName ?? null, refreshExp],
  );
  return {
    accessToken: access.token,
    refreshToken: refresh,
    accessTokenExpiresAt: access.exp.toISOString(),
    refreshTokenExpiresAt: refreshExp.toISOString(),
  };
}

/** Rotates a refresh token. Re-use of an already-rotated token revokes the whole family (token theft signal). */
export async function rotateRefreshToken(ctx: AppContext, refresh: string): Promise<Tokens> {
  const c = await ctx.db.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      `SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at, rt.used_at, rt.revoked_at, rt.device_name, u.deleted_at
       FROM refresh_tokens rt JOIN app_users u ON u.id = rt.user_id WHERE rt.token_hash = $1 FOR UPDATE OF rt`,
      [sha256(refresh)],
    );
    const t = r.rows[0];
    if (!t || t.revoked_at || t.deleted_at || t.expires_at < new Date()) {
      await c.query('ROLLBACK');
      throw unauthorized('再度ログインしてください', 'session_expired');
    }
    if (t.used_at) {
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [t.family_id]);
      await recordEvent(c, { entityType: 'user', entityId: t.user_id, eventType: 'refresh_token_reuse_detected', actor: { id: t.user_id, role: 'system' } });
      await c.query('COMMIT');
      throw unauthorized('セキュリティのため再度ログインしてください', 'session_revoked');
    }
    await c.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [t.id]);
    const tokens = await issueTokens(ctx, c, t.user_id, t.device_name, t.family_id);
    await c.query('COMMIT');
    return tokens;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export async function revokeRefreshToken(ctx: AppContext, refresh: string, userId: string) {
  await ctx.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL', [sha256(refresh), userId]);
}

/** Verifies the bearer token and loads the live user row (deleted/rotated users are rejected immediately). */
export async function authenticate(ctx: AppContext, authorization: string | undefined): Promise<AuthUser> {
  if (!authorization?.startsWith('Bearer ')) throw unauthorized();
  let sub: string;
  let tv: number;
  try {
    const { payload } = await jwtVerify(authorization.slice(7), ctx.cfg.jwtSecret, { issuer: 'happydrive', algorithms: ['HS256'] });
    if (payload.typ !== 'access' || !payload.sub) throw new Error('wrong token type');
    sub = payload.sub;
    tv = Number(payload.tv);
  } catch {
    throw unauthorized('セッションの有効期限が切れました', 'token_invalid');
  }
  const r = await ctx.db.query(
    'SELECT id, display_name, roles, verification_status, suspended_at, token_version, deleted_at, email FROM app_users WHERE id = $1',
    [sub],
  );
  const u = r.rows[0];
  if (!u || u.deleted_at || u.token_version !== tv) throw unauthorized('再度ログインしてください', 'session_revoked');
  return {
    id: u.id,
    displayName: u.display_name,
    roles: u.roles as Role[],
    verificationStatus: u.verification_status,
    suspended: !!u.suspended_at,
    isWebUser: !!u.email,
  };
}

export async function signMfaToken(ctx: AppContext, userId: string): Promise<string> {
  return new SignJWT({ typ: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer('happydrive')
    .sign(ctx.cfg.jwtSecret);
}

export async function verifyMfaToken(ctx: AppContext, token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, ctx.cfg.jwtSecret, { issuer: 'happydrive', algorithms: ['HS256'] });
    if (payload.typ !== 'mfa' || !payload.sub) throw new Error('wrong type');
    return payload.sub;
  } catch {
    throw unauthorized('認証の有効期限が切れました。最初からやり直してください', 'mfa_token_invalid');
  }
}
