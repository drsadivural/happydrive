import { describe, expect, it } from 'vitest';
import { compileRules, isAllowed } from '@happydrive/web-ui/bff/allowlist';
import { PARTNER_API_RULES } from '@/lib/allowlist';

const rules = compileRules(PARTNER_API_RULES);
const ORG = '0b0f6c1e-1111-4222-8333-944444444444';
const ID = '5a5a5a5a-1111-4222-8333-944444444444';

describe('企業ポータルの BFF 許可リスト', () => {
  it('企業向け API は許可', () => {
    expect(isAllowed(rules, 'GET', '/me')).toBe(true);
    expect(isAllowed(rules, 'GET', `/organizations/${ORG}/dashboard`)).toBe(true);
    expect(isAllowed(rules, 'POST', `/organizations/${ORG}/jobs`)).toBe(true);
    expect(isAllowed(rules, 'PUT', `/organizations/${ORG}/jobs/${ID}`)).toBe(true);
    expect(isAllowed(rules, 'POST', `/organizations/${ORG}/jobs/${ID}/submit`)).toBe(true);
    expect(isAllowed(rules, 'POST', `/assignments/${ID}/review`)).toBe(true);
    expect(isAllowed(rules, 'GET', `/assignments/${ID}/live-location`)).toBe(true);
    expect(isAllowed(rules, 'GET', `/evidence/${ID}/url`)).toBe(true);
    expect(isAllowed(rules, 'POST', '/reports')).toBe(true);
  });
  it('運営 API（/admin/*）は一切中継しない', () => {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
      expect(isAllowed(rules, m, '/admin/users')).toBe(false);
      expect(isAllowed(rules, m, `/admin/jobs/${ID}/review`)).toBe(false);
      expect(isAllowed(rules, m, '/admin/audit-events')).toBe(false);
    }
  });
  it('認証系・ドライバー専用 API・不要なメソッドは中継しない', () => {
    expect(isAllowed(rules, 'POST', '/auth/refresh')).toBe(false);
    expect(isAllowed(rules, 'POST', '/auth/web/login')).toBe(false);
    expect(isAllowed(rules, 'DELETE', '/me')).toBe(false);
    expect(isAllowed(rules, 'PUT', '/me/bank-account')).toBe(false);
    expect(isAllowed(rules, 'POST', `/jobs/${ID}/accept`)).toBe(false);
    expect(isAllowed(rules, 'POST', `/assignments/${ID}/events`)).toBe(false);
    expect(isAllowed(rules, 'POST', `/assignments/${ID}/location`)).toBe(false);
    expect(isAllowed(rules, 'DELETE', `/organizations/${ORG}`)).toBe(false);
    expect(isAllowed(rules, 'GET', '/delivery/stops')).toBe(false);
    expect(isAllowed(rules, 'POST', '/evidence/uploads')).toBe(false);
  });
});
