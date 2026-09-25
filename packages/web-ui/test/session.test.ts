import { describe, expect, it } from 'vitest';
import { apiBaseUrl, clearedSessionCookies, cookieNames, csrfCookie, mfaCookie, resolveSecure, sessionCookies } from '../src/bff/session';

describe('session cookies', () => {
  it('本番は __Host- 接頭辞、開発はアプリ別接頭辞のみ', () => {
    expect(cookieNames({ cookiePrefix: 'hdp', secure: true })).toEqual({
      access: '__Host-hdp_at',
      refresh: '__Host-hdp_rt',
      mfa: '__Host-hdp_mfa',
      csrf: '__Host-hdp_csrf',
    });
    expect(cookieNames({ cookiePrefix: 'hda', secure: false }).refresh).toBe('hda_rt');
  });

  it('トークン Cookie は httpOnly・SameSite=Strict・期限付き', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const [at, rt] = sessionCookies(
      { cookiePrefix: 'hdp', secure: true },
      {
        accessToken: 'a',
        refreshToken: 'r',
        accessTokenExpiresAt: '2026-10-01T00:15:00Z',
        refreshTokenExpiresAt: '2026-10-31T00:00:00Z',
      },
      now,
    );
    expect(at).toMatchObject({ name: '__Host-hdp_at', httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 15 * 60 - 30 });
    expect(rt).toMatchObject({ name: '__Host-hdp_rt', httpOnly: true, maxAge: 30 * 24 * 3600 });
  });

  it('期限切れ・不正な期限でも負の maxAge にならない', () => {
    const [at] = sessionCookies(
      { cookiePrefix: 'x', secure: false },
      { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: '2000-01-01T00:00:00Z', refreshTokenExpiresAt: 'bad' },
      Date.parse('2026-10-01T00:00:00Z'),
    );
    expect(at!.maxAge).toBe(0);
  });

  it('ログアウトで全トークン Cookie を消す', () => {
    const cleared = clearedSessionCookies({ cookiePrefix: 'hdp', secure: false });
    expect(cleared.map((c) => c.name)).toEqual(['hdp_at', 'hdp_rt', 'hdp_mfa']);
    expect(cleared.every((c) => c.maxAge === 0 && c.value === '')).toBe(true);
  });

  it('MFA Cookie は5分・httpOnly、CSRF Cookie は JS から読める', () => {
    expect(mfaCookie({ cookiePrefix: 'hdp', secure: false }, 't')).toMatchObject({ maxAge: 300, httpOnly: true });
    expect(csrfCookie({ cookiePrefix: 'hdp', secure: false }, 't')).toMatchObject({ httpOnly: false, sameSite: 'strict' });
  });

  it('Secure 判定と API ベースURL', () => {
    expect(resolveSecure({ NODE_ENV: 'production' })).toBe(true);
    expect(resolveSecure({ NODE_ENV: 'development' })).toBe(false);
    expect(resolveSecure({ NODE_ENV: 'production', HD_COOKIE_SECURE: 'false' })).toBe(false);
    expect(apiBaseUrl({})).toBe('http://localhost:8080/v1');
    expect(apiBaseUrl({ HD_API_BASE_URL: 'https://api.happydrive.jp/v1/' })).toBe('https://api.happydrive.jp/v1');
  });
});
