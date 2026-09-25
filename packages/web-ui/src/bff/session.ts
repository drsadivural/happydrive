/**
 * セッション Cookie の名前と属性。トークンは httpOnly Cookie にのみ保存し、ブラウザの JS からは読めない。
 * 本番（secure=true）では `__Host-` 接頭辞で Domain/Path の差し替えを防ぐ。
 * localhost ではポート違いの別アプリと Cookie を共有するため、アプリごとに接頭辞を分ける。
 */
export interface SessionConfig {
  /** 例 'hdp'（企業ポータル） / 'hda'（運営） */
  cookiePrefix: string;
  secure: boolean;
}

export interface CookieNames {
  access: string;
  refresh: string;
  mfa: string;
  csrf: string;
}

export function cookieNames(cfg: SessionConfig): CookieNames {
  const p = `${cfg.secure ? '__Host-' : ''}${cfg.cookiePrefix}`;
  return { access: `${p}_at`, refresh: `${p}_rt`, mfa: `${p}_mfa`, csrf: `${p}_csrf` };
}

/** HD_COOKIE_SECURE=true/false で明示、未指定なら production で Secure */
export function resolveSecure(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.HD_COOKIE_SECURE;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return env.NODE_ENV === 'production';
}

export function sessionConfig(cookiePrefix: string, env: Record<string, string | undefined> = process.env): SessionConfig {
  return { cookiePrefix, secure: resolveSecure(env) };
}

export interface CookieSpec {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  path: '/';
  maxAge: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

function secondsUntil(iso: string, now: number, fallback: number, max: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return fallback;
  return Math.max(0, Math.min(max, Math.floor((t - now) / 1000)));
}

/** アクセストークン Cookie は有効期限と同時に消えるので、Cookie が無ければ事前にリフレッシュできる。 */
export function sessionCookies(cfg: SessionConfig, tokens: TokenSet, now = Date.now()): CookieSpec[] {
  const names = cookieNames(cfg);
  const base = { httpOnly: true, secure: cfg.secure, sameSite: 'strict' as const, path: '/' as const };
  return [
    // 期限の30秒前に Cookie を失効させ、期限切れトークンを送らない
    { ...base, name: names.access, value: tokens.accessToken, maxAge: Math.max(0, secondsUntil(tokens.accessTokenExpiresAt, now, 300, 60 * 60 * 24) - 30) },
    { ...base, name: names.refresh, value: tokens.refreshToken, maxAge: secondsUntil(tokens.refreshTokenExpiresAt, now, 60 * 60 * 24, 60 * 60 * 24 * 60) },
  ];
}

export function clearedSessionCookies(cfg: SessionConfig): CookieSpec[] {
  const names = cookieNames(cfg);
  const base = { httpOnly: true, secure: cfg.secure, sameSite: 'strict' as const, path: '/' as const, value: '', maxAge: 0 };
  return [
    { ...base, name: names.access },
    { ...base, name: names.refresh },
    { ...base, name: names.mfa },
  ];
}

export function mfaCookie(cfg: SessionConfig, mfaToken: string): CookieSpec {
  return { name: cookieNames(cfg).mfa, value: mfaToken, httpOnly: true, secure: cfg.secure, sameSite: 'strict', path: '/', maxAge: 300 };
}

/** CSRF Cookie は JS から読む必要があるため httpOnly ではない（値自体は秘密情報ではない） */
export function csrfCookie(cfg: SessionConfig, token: string): CookieSpec {
  return { name: cookieNames(cfg).csrf, value: token, httpOnly: false, secure: cfg.secure, sameSite: 'strict', path: '/', maxAge: 60 * 60 * 24 * 7 };
}

export function apiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.HD_API_BASE_URL?.trim() || 'http://localhost:8080/v1';
  return raw.replace(/\/+$/, '');
}
