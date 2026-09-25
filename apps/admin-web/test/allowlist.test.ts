import { describe, expect, it } from 'vitest';
import { compileRules, isAllowed } from '@happydrive/web-ui/bff/allowlist';
import { ADMIN_API_RULES } from '@/lib/allowlist';
import { canWriteWith, hasAdminRole } from '@/lib/admin-context';

const rules = compileRules(ADMIN_API_RULES);
const ID = '5a5a5a5a-1111-4222-8333-944444444444';

describe('運営Web の BFF 許可リスト', () => {
  it('運営 API は許可', () => {
    expect(isAllowed(rules, 'GET', '/admin/users')).toBe(true);
    expect(isAllowed(rules, 'POST', `/admin/users/${ID}/verification`)).toBe(true);
    expect(isAllowed(rules, 'POST', `/admin/users/${ID}/skills/forklift`)).toBe(true);
    expect(isAllowed(rules, 'POST', `/admin/assignments/${ID}/resolve-dispute`)).toBe(true);
    expect(isAllowed(rules, 'POST', '/admin/payouts/batches')).toBe(true);
    expect(isAllowed(rules, 'PUT', '/admin/matching/config')).toBe(true);
    expect(isAllowed(rules, 'GET', '/admin/audit-events/verify')).toBe(true);
    expect(isAllowed(rules, 'GET', `/evidence/${ID}/url`)).toBe(true);
    expect(isAllowed(rules, 'GET', `/admin/jobs/${ID}`)).toBe(true);
    expect(isAllowed(rules, 'GET', `/admin/organizations/${ID}`)).toBe(true);
  });
  it('企業・ドライバー向けの変更系や認証系は中継しない', () => {
    expect(isAllowed(rules, 'POST', '/organizations')).toBe(false);
    expect(isAllowed(rules, 'POST', `/organizations/${ID}/jobs`)).toBe(false);
    expect(isAllowed(rules, 'POST', `/assignments/${ID}/review`)).toBe(false);
    expect(isAllowed(rules, 'POST', `/jobs/${ID}/accept`)).toBe(false);
    expect(isAllowed(rules, 'POST', '/auth/refresh')).toBe(false);
    expect(isAllowed(rules, 'DELETE', '/me')).toBe(false);
    expect(isAllowed(rules, 'DELETE', `/admin/users/${ID}`)).toBe(false);
    expect(isAllowed(rules, 'POST', '/webhooks/payments/stripe')).toBe(false);
  });
});

describe('ロール', () => {
  it('運営ロールの判定と閲覧専用（監査）', () => {
    expect(hasAdminRole(['admin_auditor'])).toBe(true);
    expect(hasAdminRole(['org_member', 'worker'])).toBe(false);
    expect(hasAdminRole(undefined)).toBe(false);
    expect(canWriteWith(['admin_auditor'])).toBe(false);
    expect(canWriteWith(['admin_support'])).toBe(true);
    expect(canWriteWith(['admin_operator', 'admin_auditor'])).toBe(true);
  });
});
