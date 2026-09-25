// PAY-01 / PAY-02: payout batches, webhook signature/duplicate/out-of-order handling, no double payment,
// failures with retry and alerts, reversals, and reconciliation (display = snapshot = ledger).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook, type SandboxPayouts } from '../src/adapters/payouts.js';
import { admin, approvedOrg, call, publishedJob, setupApp, uploadEvidence, verifiedWorker, type TestEnv } from './helpers.js';
import { currentJstMonth } from '../src/lib/time.js';

let env: TestEnv;
beforeAll(async () => { env = await setupApp(); });
afterAll(async () => env.close());

async function completedAssignment(opts: { accountNumber?: string; amountYen?: number } = {}) {
  const org = await approvedOrg(env);
  const job = await publishedJob(env, org, { amountYen: opts.amountYen ?? 1200, expensesReimbursedYen: 0, steps: [{ title: '作業' }], minPhotoCount: 1 });
  const w = await verifiedWorker(env, { accountNumber: opts.accountNumber });
  const a = await call(env, w, 'POST', `/jobs/${job.id}/accept`, { termsHash: job.termsHash });
  await env.ctx.db.query(`UPDATE jobs SET starts_at = now() + interval '5 minutes', ends_at = now() + interval '65 minutes' WHERE id = $1`, [job.id]);
  const id = a.body.id;
  await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'checked_in', location: { latitude: 35.4437, longitude: 139.638 } });
  await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'working' });
  const p = await uploadEvidence(env, w, { assignmentId: id });
  await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'step_completed', stepIndex: 0, evidenceIds: [p.id] });
  await call(env, w, 'POST', `/assignments/${id}/events`, { eventType: 'submitted' });
  return { org, job, w, id };
}

const sandbox = () => env.ctx.payouts as SandboxPayouts;
const webhook = (body: object, secret = 'dev-payout-webhook-secret', ts?: number) => {
  const raw = JSON.stringify(body);
  return env.app.inject({ method: 'POST', url: '/v1/webhooks/payments/sandbox', payload: raw, headers: { 'content-type': 'application/json', 'x-hd-signature': signWebhook(secret, raw, ts) } });
};

describe('PAY-01 payouts and webhooks', () => {
  it('pays approved balances once, ignores duplicates/out-of-order events and rejects bad signatures', async () => {
    const { org, w, id } = await completedAssignment();
    await call(env, org.owner, 'POST', `/assignments/${id}/review`, { decision: 'approved' });
    const op = await admin(env);
    const cutoff = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const batch = await call(env, op, 'POST', '/admin/payouts/batches', { cutoffDate: cutoff });
    expect(batch.status).toBe(201);
    const mine = batch.body.payouts.find((p: any) => p.workerId === w.userId);
    expect(mine).toMatchObject({ amountYen: 1200, status: 'processing' });

    // A second batch must not include the same balance.
    const batch2 = await call(env, op, 'POST', '/admin/payouts/batches', { cutoffDate: cutoff });
    expect(batch2.body.payouts.find((p: any) => p.workerId === w.userId)).toBeUndefined();

    // Bad signature / stale timestamp are rejected.
    expect((await webhook({ id: 'evt-bad', type: 'transfer.paid', reference: mine.providerReference }, 'wrong-secret')).statusCode).toBe(401);
    expect((await webhook({ id: 'evt-old', type: 'transfer.paid', reference: mine.providerReference }, undefined, Math.floor(Date.now() / 1000) - 3600)).statusCode).toBe(401);

    // Webhook alone does not settle: the provider still reports processing.
    const early = await webhook({ id: 'evt-1', type: 'transfer.paid', reference: mine.providerReference });
    expect(early.statusCode).toBe(200);
    expect(JSON.parse(early.body).outcome).toBe('processing');
    expect((await call(env, w, 'GET', `/assignments/${id}`)).body.state).toBe('payable');

    await sandbox().settle(mine.providerReference, 'paid');
    const paid = await webhook({ id: 'evt-2', type: 'transfer.paid', reference: mine.providerReference });
    expect(JSON.parse(paid.body).outcome).toBe('paid');
    const dup = await webhook({ id: 'evt-2', type: 'transfer.paid', reference: mine.providerReference });
    expect(JSON.parse(dup.body).duplicate).toBe(true);
    // A late "failed" event after settlement changes nothing.
    await webhook({ id: 'evt-3', type: 'transfer.failed', reference: mine.providerReference });

    const view = await call(env, w, 'GET', `/assignments/${id}`);
    expect(view.body.state).toBe('paid');
    const ledger = await env.ctx.db.query(`SELECT entry_type, amount_yen FROM ledger_entries WHERE assignment_id = $1 ORDER BY created_at`, [id]);
    expect(ledger.rows).toEqual([{ entry_type: 'earned', amount_yen: 1200 }, { entry_type: 'paid', amount_yen: 1200 }]);
    const payouts = await call(env, w, 'GET', '/payouts');
    expect(payouts.body[0]).toMatchObject({ status: 'paid', amountYen: 1200 });
    const summary = await call(env, w, 'GET', `/earnings/summary?month=${currentJstMonth()}`);
    expect(summary.body.paidYen).toBeGreaterThanOrEqual(1200);
  });

  it('failed transfers alert operators, keep the balance attached and can be retried without double payment', async () => {
    const { org, w, id } = await completedAssignment({ accountNumber: '1230000' });
    await call(env, org.owner, 'POST', `/assignments/${id}/review`, { decision: 'approved' });
    const op = await admin(env);
    const cutoff = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const batch = await call(env, op, 'POST', '/admin/payouts/batches', { cutoffDate: cutoff });
    const p = batch.body.payouts.find((x: any) => x.workerId === w.userId);
    expect(p.status).toBe('failed');
    const alerts = await call(env, op, 'GET', '/notifications');
    expect(alerts.body.some((n: any) => n.type === 'payout_failed' && n.entityId === p.id)).toBe(true);
    expect((await call(env, w, 'GET', '/earnings')).body.find((e: any) => e.assignmentId === id).state).toBe('failed');

    // Fix the account and retry: same payout row, new provider idempotency key, one transfer.
    await call(env, w, 'PUT', '/me/bank-account', { bankCode: '0001', branchCode: '001', accountType: 'ordinary', accountNumber: '7654321', holderNameKana: 'ヤマダ タロウ' });
    const retry = await call(env, op, 'POST', `/admin/payouts/${p.id}/retry`);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('processing');
    expect(retry.body.attemptCount).toBe(2);
    await sandbox().settle(retry.body.providerReference, 'paid');
    await webhook({ id: `evt-retry-${p.id}`, type: 'transfer.paid', reference: retry.body.providerReference });
    const paidEntries = await env.ctx.db.query(`SELECT count(*)::int AS n, sum(amount_yen)::int AS s FROM ledger_entries WHERE assignment_id = $1 AND entry_type = 'paid'`, [id]);
    expect(paidEntries.rows[0]).toEqual({ n: 1, s: 1200 });
  });

  it('returns 503 when no payout provider is contracted', async () => {
    const { setupApp: s } = await import('./helpers.js');
    const { DisabledPayouts } = await import('../src/adapters/payouts.js');
    const { buildApp } = await import('../src/server.js');
    const { testConfig } = await import('./helpers.js');
    const { app } = await buildApp({ cfg: testConfig(), payouts: new DisabledPayouts() });
    const envNo = { ...env, app };
    const op = await admin(env);
    const r = await call(envNo as TestEnv, op, 'POST', '/admin/payouts/batches', { cutoffDate: '2026-09-30' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('payout_provider_unavailable');
    await app.close();
    void s;
  });
});

describe('PAY-02 disputes, reversals, reconciliation', () => {
  it('dispute resolution books the decided amount; reversal adds a negative entry; reconciliation explains differences', async () => {
    const { org, w, id } = await completedAssignment({ amountYen: 3000 });
    const d = await call(env, org.owner, 'POST', `/assignments/${id}/review`, { decision: 'disputed', reason: '作業時間が短い' });
    expect(d.body.state).toBe('disputed');
    const op = await admin(env);
    const bad = await call(env, op, 'POST', `/admin/assignments/${id}/resolve-dispute`, { resolution: 'partial', amountYen: 5000, reason: 'x' });
    expect(bad.status).toBe(422);
    const r = await call(env, op, 'POST', `/admin/assignments/${id}/resolve-dispute`, { resolution: 'partial', amountYen: 2000, reason: '双方の記録を確認し一部支払い' });
    expect(r.body.state).toBe('payable');
    const rev = await call(env, op, 'POST', `/admin/assignments/${id}/reverse`, { amountYen: 500, reason: '二重計上の訂正' });
    expect(rev.status).toBe(200);
    const tooMuch = await call(env, op, 'POST', `/admin/assignments/${id}/reverse`, { amountYen: 5000, reason: 'x' });
    expect(tooMuch.status).toBe(422);
    const ledger = await env.ctx.db.query(`SELECT entry_type, amount_yen FROM ledger_entries WHERE assignment_id = $1 ORDER BY created_at`, [id]);
    expect(ledger.rows).toEqual([{ entry_type: 'earned', amount_yen: 2000 }, { entry_type: 'reversal', amount_yen: -500 }]);
    expect((await call(env, w, 'GET', '/earnings')).body.find((e: any) => e.assignmentId === id).amountYen).toBe(1500);

    // Ledger is append-only.
    await expect(env.ctx.db.query(`UPDATE ledger_entries SET amount_yen = 1 WHERE assignment_id = $1`, [id])).rejects.toThrow(/append-only/);

    const rec = await call(env, op, 'GET', `/admin/reconciliation?month=${currentJstMonth()}`);
    expect(rec.status).toBe(200);
    expect(rec.body.ledgerReversedYen).toBeLessThanOrEqual(-500);
    expect(rec.body.discrepancies.filter((x: any) => x.type === 'snapshot_mismatch' && x.assignmentId === id)).toHaveLength(0);
    expect(rec.body.payoutsPaidYen).toBe(rec.body.providerConfirmedYen);
  });

  it('flags a ledger amount that differs from the accepted snapshot', async () => {
    const { org, id } = await completedAssignment({ amountYen: 1000 });
    await call(env, org.owner, 'POST', `/assignments/${id}/review`, { decision: 'approved' });
    // Simulate a corrupted snapshot (e.g. a bug writing different terms).
    await env.ctx.db.query(`UPDATE assignments SET terms_snapshot = jsonb_set(terms_snapshot, '{amountYen}', '999') WHERE id = $1`, [id]);
    const op = await admin(env);
    const rec = await call(env, op, 'GET', `/admin/reconciliation?month=${currentJstMonth()}`);
    expect(rec.body.discrepancies.some((x: any) => x.type === 'snapshot_mismatch' && x.assignmentId === id)).toBe(true);
  });
});
