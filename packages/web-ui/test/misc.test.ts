import { describe, expect, it } from 'vitest';
import { escapeCsvCell, toCsv } from '../src/csv';
import { ApiError, errorMessage, toApiError } from '../src/errors';
import { IdempotencyKeeper, newIdempotencyKey, stableStringify } from '../src/idempotency';
import { safeNextPath } from '../src/nav';
import { buildCsp, imageOriginsFromEnv, securityHeaders } from '../src/bff/security-headers';

describe('Idempotency-Key', () => {
  it('16文字以上・接頭辞付き・毎回異なる', () => {
    const k = newIdempotencyKey('job-create');
    expect(k.startsWith('job-create-')).toBe(true);
    expect(k.length).toBeGreaterThanOrEqual(16);
    expect(k.length).toBeLessThanOrEqual(128);
    expect(k).not.toBe(newIdempotencyKey('job-create'));
  });
  it('結果不明の失敗後の同一内容の再送は同じキー', () => {
    const keeper = new IdempotencyKeeper('t');
    const k1 = keeper.keyFor({ a: 1, b: [1, 2] });
    keeper.failed(true);
    expect(keeper.keyFor({ b: [1, 2], a: 1 })).toBe(k1);
  });
  it('内容が変わった・成功した・確定的エラーの後は新しいキー', () => {
    const keeper = new IdempotencyKeeper('t');
    const k1 = keeper.keyFor({ a: 1 });
    expect(keeper.keyFor({ a: 2 })).not.toBe(k1);
    const k2 = keeper.keyFor({ a: 2 });
    keeper.succeeded();
    expect(keeper.keyFor({ a: 2 })).not.toBe(k2);
    const k3 = keeper.keyFor({ a: 3 });
    keeper.failed(false);
    expect(keeper.keyFor({ a: 3 })).not.toBe(k3);
  });
  it('stableStringify はキー順に依存しない', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(stableStringify({ a: undefined, b: 1 })).toBe(stableStringify({ b: 1 }));
  });
});

describe('CSV', () => {
  it('カンマ・改行・引用符をエスケープし、CRLF と BOM を付ける', () => {
    const csv = toCsv([
      ['案件', '金額'],
      ['買い物, 付き添い', 1200],
      ['"特急"\n便', null],
    ]);
    expect(csv).toBe('﻿案件,金額\r\n"買い物, 付き添い",1200\r\n"""特急""\n便",\r\n');
  });
  it('数式インジェクションを無害化する（数値の負数はそのまま）', () => {
    expect(escapeCsvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(escapeCsvCell('+81')).toBe("'+81");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell(-500)).toBe('-500');
  });
});

describe('errors', () => {
  it('Error スキーマの message をそのまま使う', () => {
    const e = toApiError(409, { code: 'capacity_full', message: '残枠がありません', requestId: 'req-1' });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('capacity_full');
    expect(errorMessage(e)).toBe('残枠がありません（問い合わせ番号: req-1）');
  });
  it('ボディが無い・不正なら状態コード別の日本語', () => {
    expect(toApiError(503, null).message).toBe('現在この機能は利用できません。');
    expect(toApiError(500, 'oops').message).toMatch(/サーバーでエラー/);
    expect(errorMessage(new TypeError('x'))).toMatch(/接続できません/);
  });
  it('再送すべき失敗の判定', () => {
    expect(new ApiError(0, 'n', 'm').retryable).toBe(true);
    expect(new ApiError(502, 'n', 'm').retryable).toBe(true);
    expect(new ApiError(409, 'n', 'm').retryable).toBe(false);
    expect(new ApiError(422, 'n', 'm').retryable).toBe(false);
  });
});

describe('safeNextPath', () => {
  it('同一オリジンの相対パスのみ', () => {
    expect(safeNextPath('/jobs?status=draft')).toBe('/jobs?status=draft');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath(null, '/dashboard')).toBe('/dashboard');
  });
});

describe('security headers', () => {
  it('本番の CSP は unsafe-eval なし・frame-ancestors none', () => {
    const csp = buildCsp({ isDev: false, imageOrigins: ['https://api.happydrive.jp'] });
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('img-src \'self\' data: blob: https://api.happydrive.jp');
    expect(csp).toContain("connect-src 'self'");
  });
  it('開発時のみ unsafe-eval（React の開発ビルド用）', () => {
    expect(buildCsp({ isDev: true })).toContain("'unsafe-eval'");
  });
  it('Referrer-Policy・X-Frame-Options・HSTS', () => {
    const h = Object.fromEntries(securityHeaders({ isDev: false }).map((x) => [x.key, x.value]));
    expect(h['Referrer-Policy']).toBe('same-origin');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Strict-Transport-Security']).toContain('max-age=');
  });
  it('画像の許可元を環境変数から作る', () => {
    expect(
      imageOriginsFromEnv({ HD_API_BASE_URL: 'https://api.happydrive.jp/v1', HD_EVIDENCE_IMAGE_ORIGINS: 'https://s3.example.com/bucket, bad' }),
    ).toEqual(['https://api.happydrive.jp', 'https://s3.example.com']);
  });
});

describe('security headers (http 検証環境)', () => {
  it('https=false なら upgrade-insecure-requests と HSTS を付けない', () => {
    expect(buildCsp({ isDev: false, https: false })).not.toContain('upgrade-insecure-requests');
    expect(buildCsp({ isDev: false })).toContain('upgrade-insecure-requests');
    expect(securityHeaders({ isDev: false, https: false }).some((h) => h.key === 'Strict-Transport-Security')).toBe(false);
  });
});
