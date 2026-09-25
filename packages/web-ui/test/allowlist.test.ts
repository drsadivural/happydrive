import { describe, expect, it } from 'vitest';
import { compileRules, isAllowed, normalizeApiPath } from '../src/bff/allowlist';

const rules = compileRules([
  { methods: ['GET'], path: '/me' },
  { methods: ['GET', 'POST'], path: '/organizations/{organizationId}/jobs' },
  { methods: ['POST'], path: '/assignments/{assignmentId}/review' },
]);

describe('normalizeApiPath', () => {
  it('セグメントを連結する', () => {
    expect(normalizeApiPath(['organizations', 'abc-123', 'jobs'])).toBe('/organizations/abc-123/jobs');
  });
  it('パストラバーサル・空・許可外文字を拒否する', () => {
    expect(normalizeApiPath(['organizations', '..', 'admin'])).toBeNull();
    expect(normalizeApiPath(['.'])).toBeNull();
    expect(normalizeApiPath([''])).toBeNull();
    expect(normalizeApiPath([])).toBeNull();
    expect(normalizeApiPath(undefined)).toBeNull();
    expect(normalizeApiPath(['admin/users'])).toBeNull();
    expect(normalizeApiPath(['a%2Fb'])).toBeNull();
    expect(normalizeApiPath(['a?b'])).toBeNull();
    expect(normalizeApiPath(['a#b'])).toBeNull();
    expect(normalizeApiPath(['x'.repeat(129)])).toBeNull();
  });
});

describe('isAllowed', () => {
  it('メソッドとパスの両方が一致した場合のみ許可', () => {
    expect(isAllowed(rules, 'GET', '/me')).toBe(true);
    expect(isAllowed(rules, 'get', '/me')).toBe(true);
    expect(isAllowed(rules, 'DELETE', '/me')).toBe(false);
    expect(isAllowed(rules, 'POST', '/organizations/0b0f/jobs')).toBe(true);
    expect(isAllowed(rules, 'PUT', '/organizations/0b0f/jobs')).toBe(false);
  });
  it('パラメータは1セグメントのみ（余分な階層・前方一致は不可）', () => {
    expect(isAllowed(rules, 'GET', '/organizations/a/b/jobs')).toBe(false);
    expect(isAllowed(rules, 'GET', '/organizations/a/jobs/extra')).toBe(false);
    expect(isAllowed(rules, 'GET', '/me/profile')).toBe(false);
    expect(isAllowed(rules, 'GET', '/mex')).toBe(false);
  });
  it('パターン内の記号は正規表現として解釈しない', () => {
    const r = compileRules([{ methods: ['GET'], path: '/a.b' }]);
    expect(isAllowed(r, 'GET', '/a.b')).toBe(true);
    expect(isAllowed(r, 'GET', '/aXb')).toBe(false);
  });
});
