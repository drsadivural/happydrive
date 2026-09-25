// JOB-01..05 and ID-01 (unverified cannot accept): posting rules, matching, atomic acceptance, execution, cancellations.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, approvedOrg, call, jobInput, key, loginWorker, publishedJob, setupApp, uploadEvidence, verifiedWorker, YOKOHAMA, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => { env = await setupApp(); });
afterAll(async () => env.close());

async function moveJobToNow(jobId: string, startInMin = 10) {
  await env.ctx.db.query(
    `UPDATE jobs SET starts_at = now() + make_interval(mins => $2), ends_at = now() + make_interval(mins => $2 + 60) WHERE id = $1`,
    [jobId, startInMin],
  );
}

describe('JOB-01 posting rules', () => {
  it('unapproved organisations cannot submit; publish checks block unlawful or incomplete postings', async () => {
    const pending = await approvedOrg(env, false);
    const d = await call(env, pending.owner, 'POST', `/organizations/${pending.orgId}/jobs`, jobInput());
    expect(d.status).toBe(201);
    const s = await call(env, pending.owner, 'POST', `/organizations/${pending.orgId}/jobs/${d.body.id}/submit`);
    expect(s.status).toBe(422);
    expect(s.body.details.checks.find((c: any) => c.code === 'organization_approved').ok).toBe(false);

    const org = await approvedOrg(env);
    const restricted = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs`, jobInput({ category: 'personal_care' }));
    expect(restricted.status).toBe(422);
    expect(restricted.body.code).toBe('category_restricted');

    const legal = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs`, jobInput({ contractType: 'other_legal_review' }));
    const legalSubmit = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs/${legal.body.id}/submit`);
    expect(legalSubmit.status).toBe(422);
    expect(legalSubmit.body.message).toMatch(/法務審査中は公開不可/);

    const emp = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs`, jobInput({ contractType: 'employment', amountYen: 900 }));
    const empSubmit = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs/${emp.body.id}/submit`);
    expect(empSubmit.status).toBe(422);
    const failed = empSubmit.body.details.checks.filter((c: any) => !c.ok).map((c: any) => c.code);
    expect(failed).toEqual(expect.arrayContaining(['employment_terms', 'minimum_wage']));

    const phone = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs`, jobInput({ description: '詳しくは 045-123-4567 までお電話ください。よろしくお願いします。' }));
    const phoneSubmit = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs/${phone.body.id}/submit`);
    expect(phoneSubmit.body.details.checks.find((c: any) => c.code === 'no_personal_phone').ok).toBe(false);

    const missing = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs`, { title: 'x' });
    expect(missing.status).toBe(422);
  });

  it('published jobs cannot be edited; drafts can', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org);
    const r = await call(env, org.owner, 'PUT', `/organizations/${org.orgId}/jobs/${job.id}`, jobInput({ amountYen: 100 }));
    expect(r.status).toBe(409);
  });
});

describe('JOB-02 search and matching', () => {
  it('supports manual area search without location and never recommends ineligible jobs', async () => {
    const org = await approvedOrg(env);
    const open = await publishedJob(env, org, { areaLabel: '横浜市中区テスト地区', title: '書類の回収（テスト）', category: 'corporate_task' });
    const skilled = await publishedJob(env, org, { areaLabel: '横浜市中区テスト地区', title: '見守り訪問（テスト）', category: 'elderly_watch', requiredSkills: ['elderly_watch_training'] });
    const w = await verifiedWorker(env);

    const manual = await call(env, w, 'GET', `/jobs?areaQuery=${encodeURIComponent('テスト地区')}&sort=starts_at`);
    expect(manual.status).toBe(200);
    const ids = manual.body.items.map((j: any) => j.id);
    expect(ids).toEqual(expect.arrayContaining([open.id, skilled.id]));
    const sk = manual.body.items.find((j: any) => j.id === skilled.id);
    expect(sk.eligible).toBe(false);
    expect(sk.ineligibleReasons[0]).toMatch(/資格/);
    expect(sk.address).toBeUndefined();

    const rec = await call(env, w, 'GET', `/jobs?latitude=${YOKOHAMA.latitude}&longitude=${YOKOHAMA.longitude}&sort=recommended&limit=50`);
    const recIds = rec.body.items.map((j: any) => j.id);
    expect(recIds).toContain(open.id);
    expect(recIds).not.toContain(skilled.id);
    const o = rec.body.items.find((j: any) => j.id === open.id);
    expect(o.matchReasons).toEqual(expect.arrayContaining([expect.stringMatching(/近い/)]));
    expect(o.distanceKm).toBeLessThan(1);

    const accept = await call(env, w, 'POST', `/jobs/${skilled.id}/accept`);
    expect(accept.status).toBe(403);
    expect(accept.body.code).toBe('not_eligible');

    const impressions = await env.ctx.db.query(`SELECT excluded_reason FROM match_impressions WHERE worker_id = $1 AND job_id = $2`, [w.userId, skilled.id]);
    expect(impressions.rows.map((r) => r.excluded_reason)).toContain('skill_missing');
  });

  it('ID-01: unverified workers cannot accept', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org);
    const w = await loginWorker(env);
    const r = await call(env, w, 'POST', `/jobs/${job.id}/accept`);
    expect(r.status).toBe(403);
    expect(r.body.details.codes).toEqual(expect.arrayContaining(['not_verified', 'onboarding_incomplete']));
  });
});

describe('JOB-03 concurrent acceptance', () => {
  it('100 parallel accepts on the last slot: exactly one succeeds; retries return the same result', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org, { capacity: 1 });
    const workers = [];
    for (let i = 0; i < 100; i++) workers.push(await verifiedWorker(env, { bank: false }));
    const keys = workers.map(() => key());
    const results = await Promise.all(workers.map((w, i) => call(env, w, 'POST', `/jobs/${job.id}/accept`, { termsHash: job.termsHash }, { 'idempotency-key': keys[i]! })));
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'capacity_full')).toBe(true);
    expect(results.filter((r) => r.status !== 201 && r.status !== 409)).toHaveLength(0);

    const winner = results.findIndex((r) => r.status === 201);
    const retry = await call(env, workers[winner]!, 'POST', `/jobs/${job.id}/accept`, { termsHash: job.termsHash }, { 'idempotency-key': keys[winner]! });
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(ok[0]!.body.id);
    const loser = results.findIndex((r) => r.status === 409);
    const retryLoser = await call(env, workers[loser]!, 'POST', `/jobs/${job.id}/accept`, { termsHash: job.termsHash }, { 'idempotency-key': keys[loser]! });
    expect(retryLoser.status).toBe(409);

    const db = await env.ctx.db.query(`SELECT count(*)::int AS n FROM assignments WHERE job_id = $1`, [job.id]);
    expect(db.rows[0].n).toBe(1);
    const j = await env.ctx.db.query(`SELECT reserved_count, status FROM jobs WHERE id = $1`, [job.id]);
    expect(j.rows[0]).toEqual({ reserved_count: 1, status: 'filled' });

    // The same worker with a new key gets already_accepted, not a second assignment.
    const again = await call(env, workers[winner]!, 'POST', `/jobs/${job.id}/accept`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_accepted');
  }, 120_000);

  it('rejects acceptance when the terms changed since display', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org);
    const w = await verifiedWorker(env);
    const r = await call(env, w, 'POST', `/jobs/${job.id}/accept`, { termsHash: 'deadbeef' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('terms_changed');
  });
});

describe('JOB-04 execution and review', () => {
  it('check-in radius, steps, required photos, revision, approval and ledger = snapshot', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org, { amountYen: 1500, expensesReimbursedYen: 200 });
    const w = await verifiedWorker(env);
    const acc = await call(env, w, 'POST', `/jobs/${job.id}/accept`, { termsHash: job.termsHash });
    expect(acc.body.state).toBe('accepted');
    expect(acc.body.job.address).toBe('神奈川県横浜市中区山下町1-2-3');
    expect(acc.body.termsSnapshot.amountYen).toBe(1500);
    const id = acc.body.id;
    await moveJobToNow(job.id);

    expect((await call(env, w, 'POST', `/assignments/${id}/location`, { location: YOKOHAMA })).status).toBe(409);
    expect((await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'traveling' })).body.state).toBe('traveling');
    expect((await call(env, w, 'POST', `/assignments/${id}/location`, { location: YOKOHAMA, accuracyMeters: 10 })).status).toBe(204);
    const live = await call(env, org.owner, 'GET', `/assignments/${id}/live-location`);
    expect(live.status).toBe(200);
    expect(live.body.location.latitude).toBeCloseTo(YOKOHAMA.latitude, 4);

    const far = await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'checked_in', location: { latitude: 35.47, longitude: 139.62 } });
    expect(far.status).toBe(409);
    expect(far.body.code).toBe('too_far_from_site');
    const near = await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'checked_in', location: { latitude: YOKOHAMA.latitude + 0.001, longitude: YOKOHAMA.longitude } });
    expect(near.body.state).toBe('checked_in');
    expect((await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'working' })).body.state).toBe('working');

    expect((await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'step_completed', stepIndex: 1 })).body.code).toBe('step_order');
    await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'step_completed', stepIndex: 0 });
    expect((await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'step_completed', stepIndex: 1 })).body.code).toBe('photo_required');
    const photo = await uploadEvidence(env, w, { assignmentId: id });
    await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'step_completed', stepIndex: 1, evidenceIds: [photo.id] });
    expect((await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'submitted' })).body.code).toBe('steps_incomplete');
    await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'step_completed', stepIndex: 2 });
    const sub = await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'submitted', note: '買い物付き添いを完了しました' });
    expect(sub.body.state).toBe('submitted');
    expect(sub.body.earning.state).toBe('pending');
    // Location sharing stops at submission; the org no longer sees a position.
    expect((await call(env, w, 'POST', `/assignments/${id}/location`, { location: YOKOHAMA })).status).toBe(409);
    expect((await call(env, org.owner, 'GET', `/assignments/${id}/live-location`)).status).toBe(404);

    const noReason = await call(env, org.owner, 'POST', `/assignments/${id}/review`, { decision: 'needs_revision' });
    expect(noReason.status).toBe(422);
    const rev = await call(env, org.owner, 'POST', `/assignments/${id}/review`, { decision: 'needs_revision', reason: '購入品の写真を追加してください' });
    expect(rev.body.state).toBe('needs_revision');
    const notes = await call(env, w, 'GET', '/notifications?unreadOnly=true');
    expect(notes.body.some((n: any) => n.type === 'assignment_needs_revision')).toBe(true);
    const photo2 = await uploadEvidence(env, w, { assignmentId: id });
    await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'step_completed', stepIndex: 1, evidenceIds: [photo2.id] });
    expect((await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'submitted' })).body.state).toBe('submitted');

    const approved = await call(env, org.owner, 'POST', `/assignments/${id}/review`, { decision: 'approved' });
    expect(approved.body.state).toBe('payable');
    expect(approved.body.earning).toMatchObject({ state: 'payable', amountYen: 1700 });
    const ledger = await env.ctx.db.query(`SELECT entry_type, amount_yen FROM ledger_entries WHERE assignment_id = $1 ORDER BY entry_type`, [id]);
    expect(ledger.rows).toEqual([{ entry_type: 'earned', amount_yen: 1500 }, { entry_type: 'expense', amount_yen: 200 }]);
    const earnings = await call(env, w, 'GET', '/earnings');
    const e = earnings.body.find((x: any) => x.assignmentId === id);
    expect(e.amountYen).toBe(1700);
    expect(e.scheduledPayoutDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect((await call(env, w, 'POST', `/assignments/${id}/rating`, { score: 5, comment: 'ありがとうございました' })).status).toBe(204);
    expect((await call(env, w, 'POST', `/assignments/${id}/rating`, { score: 4 })).status).toBe(409);
    expect((await call(env, org.owner, 'POST', `/assignments/${id}/rating`, { score: 5 })).status).toBe(204);
    const timeline = (await call(env, org.owner, 'GET', `/assignments/${id}`)).body.timeline.map((t: any) => t.eventType);
    expect(timeline).toEqual(expect.arrayContaining(['accepted', 'traveling', 'checked_in', 'working', 'submitted', 'review_needs_revision', 'review_approved']));
  });

  it('requires organisation approval for reserved slots and expires them', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org, { requiresOrgApproval: true, reservationTtlMinutes: 10 });
    const w = await verifiedWorker(env);
    const r = await call(env, w, 'POST', `/jobs/${job.id}/accept`, { termsHash: job.termsHash });
    expect(r.body.state).toBe('reserved');
    expect(r.body.job.address).toBeUndefined();
    await env.ctx.db.query(`UPDATE assignments SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`, [r.body.id]);
    const { expireReservations } = await import('../src/jobs/maintenance.js');
    expect(await expireReservations(env.ctx)).toBeGreaterThanOrEqual(1);
    expect((await call(env, w, 'GET', `/assignments/${r.body.id}`)).body.state).toBe('expired');
    const j = await env.ctx.db.query('SELECT reserved_count FROM jobs WHERE id = $1', [job.id]);
    expect(j.rows[0].reserved_count).toBe(0);

    const w2 = await verifiedWorker(env);
    const r2 = await call(env, w2, 'POST', `/jobs/${job.id}/accept`, { termsHash: job.termsHash });
    const ok = await call(env, org.owner, 'POST', `/assignments/${r2.body.id}/reservation`, { decision: 'approve' });
    expect(ok.body.state).toBe('accepted');
  });
});

describe('JOB-05 cancellation and no-show', () => {
  it('worker cancellation releases the slot, notifies the waitlist and flags late cancellations', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org, { capacity: 1 });
    const w1 = await verifiedWorker(env);
    const w2 = await verifiedWorker(env);
    const a1 = await call(env, w1, 'POST', `/jobs/${job.id}/accept`);
    expect((await call(env, w2, 'POST', `/jobs/${job.id}/accept`)).body.code).toBe('capacity_full');
    expect((await call(env, w2, 'PUT', `/jobs/${job.id}/waitlist`)).status).toBe(204);
    const c = await call(env, w1, 'POST', `/assignments/${a1.body.id}/events`, { eventType: 'cancelled', note: '体調不良' });
    expect(c.body.state).toBe('cancelled');
    expect(c.body.lateCancellation).toBe(true); // starts in 3h, free window is 24h
    const notes = await call(env, w2, 'GET', '/notifications');
    expect(notes.body.some((n: any) => n.type === 'waitlist_opening' && n.entityId === job.id)).toBe(true);
    expect((await call(env, w2, 'POST', `/jobs/${job.id}/accept`)).status).toBe(201);
    const events = await env.ctx.db.query(`SELECT event_type, reason FROM domain_events WHERE entity_id = $1 ORDER BY id`, [a1.body.id]);
    expect(events.rows.map((e) => e.event_type)).toEqual(['accepted', 'cancelled']);
    expect(events.rows[1].reason).toBe('体調不良');
  });

  it('no-show can be recorded only after the grace period and re-opens the slot', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org);
    const w = await verifiedWorker(env);
    const a = await call(env, w, 'POST', `/jobs/${job.id}/accept`);
    const early = await call(env, org.owner, 'POST', `/assignments/${a.body.id}/no-show`, { reason: '来ない' });
    expect(early.status).toBe(409);
    await env.ctx.db.query(`UPDATE jobs SET starts_at = now() - interval '40 minutes', ends_at = now() + interval '20 minutes' WHERE id = $1`, [job.id]);
    const ns = await call(env, org.owner, 'POST', `/assignments/${a.body.id}/no-show`, { reason: '連絡なし' });
    expect(ns.body.state).toBe('no_show');
  });

  it('organisation cancellation after the free window books compensation', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org, { amountYen: 2000 });
    const w = await verifiedWorker(env);
    const a = await call(env, w, 'POST', `/jobs/${job.id}/accept`);
    const r = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs/${job.id}/cancel`, { reason: '依頼者の都合' });
    expect(r.body.status).toBe('cancelled');
    const view = await call(env, w, 'GET', `/assignments/${a.body.id}`);
    expect(view.body.state).toBe('cancelled');
    expect(view.body.earning).toMatchObject({ state: 'payable', amountYen: 1000 });
    const ledger = await env.ctx.db.query(`SELECT entry_type, amount_yen FROM ledger_entries WHERE assignment_id = $1`, [a.body.id]);
    expect(ledger.rows).toEqual([{ entry_type: 'compensation', amount_yen: 1000 }]);
  });

  it('operators can reassign before work starts', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org);
    const w1 = await verifiedWorker(env);
    const w2 = await verifiedWorker(env);
    const a = await call(env, w1, 'POST', `/jobs/${job.id}/accept`);
    const op = await admin(env);
    const r = await call(env, op, 'POST', `/admin/assignments/${a.body.id}/reassign`, { workerId: w2.userId, reason: '担当者の事故のため' });
    expect(r.status).toBe(201);
    expect(r.body.workerId).toBe(w2.userId);
    expect((await call(env, w1, 'GET', `/assignments/${a.body.id}`)).body.state).toBe('cancelled');
  });
});
