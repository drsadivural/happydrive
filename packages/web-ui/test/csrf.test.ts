import { describe, expect, it } from 'vitest';
import { checkCsrf, generateCsrfToken, isMutatingMethod, timingSafeEqualString } from '../src/bff/csrf';

const token = 'abcdefghijklmnopqrstuvwxyz012345';

describe('CSRF', () => {
  it('参照系は検査しない', () => {
    expect(checkCsrf({ method: 'GET', headerToken: null, cookieToken: null })).toEqual({ ok: true });
    expect(isMutatingMethod('get')).toBe(false);
    expect(isMutatingMethod('delete')).toBe(true);
  });
  it('変更系はヘッダーと Cookie の一致が必要', () => {
    expect(checkCsrf({ method: 'POST', headerToken: token, cookieToken: token })).toEqual({ ok: true });
    expect(checkCsrf({ method: 'POST', headerToken: null, cookieToken: token })).toEqual({ ok: false, reason: 'missing_token' });
    expect(checkCsrf({ method: 'PUT', headerToken: token, cookieToken: undefined })).toEqual({ ok: false, reason: 'missing_token' });
    expect(checkCsrf({ method: 'DELETE', headerToken: `${token}x`, cookieToken: token })).toEqual({ ok: false, reason: 'token_mismatch' });
    expect(checkCsrf({ method: 'PATCH', headerToken: 'short', cookieToken: 'short' })).toEqual({ ok: false, reason: 'missing_token' });
  });
  it('別サイトからのリクエストを拒否する', () => {
    expect(checkCsrf({ method: 'POST', headerToken: token, cookieToken: token, secFetchSite: 'cross-site' })).toEqual({ ok: false, reason: 'cross_site' });
    expect(checkCsrf({ method: 'POST', headerToken: token, cookieToken: token, secFetchSite: 'same-site' })).toEqual({ ok: false, reason: 'cross_site' });
    expect(
      checkCsrf({ method: 'POST', headerToken: token, cookieToken: token, origin: 'https://evil.example', host: 'partner.happydrive.jp' }),
    ).toEqual({ ok: false, reason: 'origin_mismatch' });
    expect(
      checkCsrf({ method: 'POST', headerToken: token, cookieToken: token, origin: 'https://partner.happydrive.jp', host: 'partner.happydrive.jp', secFetchSite: 'same-origin' }),
    ).toEqual({ ok: true });
    expect(checkCsrf({ method: 'POST', headerToken: token, cookieToken: token, origin: 'null', host: 'a.example' })).toEqual({ ok: false, reason: 'origin_mismatch' });
  });
  it('トークン生成は十分な長さでランダム', () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('定数時間比較', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
  });
});
