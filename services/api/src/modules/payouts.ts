import type { AppContext, HandlerMap } from '../context.js';
import { body, params, query, requireUser } from '../context.js';
import type { Client } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { AppError, conflict, notFound, unavailable, unauthorized } from '../lib/errors.js';
import { bumpMetric, recordEvent } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { currentJstMonth, jstDate, jstMonthRange, jstStartOfDay, nextPayoutDate } from '../lib/time.js';
import { notify, notifyAdmins } from '../lib/notify.js';
import { requireAdmin } from '../auth/rbac.js';
import { earningState } from './assignments.js';

export function payoutView(p: any) {
  return {
    id: p.id, workerId: p.worker_id, workerDisplayName: p.display_name ?? undefined, amountYen: p.amount_yen, status: p.status,
    failureReason: p.failure_reason ?? undefined, providerReference: p.provider_reference ?? undefined, attemptCount: p.attempt_count,
    scheduledDate: p.scheduled_date, paidAt: p.paid_at ?? undefined, createdAt: p.created_at,
  };
}

/** Sends a requested payout to the provider. The provider idempotency key prevents duplicate transfers on retries/crashes. */
export async function submitPayout(ctx: AppContext, payoutId: string) {
  const p = (await ctx.db.query('SELECT * FROM payouts WHERE id = $1', [payoutId])).rows[0];
  if (!p || p.status !== 'requested') return;
  const u = (await ctx.db.query('SELECT bank_ciphertext FROM app_users WHERE id = $1', [p.worker_id])).rows[0];
  const bank = ctx.cipher.decryptJson<any>(u?.bank_ciphertext);
  let result;
  try {
    if (!bank) throw new Error('振込先が登録されていません');
    result = await ctx.payouts.createTransfer({ idempotencyKey: p.provider_idempotency_key, amountYen: Number(p.amount_yen), bank });
  } catch (e) {
    result = { reference: null, status: 'failed' as const, failureReason: (e as Error).message };
  }
  await withTx(ctx.db, async (c) => {
    await c.query(
      `UPDATE payouts SET status = $2, provider_reference = coalesce($3, provider_reference), failure_reason = $4, attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1 AND status = 'requested'`,
      [p.id, result.status === 'paid' ? 'processing' : result.status, result.reference, result.failureReason ?? null],
    );
    if (result.status === 'failed') await onPayoutFailed(c, p, result.failureReason ?? '不明なエラー');
    await recordEvent(c, { entityType: 'payout', entityId: p.id, eventType: `payout_${result.status === 'failed' ? 'failed' : 'submitted'}`, actor: { id: null, role: 'system' }, reason: result.failureReason ?? null });
  });
  // A provider that settles synchronously is still confirmed through getTransfer (same path as webhooks).
  if (result.status === 'paid' && result.reference) await confirmTransfer(ctx, result.reference);
}

async function onPayoutFailed(c: Client, p: any, reason: string) {
  await bumpMetric(c, 'payout_failed');
  await notifyAdmins(c, { type: 'payout_failed', title: '振込に失敗しました', body: `振込ID ${String(p.id).slice(0, 8)}: ${reason}`, entityType: 'payout', entityId: p.id });
  await notify(c, [p.worker_id], { type: 'payout_failed', title: '振込ができませんでした', body: '振込先の口座情報を確認してください。運営から再振込を行います', entityType: 'payout', entityId: p.id });
}

/**
 * Settles a payout only after the provider API confirms the transfer (webhooks alone are not trusted).
 * Status moves forward only: a late "failed" never overrides "paid".
 */
export async function confirmTransfer(ctx: AppContext, reference: string): Promise<'paid' | 'failed' | 'processing' | 'unknown'> {
  const t = await ctx.payouts.getTransfer(reference);
  if (!t) return 'unknown';
  if (t.status === 'processing') return 'processing';
  await withTx(ctx.db, async (c) => {
    const p = (await c.query('SELECT * FROM payouts WHERE provider_reference = $1 FOR UPDATE', [reference])).rows[0];
    if (!p || p.status === 'paid') return;
    if (t.status === 'failed') {
      if (p.status === 'failed') return;
      await c.query(`UPDATE payouts SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`, [p.id, t.failureReason ?? '振込エラー']);
      await onPayoutFailed(c, p, t.failureReason ?? '振込エラー');
      await recordEvent(c, { entityType: 'payout', entityId: p.id, eventType: 'payout_failed', actor: { id: null, role: 'provider' }, reason: t.failureReason ?? null });
      return;
    }
    await c.query(`UPDATE payouts SET status = 'paid', paid_at = now(), failure_reason = NULL, updated_at = now() WHERE id = $1`, [p.id]);
    const items = await c.query(
      `SELECT pi.assignment_id, pi.amount_yen, j.org_id FROM payout_items pi
       JOIN assignments a ON a.id = pi.assignment_id JOIN jobs j ON j.id = a.job_id
       WHERE pi.payout_id = $1 AND pi.released_at IS NULL`,
      [p.id],
    );
    for (const it of items.rows) {
      await c.query(
        `INSERT INTO ledger_entries(assignment_id, worker_id, org_id, contract_type, entry_type, amount_yen, payout_id, provider_reference, reason)
         VALUES ($1,$2,$3,$4,'paid',$5,$6,$7,'振込完了')`,
        [it.assignment_id, p.worker_id, it.org_id, p.contract_type, it.amount_yen, p.id, `${reference}:${it.assignment_id}`],
      );
      await c.query(`UPDATE assignments SET state = 'paid', updated_at = now() WHERE id = $1 AND state IN ('approved','payable')`, [it.assignment_id]);
    }
    await notify(c, [p.worker_id], { type: 'payout_paid', title: '報酬を振り込みました', body: `¥${Number(p.amount_yen).toLocaleString('ja-JP')} を登録口座へ振り込みました`, entityType: 'payout', entityId: p.id });
    await recordEvent(c, { entityType: 'payout', entityId: p.id, eventType: 'payout_paid', actor: { id: null, role: 'provider' }, payload: { reference } });
  });
  return t.status;
}

export const earningsHandlers: HandlerMap = {
  async getEarnings(ctx, req) {
    const u = requireUser(req);
    const month = query<{ month?: string }>(req).month;
    const range = month ? jstMonthRange(month) : null;
    const r = await ctx.db.query(
      `SELECT a.id, a.state, a.accepted_amount_yen, a.terms_snapshot, a.completed_at, j.title, j.contract_type, j.starts_at, o.legal_name,
         coalesce((SELECT json_agg(json_build_object('type', l.entry_type, 'amountYen', l.amount_yen, 'note', l.reason) ORDER BY l.created_at)
                   FROM ledger_entries l WHERE l.assignment_id = a.id), '[]') AS entries,
         (SELECT row_to_json(p) FROM (SELECT p.status, p.scheduled_date::text, p.paid_at FROM payout_items pi JOIN payouts p ON p.id = pi.payout_id
            WHERE pi.assignment_id = a.id ORDER BY p.created_at DESC LIMIT 1) p) AS payout
       FROM assignments a JOIN jobs j ON j.id = a.job_id JOIN organizations o ON o.id = j.org_id
       WHERE a.worker_id = $1 AND (a.state NOT IN ('declined','expired','no_show','cancelled') OR EXISTS (SELECT 1 FROM ledger_entries l WHERE l.assignment_id = a.id))
         ${range ? 'AND j.starts_at >= $2 AND j.starts_at < $3' : ''}
       ORDER BY j.starts_at DESC LIMIT 300`,
      range ? [u.id, range[0], range[1]] : [u.id],
    );
    return r.rows.map((x) => earningEntry(x));
  },

  async getEarningsSummary(ctx, req) {
    requireUser(req);
    const month = query<{ month?: string }>(req).month ?? currentJstMonth();
    const list = (await earningsHandlers.getEarnings!(ctx, Object.assign(Object.create(req), { query: { month } }), undefined as never)) as ReturnType<typeof earningEntry>[];
    const sum = (f: (e: ReturnType<typeof earningEntry>) => boolean) => list.filter(f).reduce((s, e) => s + e.amountYen, 0);
    return {
      month,
      totalYen: sum((e) => e.state !== 'reversed'),
      paidYen: sum((e) => e.state === 'paid'),
      payableYen: sum((e) => e.state === 'payable' || e.state === 'failed'),
      pendingYen: sum((e) => e.state === 'pending'),
      estimatedYen: sum((e) => e.state === 'estimated'),
      completedCount: list.filter((e) => ['payable', 'paid', 'failed'].includes(e.state)).length,
      employmentYen: sum((e) => e.contractType === 'employment' && e.state !== 'reversed'),
      contractorYen: sum((e) => e.contractType === 'contractor' && e.state !== 'reversed'),
    };
  },

  async listMyPayouts(ctx, req) {
    const u = requireUser(req);
    const r = await ctx.db.query('SELECT * FROM payouts WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 100', [u.id]);
    return r.rows.map(payoutView);
  },

  async adminListPayouts(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const status = query<{ status?: string }>(req).status;
    const r = await ctx.db.query(
      `SELECT p.*, u.display_name FROM payouts p JOIN app_users u ON u.id = p.worker_id ${status ? 'WHERE p.status = $1' : ''} ORDER BY p.created_at DESC LIMIT 300`,
      status ? [status] : [],
    );
    return r.rows.map(payoutView);
  },

  async adminCreatePayoutBatch(ctx, req, reply) {
    const u = requireUser(req);
    requireAdmin(u, 'operate');
    if (!ctx.payouts.enabled) throw unavailable('payout_provider_unavailable', '振込事業者と未契約のため、振込機能は利用できません');
    const cutoff = body<{ cutoffDate: string }>(req).cutoffDate;
    const res = await withIdempotency(ctx, req, 'adminCreatePayoutBatch', async (c) => {
      const cutoffEnd = new Date(jstStartOfDay(cutoff).getTime() + 86_400_000);
      // Unpaid, undisputed contractor balances not attached to a live payout. Employment wages go through payroll (see DECISIONS_REQUIRED).
      const bal = await c.query(
        `SELECT l.worker_id, l.assignment_id,
           (coalesce(sum(l.amount_yen) FILTER (WHERE l.entry_type <> 'paid'), 0) - coalesce(sum(l.amount_yen) FILTER (WHERE l.entry_type = 'paid'), 0))::int AS unpaid
         FROM ledger_entries l JOIN assignments a ON a.id = l.assignment_id JOIN app_users u ON u.id = l.worker_id
         WHERE l.contract_type = 'contractor' AND a.state <> 'disputed' AND u.bank_ciphertext IS NOT NULL AND u.deleted_at IS NULL
           AND u.verification_status = 'verified'
           AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.assignment_id = l.assignment_id AND pi.released_at IS NULL)
         GROUP BY l.worker_id, l.assignment_id
         HAVING max(l.created_at) < $1`,
        [cutoffEnd],
      );
      const batch = await c.query('INSERT INTO payout_batches(cutoff_date, created_by) VALUES ($1,$2) RETURNING id', [cutoff, u.id]);
      const byWorker = new Map<string, { assignmentId: string; amount: number }[]>();
      for (const row of bal.rows) {
        if (row.unpaid <= 0) continue;
        byWorker.set(row.worker_id, [...(byWorker.get(row.worker_id) ?? []), { assignmentId: row.assignment_id, amount: row.unpaid }]);
      }
      const payouts = [];
      const scheduled = nextPayoutDate(new Date());
      for (const [workerId, items] of byWorker) {
        const total = items.reduce((s, i) => s + i.amount, 0);
        const p = await c.query(
          `INSERT INTO payouts(batch_id, worker_id, contract_type, amount_yen, status, provider, provider_idempotency_key, scheduled_date)
           VALUES ($1,$2,'contractor',$3,'requested',$4, gen_random_uuid()::text, $5) RETURNING *`,
          [batch.rows[0].id, workerId, total, ctx.payouts.name, scheduled],
        );
        for (const it of items) await c.query('INSERT INTO payout_items(payout_id, assignment_id, amount_yen) VALUES ($1,$2,$3)', [p.rows[0].id, it.assignmentId, it.amount]);
        payouts.push(p.rows[0]);
      }
      await recordEvent(c, { entityType: 'payout_batch', entityId: batch.rows[0].id, eventType: 'payout_batch_created', actor: { id: u.id, role: 'admin_operator' }, payload: { payouts: payouts.length, cutoff } });
      return { status: 201, body: { id: batch.rows[0].id, cutoffDate: cutoff, payoutCount: payouts.length, totalYen: payouts.reduce((s, p) => s + Number(p.amount_yen), 0), payoutIds: payouts.map((p) => p.id) } };
    });
    const ids = (res.body as any).payoutIds as string[];
    for (const id of ids) await submitPayout(ctx, id);
    const rows = await ctx.db.query('SELECT p.*, u.display_name FROM payouts p JOIN app_users u ON u.id = p.worker_id WHERE p.id = ANY($1)', [ids]);
    reply.code(res.status);
    const { payoutIds: _ids, ...rest } = res.body as any;
    return { ...rest, payouts: rows.rows.map(payoutView) };
  },

  async adminRetryPayout(ctx, req) {
    const u = requireUser(req);
    requireAdmin(u, 'operate');
    if (!ctx.payouts.enabled) throw unavailable('payout_provider_unavailable', '振込事業者と未契約のため、振込機能は利用できません');
    const id = params(req).payoutId!;
    await withIdempotency(ctx, req, 'adminRetryPayout', async (c) => {
      const p = (await c.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) throw notFound();
      if (p.status !== 'failed') throw conflict('invalid_state', '失敗した振込のみ再試行できます');
      await c.query(
        `UPDATE payouts SET status = 'requested', provider_idempotency_key = $2, provider_reference = NULL, failure_reason = NULL, updated_at = now() WHERE id = $1`,
        [id, `${id}:${p.attempt_count + 1}`],
      );
      await recordEvent(c, { entityType: 'payout', entityId: id, eventType: 'payout_retry', actor: { id: u.id, role: 'admin_operator' } });
      return { status: 200, body: null };
    });
    await submitPayout(ctx, id);
    const r = await ctx.db.query('SELECT p.*, u.display_name FROM payouts p JOIN app_users u ON u.id = p.worker_id WHERE p.id = $1', [id]);
    return payoutView(r.rows[0]);
  },

  async adminReconciliation(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const month = query<{ month: string }>(req).month;
    const [from, to] = jstMonthRange(month);
    const sums = await ctx.db.query(
      `SELECT coalesce(sum(amount_yen) FILTER (WHERE entry_type IN ('earned','expense','compensation')),0)::int AS earned,
              coalesce(sum(amount_yen) FILTER (WHERE entry_type IN ('reversal','refund')),0)::int AS reversed
       FROM ledger_entries WHERE created_at >= $1 AND created_at < $2`,
      [from, to],
    );
    const snap = await ctx.db.query(
      `SELECT a.id, (a.terms_snapshot->>'amountYen')::int AS snapshot, a.accepted_amount_yen, l.amount_yen AS earned, a.review_reason
       FROM ledger_entries l JOIN assignments a ON a.id = l.assignment_id
       WHERE l.entry_type = 'earned' AND l.created_at >= $1 AND l.created_at < $2`,
      [from, to],
    );
    const paid = await ctx.db.query(`SELECT * FROM payouts WHERE paid_at >= $1 AND paid_at < $2`, [from, to]);
    const failed = await ctx.db.query(`SELECT * FROM payouts WHERE status = 'failed' AND created_at < $1`, [to]);
    const employment = await ctx.db.query(
      `SELECT coalesce(sum(amount_yen),0)::int AS n FROM ledger_entries WHERE contract_type = 'employment' AND entry_type <> 'paid' AND created_at >= $1 AND created_at < $2`,
      [from, to],
    );
    const discrepancies: { type: string; message: string; assignmentId?: string; payoutId?: string; amountYen?: number }[] = [];
    let acceptedSnapshotYen = 0;
    for (const s of snap.rows) {
      acceptedSnapshotYen += s.snapshot;
      if (s.snapshot !== s.accepted_amount_yen || (s.earned !== s.snapshot && !/紛争裁定/.test(s.review_reason ?? ''))) {
        discrepancies.push({ type: 'snapshot_mismatch', message: '受諾時の条件と台帳の計上額が一致しません', assignmentId: s.id, amountYen: s.earned - s.snapshot });
      }
    }
    let providerConfirmedYen = 0;
    for (const p of paid.rows) {
      const t = p.provider_reference ? await ctx.payouts.getTransfer(p.provider_reference) : null;
      if (t?.status === 'paid') providerConfirmedYen += Number(p.amount_yen);
      else discrepancies.push({ type: 'provider_unconfirmed', message: '決済事業者側で振込完了が確認できません', payoutId: p.id, amountYen: Number(p.amount_yen) });
      const items = await ctx.db.query(`SELECT coalesce(sum(amount_yen),0)::int AS n FROM ledger_entries WHERE payout_id = $1 AND entry_type = 'paid'`, [p.id]);
      if (items.rows[0].n !== Number(p.amount_yen)) discrepancies.push({ type: 'ledger_payout_mismatch', message: '振込額と台帳の支払記録が一致しません', payoutId: p.id, amountYen: Number(p.amount_yen) - items.rows[0].n });
    }
    for (const f of failed.rows) discrepancies.push({ type: 'payout_failed', message: `振込失敗（${f.failure_reason ?? '理由不明'}）。再試行が必要です`, payoutId: f.id, amountYen: Number(f.amount_yen) });
    if (employment.rows[0].n > 0) discrepancies.push({ type: 'employment_payroll', message: '雇用案件の賃金は給与計算（源泉徴収・社会保険）で支払う必要があります', amountYen: employment.rows[0].n });
    return {
      month, acceptedSnapshotYen, ledgerEarnedYen: sums.rows[0].earned, ledgerReversedYen: sums.rows[0].reversed,
      payoutsPaidYen: paid.rows.reduce((s, p) => s + Number(p.amount_yen), 0), providerConfirmedYen, failedPayoutCount: failed.rowCount, discrepancies,
    };
  },

  async paymentWebhook(ctx, req) {
    const provider = params(req).provider!;
    if (provider !== ctx.payouts.name || !ctx.payouts.enabled) throw unauthorized('unknown provider', 'webhook_rejected');
    const raw = (req as any).rawBody as string | undefined;
    const ev = raw ? ctx.payouts.verifyWebhook(req.headers as any, raw) : null;
    if (!ev) throw unauthorized('署名が不正です', 'webhook_signature_invalid');
    const ins = await ctx.db.query(
      `INSERT INTO provider_webhooks(provider, external_event_id, event_type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING provider`,
      [provider, ev.id, ev.type, ev],
    );
    if (!ins.rowCount) return { received: true, duplicate: true };
    let outcome: string;
    try {
      outcome = await confirmTransfer(ctx, ev.reference);
    } catch (e) {
      // Allow the provider to redeliver.
      await ctx.db.query('DELETE FROM provider_webhooks WHERE provider = $1 AND external_event_id = $2', [provider, ev.id]);
      throw e instanceof AppError ? e : new AppError(500, 'webhook_processing_failed', '処理に失敗しました');
    }
    await ctx.db.query('UPDATE provider_webhooks SET processed_at = now() WHERE provider = $1 AND external_event_id = $2', [provider, ev.id]);
    return { received: true, outcome };
  },
};

export function earningEntry(x: any) {
  const entries = x.entries as { type: string; amountYen: number; note?: string }[];
  const balance = entries.filter((e) => e.type !== 'paid').reduce((s, e) => s + e.amountYen, 0);
  const state = earningState(x.state, balance, x.payout?.status ?? null);
  const snapshot = x.terms_snapshot ?? {};
  const breakdown = entries.length
    ? entries.filter((e) => e.type !== 'paid').map((e) => ({ type: e.type, amountYen: e.amountYen, note: e.note ?? undefined }))
    : [
        { type: 'estimated_base', amountYen: Number(snapshot.amountYen ?? x.accepted_amount_yen), note: '受諾時の条件（検収前の見込み）' },
        ...(snapshot.expensesReimbursedYen ? [{ type: 'estimated_expense', amountYen: Number(snapshot.expensesReimbursedYen), note: '発注者負担の実費（見込み）' }] : []),
      ];
  const amount = entries.length ? balance : breakdown.reduce((s, b) => s + b.amountYen, 0);
  return {
    id: x.id,
    assignmentId: x.id,
    jobTitle: x.title,
    organizationName: x.legal_name,
    contractType: x.contract_type,
    amountYen: amount,
    state,
    scheduledPayoutDate: x.payout?.scheduled_date ?? (state === 'payable' ? nextPayoutDate(x.completed_at ? new Date(x.completed_at) : new Date()) : undefined),
    paidAt: x.payout?.status === 'paid' ? x.payout.paid_at : undefined,
    workDate: jstDate(new Date(x.starts_at)),
    breakdown,
  };
}

