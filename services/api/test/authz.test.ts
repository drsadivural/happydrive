// ID-02: organisation boundaries and IDOR resistance; admin capability separation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, approvedOrg, call, publishedJob, setupApp, uploadEvidence, verifiedWorker, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => { env = await setupApp(); });
afterAll(async () => env.close());

describe('ID-02 organisation boundary', () => {
  it('other organisations cannot read jobs, assignments, evidence, invoices or live location by id', async () => {
    const orgA = await approvedOrg(env);
    const orgB = await approvedOrg(env);
    const job = await publishedJob(env, orgA);
    const w = await verifiedWorker(env);
    const acc = await call(env, w, 'POST', `/jobs/${job.id}/accept`, { termsHash: job.termsHash });
    expect(acc.status).toBe(201);
    const aid = acc.body.id;
    const ev = await uploadEvidence(env, w, { assignmentId: aid });
    expect(ev.complete.status).toBe(200);

    const probes: [string, string][] = [
      ['GET', `/organizations/${orgA.orgId}`],
      ['GET', `/organizations/${orgA.orgId}/jobs/${job.id}`],
      ['GET', `/organizations/${orgA.orgId}/jobs/${job.id}/assignments`],
      ['GET', `/organizations/${orgA.orgId}/invoices`],
      ['GET', `/organizations/${orgB.orgId}/jobs/${job.id}`],
      ['GET', `/assignments/${aid}`],
      ['GET', `/assignments/${aid}/messages`],
      ['GET', `/assignments/${aid}/live-location`],
      ['GET', `/evidence/${ev.id}/url`],
    ];
    for (const [m, url] of probes) {
      const r = await call(env, orgB.owner, m, url);
      expect([403, 404], `${m} ${url}`).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toContain('山下町');
    }
    const review = await call(env, orgB.owner, 'POST', `/assignments/${aid}/review`, { decision: 'approved' });
    expect([403, 404]).toContain(review.status);
    // The owning organisation can.
    expect((await call(env, orgA.owner, 'GET', `/assignments/${aid}`)).status).toBe(200);
  });

  it('workers cannot read other workers’ stops or assignments', async () => {
    const w1 = await verifiedWorker(env);
    const w2 = await verifiedWorker(env);
    const s = await call(env, w1, 'POST', '/delivery/stops', { address: '横浜市中区本町1-1', scheduledDate: '2026-10-01' });
    expect(s.status).toBe(201);
    expect((await call(env, w2, 'GET', `/delivery/stops/${s.body.id}`)).status).toBe(404);
    expect((await call(env, w2, 'GET', `/delivery/stops/${s.body.id}/contact`)).status).toBe(404);
    const list = await call(env, w2, 'GET', '/delivery/stops?date=2026-10-01');
    expect(list.body.find((x: any) => x.id === s.body.id)).toBeUndefined();
  });

  it('non-admins cannot use admin endpoints; auditors are read-only', async () => {
    const w = await verifiedWorker(env);
    expect((await call(env, w, 'GET', '/admin/users')).status).toBe(403);
    const auditor = await admin(env, 'admin_auditor');
    expect((await call(env, auditor, 'GET', '/admin/audit-events')).status).toBe(200);
    const org = await approvedOrg(env, false);
    const r = await call(env, auditor, 'POST', `/admin/organizations/${org.orgId}/review`, { decision: 'approved', reason: 'x' });
    expect(r.status).toBe(403);
    const support = await admin(env, 'admin_support');
    expect((await call(env, support, 'POST', '/admin/payouts/batches', { cutoffDate: '2026-09-30' })).status).toBe(403);
  });

  it('reviewer role cannot create jobs; non-members get 404', async () => {
    const org = await approvedOrg(env);
    const outsider = await admin(env, 'admin_auditor');
    expect((await call(env, outsider, 'GET', `/organizations/${org.orgId}/jobs`)).status).toBe(404);
  });
});
