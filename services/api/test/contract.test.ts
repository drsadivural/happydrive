// Contract conformance: every handler exists, and (via helpers.setupApp) every response in every suite is validated
// against packages/contracts/openapi.yaml. This suite runs a broad end-to-end flow to maximise operation coverage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, approvedOrg, call as rawCall, jobInput, publishedJob, setupApp, uploadEvidence, verifiedWorker, type Session, type TestEnv } from './helpers.js';
import { contractValidator, type ContractValidator } from './contract-validator.js';
import { allHandlers } from '../src/server.js';

let env: TestEnv;
let cv: ContractValidator;

beforeAll(async () => {
  env = await setupApp();
  cv = await contractValidator();
});
afterAll(async () => env.close());

const call = (s: Session | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  rawCall(env, s, method, url, payload, headers);

describe('contract conformance', () => {
  it('every OpenAPI operation has a handler', () => {
    const ops = Object.values<any>(cv.spec.paths).flatMap((item) => ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item[m]).map((m) => item[m].operationId));
    expect(ops.filter((o) => !allHandlers[o])).toEqual([]);
  });

  it('end-to-end flow responses match the contract', async () => {
    expect((await call(null, 'GET', '/healthz')).status).toBe(200);
    expect((await call(null, 'GET', '/readyz')).status).toBe(200);
    const w = await verifiedWorker(env, { skills: [] });
    await call(w, 'GET', '/me');
    await call(w, 'PATCH', '/me', { displayName: '山田' });
    await call(w, 'PUT', '/me/preferences', { preferredCategories: ['shopping_assist'], maxDistanceKm: 10 });
    await call(w, 'GET', '/skills/catalog');
    await call(w, 'POST', '/me/devices', { apnsToken: 'a'.repeat(64), environment: 'sandbox' });
    await call(w, 'DELETE', `/me/devices/${'a'.repeat(64)}`);
    const courses = await call(w, 'GET', '/learning/courses');
    const course = await call(w, 'GET', `/learning/courses/${courses.body[0].id}`);
    await call(w, 'POST', `/learning/courses/${course.body.id}/attempts`, { answers: course.body.questions.map((q: any) => ({ questionId: q.id, choiceIndex: 0 })) });
    const pass = await call(w, 'POST', `/learning/courses/life_support_basic/attempts`, { answers: [{ questionId: 'q1', choiceIndex: 1 }, { questionId: 'q2', choiceIndex: 0 }, { questionId: 'q3', choiceIndex: 1 }, { questionId: 'q4', choiceIndex: 0 }, { questionId: 'q5', choiceIndex: 1 }] });
    expect(pass.body.passed).toBe(true);
    expect(pass.body.grantedSkill.code).toBe('life_support_training');

    // Delivery
    const s1 = await call(w, 'POST', '/delivery/stops', { address: '横浜市中区契約町1-1', scheduledDate: '2026-11-01', location: { latitude: 35.44, longitude: 139.63 }, recipientPhone: '09011112222' });
    const s2 = await call(w, 'POST', '/delivery/stops', { address: '横浜市中区契約町2-2', scheduledDate: '2026-11-01', location: { latitude: 35.45, longitude: 139.64 } });
    await call(w, 'POST', '/delivery/stops', { address: '横浜市中区契約町1-1', scheduledDate: '2026-11-01' });
    await call(w, 'POST', '/delivery/stops/import', { scheduledDate: '2026-11-01', csv: 'address\n横浜市中区契約町3-3\n', dryRun: true });
    await call(w, 'GET', '/delivery/stops?date=2026-11-01');
    await call(w, 'GET', `/delivery/stops/${s1.body.id}`);
    await call(w, 'PATCH', `/delivery/stops/${s2.body.id}`, { version: s2.body.version, note: '置き配可' });
    await call(w, 'GET', `/delivery/stops/${s1.body.id}/contact`);
    const route = await call(w, 'POST', '/delivery/routes/optimize', { date: '2026-11-01', stopIds: [s1.body.id, s2.body.id], startLocation: { latitude: 35.44, longitude: 139.63 } });
    await call(w, 'GET', '/delivery/routes?date=2026-11-01');
    const re = await call(w, 'POST', `/delivery/routes/${route.body.id}/reorder`, { orderedStopIds: [...route.body.orderedStopIds].reverse() });
    await call(w, 'POST', `/delivery/routes/${re.body.id}/start`);
    await call(w, 'POST', `/delivery/stops/${re.body.orderedStopIds[0]}/events`, { eventType: 'delivered', handoff: 'in_person' });
    await call(w, 'GET', '/delivery/reports/daily?from=2026-11-01&to=2026-11-02');
    const s3 = await call(w, 'POST', '/delivery/stops', { address: '横浜市中区削除町1-1', scheduledDate: '2026-11-01' });
    await call(w, 'DELETE', `/delivery/stops/${s3.body.id}`);

    // Organisation & jobs
    const org = await approvedOrg(env);
    await call(org.owner, 'GET', `/organizations/${org.orgId}`);
    await call(org.owner, 'PATCH', `/organizations/${org.orgId}`, { legalName: '株式会社テスト物流', address: '神奈川県横浜市中区山下町1-1', contact: 'info@example.test', representativeName: '代表 太郎' });
    const site = await call(org.owner, 'POST', `/organizations/${org.orgId}/sites`, { name: '横浜センター', address: '神奈川県横浜市中区山下町1-1', location: { latitude: 35.44, longitude: 139.64 }, areaLabel: '横浜市中区' });
    await call(org.owner, 'GET', `/organizations/${org.orgId}/sites`);
    await call(org.owner, 'PUT', `/organizations/${org.orgId}/sites/${site.body.id}`, { name: '横浜第1センター', address: '神奈川県横浜市中区山下町1-1', location: { latitude: 35.44, longitude: 139.64 }, areaLabel: '横浜市中区' });
    await call(org.owner, 'GET', `/organizations/${org.orgId}/members`);
    const member = await admin(env, 'admin_auditor');
    await call(org.owner, 'POST', `/organizations/${org.orgId}/members`, { email: member.email, role: 'reviewer' });
    await call(org.owner, 'DELETE', `/organizations/${org.orgId}/members/${member.userId}`);
    const job = await publishedJob(env, org, { siteId: site.body.id, requiredSkills: ['life_support_training'] });
    await call(org.owner, 'GET', `/organizations/${org.orgId}/jobs`);
    await call(org.owner, 'GET', `/organizations/${org.orgId}/jobs/${job.id}`);
    await call(org.owner, 'GET', `/organizations/${org.orgId}/dashboard`);
    await call(w, 'GET', '/jobs?latitude=35.4437&longitude=139.638&sort=recommended');
    await call(w, 'GET', '/jobs?areaQuery=%E4%B8%AD%E5%8C%BA&sort=amount&eligibleOnly=true');
    const jd = await call(w, 'GET', `/jobs/${job.id}`);
    expect(jd.body.eligible).toBe(true);
    await call(w, 'PUT', `/jobs/${job.id}/favorite`);
    await call(w, 'DELETE', `/jobs/${job.id}/favorite`);
    const acc = await call(w, 'POST', `/jobs/${job.id}/accept`, { termsHash: jd.body.termsHash });
    const aid = acc.body.id;
    await call(w, 'GET', '/assignments?scope=upcoming');
    await call(w, 'GET', '/home?latitude=35.4437&longitude=139.638');
    await call(w, 'POST', `/assignments/${aid}/messages`, { body: '到着が5分遅れます' });
    const msgs = await call(org.owner, 'GET', `/assignments/${aid}/messages`);
    await call(org.owner, 'POST', `/assignments/${aid}/messages`, { body: '承知しました' });
    await call(w, 'POST', '/reports', { targetType: 'message', targetId: msgs.body[0].id, reason: 'other', detail: 'テスト' });
    await call(org.owner, 'GET', `/organizations/${org.orgId}/jobs/${job.id}/assignments`);
    await env.ctx.db.query(`UPDATE jobs SET starts_at = now() + interval '5 minutes', ends_at = now() + interval '65 minutes' WHERE id = $1`, [job.id]);
    await call(w, 'POST', `/assignments/${aid}/events`, { eventType: 'traveling' });
    await call(w, 'POST', `/assignments/${aid}/location`, { location: { latitude: 35.4437, longitude: 139.638 } });
    await call(org.owner, 'GET', `/assignments/${aid}/live-location`);
    await call(w, 'POST', `/assignments/${aid}/events`, { eventType: 'checked_in', location: { latitude: 35.4437, longitude: 139.638 } });
    await call(w, 'POST', `/assignments/${aid}/events`, { eventType: 'working' });
    await call(w, 'POST', `/assignments/${aid}/events`, { eventType: 'help_requested', note: '道がわからない' });
    const ph = await uploadEvidence(env, w, { assignmentId: aid });
    await call(org.owner, 'GET', `/evidence/${ph.id}/url`);
    for (const i of [0, 1, 2]) await call(w, 'POST', `/assignments/${aid}/events`, { eventType: 'step_completed', stepIndex: i, evidenceIds: i === 1 ? [ph.id] : [] });
    await call(w, 'POST', `/assignments/${aid}/events`, { eventType: 'submitted', note: '完了' });
    await call(org.owner, 'GET', `/organizations/${org.orgId}/assignments?state=submitted`);
    await call(org.owner, 'POST', `/assignments/${aid}/review`, { decision: 'approved' });
    await call(w, 'POST', `/assignments/${aid}/rating`, { score: 5 });
    await call(org.owner, 'GET', `/organizations/${org.orgId}/invoices`);
    await call(w, 'GET', `/assignments/${aid}`);
    await call(w, 'GET', '/earnings');
    await call(w, 'GET', '/earnings/summary');
    await call(w, 'GET', '/payouts');
    await call(w, 'GET', '/notifications');
    await call(w, 'POST', '/notifications/read', { all: true });
    await call(w, 'POST', '/support/tickets', { category: 'payment', body: '振込日を教えてください' });
    await call(w, 'GET', '/support/tickets');
    await call(w, 'POST', '/matching/appeals', { jobId: job.id, body: '推薦に表示されません' });
    await call(w, 'POST', '/blocks', { organizationId: org.orgId });

    // Admin
    const op = await admin(env);
    await call(op, 'GET', '/admin/users?verificationStatus=verified');
    await call(op, 'GET', `/admin/users/${w.userId}`);
    await call(op, 'POST', `/admin/users/${w.userId}/suspension`, { suspended: false, reason: '確認' });
    await call(op, 'GET', '/admin/organizations');
    await call(op, 'GET', '/admin/jobs?status=published');
    const aj = await call(op, 'GET', `/admin/jobs/${job.id}`);
    expect(aj.body.address).toBeDefined();
    await call(op, 'GET', `/admin/organizations/${org.orgId}`);
    await call(op, 'GET', '/admin/assignments');
    const reps = await call(op, 'GET', '/admin/reports?status=open');
    await call(op, 'POST', `/admin/reports/${reps.body[0].id}/resolve`, { action: 'hide_content', reason: 'テスト対応' });
    const tickets = await call(op, 'GET', '/admin/support-tickets?status=open');
    await call(op, 'POST', `/admin/support-tickets/${tickets.body[0].id}/answer`, { answer: '15日または月末です', close: true });
    await call(op, 'GET', '/admin/payouts');
    const today = new Date().toISOString().slice(0, 10);
    const batch = await call(op, 'POST', '/admin/payouts/batches', { cutoffDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) });
    expect(batch.body.payoutCount).toBeGreaterThanOrEqual(1);
    await call(op, 'GET', `/admin/reconciliation?month=${today.slice(0, 7)}`);
    await call(op, 'GET', '/admin/audit-events?limit=5');
    await call(op, 'GET', '/admin/audit-events/verify');
    await call(op, 'GET', `/admin/analytics?from=${today}&to=${today}`);
    const cfg = await call(op, 'GET', '/admin/matching/config');
    await call(op, 'PUT', '/admin/matching/config', { weights: cfg.body.weights, maxDistanceKm: 20, reason: '郊外の案件を増やすため' });
    await call(op, 'GET', `/admin/matching/audit?from=${today}&to=${today}`);
    await call(op, 'GET', '/admin/deletion-requests');

    // Skill/KYC review paths
    const k = await verifiedWorker(env);
    await env.ctx.db.query(`UPDATE app_users SET verification_status = 'unsubmitted' WHERE id = $1`, [k.userId]);
    const doc = await uploadEvidence(env, k, { purpose: 'identity_document' });
    await call(k, 'POST', '/me/verification', { documentEvidenceIds: [doc.id] });
    await call(op, 'POST', `/admin/users/${k.userId}/verification`, { decision: 'verified', reason: '書類確認' });
    const lic = await uploadEvidence(env, k, { purpose: 'skill_document' });
    await call(k, 'POST', '/me/skills', { skillCode: 'first_aid', validUntil: '2028-03-31', documentEvidenceIds: [lic.id] });
    await call(op, 'POST', `/admin/users/${k.userId}/skills/first_aid`, { decision: 'verified', reason: '修了証確認' });
    await call(k, 'PUT', '/me/profile', { legalName: '佐藤 花子', legalNameKana: 'サトウ ハナコ', birthDate: '1985-01-01', postalCode: '2310001', address: '横浜市中区1-1' });

    const d = await publishedJob(env, org);
    const draft = await call(org.owner, 'POST', `/organizations/${org.orgId}/jobs`, jobInput());
    await call(org.owner, 'PUT', `/organizations/${org.orgId}/jobs/${draft.body.id}`, jobInput({ title: '書類の回収（修正）' }));
    await call(org.owner, 'POST', `/organizations/${org.orgId}/jobs/${d.id}/cancel`, { reason: '依頼取り下げ' });
    await call(op, 'POST', `/admin/organizations/${org.orgId}/review`, { decision: 'approved', reason: '再確認' });
    await call(org.owner, 'DELETE', `/organizations/${org.orgId}/sites/${site.body.id}`);
    await call(w, 'POST', '/auth/logout', { refreshToken: w.refresh });

    const all = Object.values<any>(cv.spec.paths).flatMap((item) => ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item[m]).map((m) => item[m].operationId));
    const notExercised = all.filter((o) => !cv.seen.has(o)).sort();
    // Binary blob endpoints are exercised via app.inject in helpers; the rest are covered by the dedicated suites.
    expect(notExercised).toEqual([
      'adminDecideSkill', 'adminReassign', 'adminResolveDispute', 'adminReverseEarning', 'adminRetryPayout', 'adminReviewJob',
      'createVoiceSession', 'decideReservation', 'deviceLogin', 'downloadEvidenceBlobLocal', 'endVoiceSession', 'joinWaitlist', 'leaveWaitlist', 'paymentWebhook', 'refreshTokens',
      'reportNoShow', 'requestAccountDeletion', 'uploadEvidenceBlobLocal', 'webLogin', 'webMfaVerify', 'webSignup',
    ].filter((o) => !cv.seen.has(o)).sort());
  }, 120_000);
});
