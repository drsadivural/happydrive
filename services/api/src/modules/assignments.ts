import type pg from 'pg';
import type { AppContext, AuthUser, HandlerMap } from '../context.js';
import { body, params, query, requireUser } from '../context.js';
import type { Client } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { bumpMetric, recordEvent, type Actor } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { haversineKm, pointSql, toWkt, type Point } from '../lib/geo.js';
import { nextPayoutDate } from '../lib/time.js';
import { notify, notifyAdmins, notifyOrg } from '../lib/notify.js';
import { isAdmin, requireOrgRole, ORG_ALL } from '../auth/rbac.js';
import { createTicket } from './identity.js';
import { evidenceView } from './evidence.js';

export const ACTIVE_STATES = ['traveling', 'checked_in', 'working'];
const LIVE_STATES = ['reserved', 'accepted', 'traveling', 'checked_in', 'working', 'submitted', 'needs_revision'];
const CHECKIN_EARLY_MIN = 30;
const NO_SHOW_GRACE_MIN = 30;

export type Viewer = 'worker' | 'organization' | 'admin';

const ASSIGNMENT_COLUMNS = `a.*, j.title, j.category, j.contract_type, j.starts_at, j.ends_at, j.org_id, j.area_label, j.address_ciphertext,
  j.check_in_radius_m, j.meeting_point_note, j.safety_notes, j.min_photo_count, j.steps, j.capacity, j.cancellation_policy,
  j.expenses_reimbursed_yen, ${pointSql('j.location')} AS job_loc, o.legal_name AS org_name,
  u.display_name AS worker_name, (SELECT avg(score)::float FROM ratings r WHERE r.ratee_user_id = a.worker_id) AS worker_rating`;

async function loadRow(c: Client, id: string, lock = false) {
  const r = await c.query(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments a JOIN jobs j ON j.id = a.job_id JOIN organizations o ON o.id = j.org_id
     JOIN app_users u ON u.id = a.worker_id WHERE a.id = $1 ${lock ? 'FOR UPDATE OF a' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** Resolves the caller's relationship to an assignment. Unrelated callers get 404 (no existence leak). */
async function viewerOf(c: Client, u: AuthUser, a: any): Promise<Viewer> {
  if (a.worker_id === u.id) return 'worker';
  const m = await c.query('SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2', [a.org_id, u.id]);
  if (m.rowCount) return 'organization';
  if (isAdmin(u)) return 'admin';
  throw notFound('業務が見つかりません');
}

export function earningState(state: string, balance: number, payoutStatus: string | null): string {
  if (payoutStatus === 'paid' || state === 'paid') return 'paid';
  if (payoutStatus === 'failed') return 'failed';
  if (state === 'refunded') return 'reversed';
  if (['approved', 'payable'].includes(state) || (state === 'cancelled' && balance > 0)) return balance > 0 ? 'payable' : 'reversed';
  if (['submitted', 'needs_revision', 'disputed'].includes(state)) return 'pending';
  return 'estimated';
}

export async function loadAssignmentView(ctx: AppContext, c: Client, id: string, u: AuthUser) {
  const a = await loadRow(c, id);
  if (!a) throw notFound('業務が見つかりません');
  const viewer = await viewerOf(c, u, a);
  const evidence = await c.query(`SELECT * FROM evidence WHERE assignment_id = $1 AND deleted_at IS NULL AND purpose = 'work_photo' ORDER BY created_at`, [id]);
  const events = await c.query('SELECT event_type, created_at, actor_role, reason FROM domain_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY id', ['assignment', id]);
  const ledger = await c.query(`SELECT coalesce(sum(amount_yen) FILTER (WHERE entry_type <> 'paid'), 0)::int AS balance FROM ledger_entries WHERE assignment_id = $1`, [id]);
  const payout = await c.query(
    `SELECT p.status, p.scheduled_date::text FROM payout_items pi JOIN payouts p ON p.id = pi.payout_id WHERE pi.assignment_id = $1 ORDER BY p.created_at DESC LIMIT 1`,
    [id],
  );
  const rated = await c.query('SELECT 1 FROM ratings WHERE assignment_id = $1 AND rater_role = $2', [id, viewer === 'worker' ? 'worker' : 'organization']);
  const showAddress = viewer !== 'worker' || !['reserved', 'declined', 'expired'].includes(a.state);
  const steps = (a.steps as any[]).map((s, i) => ({
    index: i, title: s.title, description: s.description, requiresPhoto: !!s.requiresPhoto,
    completed: !!a.steps_completed[String(i)], completedAt: a.steps_completed[String(i)] ?? undefined,
  }));
  const balance = ledger.rows[0].balance;
  const p = payout.rows[0];
  return {
    id: a.id,
    jobId: a.job_id,
    workerId: a.worker_id,
    workerDisplayName: viewer === 'worker' ? undefined : a.worker_name,
    workerRatingAverage: viewer === 'worker' ? undefined : (a.worker_rating ?? undefined),
    state: a.state,
    acceptedAmountYen: a.accepted_amount_yen,
    acceptedAt: a.accepted_at,
    reservationExpiresAt: a.reservation_expires_at ?? undefined,
    termsSnapshot: a.terms_snapshot,
    job: {
      title: a.title,
      category: a.category,
      contractType: a.contract_type,
      startsAt: a.starts_at,
      endsAt: a.ends_at,
      organizationId: a.org_id,
      organizationName: a.org_name,
      areaLabel: a.area_label,
      address: showAddress ? ctx.cipher.decrypt(a.address_ciphertext) : undefined,
      location: showAddress ? a.job_loc : undefined,
      checkInRadiusMeters: a.check_in_radius_m,
      meetingPointNote: showAddress ? (a.meeting_point_note ?? undefined) : undefined,
      safetyNotes: a.safety_notes ?? undefined,
      minPhotoCount: a.min_photo_count,
    },
    steps,
    checkedInAt: a.checked_in_at ?? undefined,
    workStartedAt: a.work_started_at ?? undefined,
    submittedAt: a.submitted_at ?? undefined,
    completedAt: a.completed_at ?? undefined,
    reportNote: a.report_note ?? undefined,
    reviewReason: a.review_reason ?? undefined,
    evidence: evidence.rows.map(evidenceView),
    timeline: events.rows.map((e) => ({ eventType: e.event_type, at: e.created_at, actorRole: e.actor_role ?? undefined, reason: e.reason ?? undefined })),
    earning: {
      state: earningState(a.state, balance, p?.status ?? null),
      amountYen: balance > 0 ? balance : a.accepted_amount_yen,
      scheduledPayoutDate: p?.scheduled_date ?? (balance > 0 ? nextPayoutDate(a.completed_at ?? new Date()) : undefined),
    },
    myRatingSubmitted: !!rated.rowCount,
    lateCancellation: a.late_cancellation,
  };
}

/** Releases a slot back to the job and tells the waitlist (first-come notification; no auto-assignment). */
export async function releaseSlot(c: Client, jobId: string) {
  const j = await c.query(
    `UPDATE jobs SET reserved_count = greatest(reserved_count - 1, 0),
       status = CASE WHEN status = 'filled' AND starts_at > now() THEN 'published' ELSE status END, updated_at = now()
     WHERE id = $1 RETURNING title, status`,
    [jobId],
  );
  if (j.rows[0]?.status !== 'published') return;
  const wl = await c.query(
    `UPDATE job_waitlist SET notified_at = now() WHERE (job_id, worker_id) IN (
       SELECT job_id, worker_id FROM job_waitlist WHERE job_id = $1 AND notified_at IS NULL ORDER BY created_at LIMIT 5) RETURNING worker_id`,
    [jobId],
  );
  if (wl.rowCount) {
    await notify(c, wl.rows.map((r) => r.worker_id), {
      type: 'waitlist_opening', title: '空きが出ました', body: `「${j.rows[0].title}」に空きが出ました。早めに確認してください`, entityType: 'job', entityId: jobId,
    });
  }
}

async function ledgerEntry(c: Client, a: any, type: string, amount: number, actor: Actor, reason?: string) {
  if (a.contract_type === 'other_legal_review') throw conflict('contract_type_unresolved', '契約区分が確定していない業務は計上できません');
  await c.query(
    `INSERT INTO ledger_entries(assignment_id, worker_id, org_id, contract_type, entry_type, amount_yen, reason, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.id, a.worker_id, a.org_id, a.contract_type, type, amount, reason ?? null, actor.id],
  );
}

/** Creates the earned (+expense) ledger entries on approval and moves the assignment to approved/payable. */
export async function approveAndBook(c: Client, a: any, amountYen: number, actor: Actor, reason?: string) {
  await ledgerEntry(c, a, 'earned', amountYen, actor, reason);
  const expenses = Number(a.expenses_reimbursed_yen ?? 0);
  if (expenses > 0) await ledgerEntry(c, a, 'expense', expenses, actor, '発注者負担の実費');
  const bank = await c.query('SELECT bank_ciphertext IS NOT NULL AS ok FROM app_users WHERE id = $1', [a.worker_id]);
  const state = bank.rows[0].ok ? 'payable' : 'approved';
  await c.query(`UPDATE assignments SET state = $2, completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = $1`, [a.id, state]);
  return state;
}

function isLateCancel(a: any, now = new Date()): boolean {
  const hours = Number(a.cancellation_policy?.freeCancelHoursBefore ?? 24);
  return now.getTime() > new Date(a.starts_at).getTime() - hours * 3_600_000;
}

/** Organisation-side cancellation of one assignment (job cancellation or reservation withdrawal), applying compensation rules. */
export async function cancelByOrganization(c: Client, a: any, actor: Actor, reason: string) {
  let compensation = 0;
  if (['accepted', 'traveling', 'checked_in', 'working'].includes(a.state) && isLateCancel(a)) {
    compensation = Math.floor((Number(a.accepted_amount_yen) * Number(a.cancellation_policy?.lateCancelCompensationPercent ?? 0)) / 100);
  }
  await c.query(`UPDATE assignments SET state = 'cancelled', updated_at = now(), location_sharing_until = now() WHERE id = $1`, [a.id]);
  if (compensation > 0) await ledgerEntry(c, a, 'compensation', compensation, actor, `発注者都合のキャンセル補償: ${reason}`);
  await notify(c, [a.worker_id], {
    type: 'assignment_cancelled_by_org', title: '業務がキャンセルされました',
    body: `「${a.title}」は発注者によりキャンセルされました${compensation > 0 ? `（補償 ¥${compensation.toLocaleString('ja-JP')}）` : ''}`,
    entityType: 'assignment', entityId: a.id,
  });
  await recordEvent(c, { entityType: 'assignment', entityId: a.id, eventType: 'cancelled_by_organization', actor, reason, payload: { compensationYen: compensation } });
  return compensation;
}

export const assignmentHandlers: HandlerMap = {
  async listMyAssignments(ctx, req) {
    const u = requireUser(req);
    const scope = query<{ scope?: string }>(req).scope ?? 'all';
    const cond: Record<string, string> = {
      active: `a.state IN ('accepted','traveling','checked_in','working','submitted','needs_revision')`,
      upcoming: `a.state IN ('reserved','accepted') AND j.starts_at > now()`,
      history: `a.state NOT IN ('reserved','accepted','traveling','checked_in','working','submitted','needs_revision')`,
      all: 'true',
    };
    const r = await ctx.db.query(
      `SELECT a.id FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.worker_id = $1 AND ${cond[scope] ?? 'true'} ORDER BY j.starts_at DESC LIMIT 100`,
      [u.id],
    );
    const out = [];
    for (const row of r.rows) out.push(await loadAssignmentView(ctx, ctx.db, row.id, u));
    return out;
  },

  async getAssignment(ctx, req) {
    const u = requireUser(req);
    return loadAssignmentView(ctx, ctx.db, params(req).assignmentId!, u);
  },

  async advanceAssignment(ctx, req) {
    const u = requireUser(req);
    const b = body<{ eventType: string; stepIndex?: number; evidenceIds?: string[]; note?: string; location?: Point; occurredAt?: string }>(req);
    const id = params(req).assignmentId!;
    const res = await withIdempotency(ctx, req, 'advanceAssignment', async (c) => {
      const a = await loadRow(c, id, true);
      if (!a || a.worker_id !== u.id) throw notFound('業務が見つかりません');
      const actor: Actor = { id: u.id, role: 'worker' };
      const now = new Date();
      const evidenceIds = [...new Set(b.evidenceIds ?? [])];
      if (evidenceIds.length) {
        const ev = await c.query(`SELECT count(*)::int AS n FROM evidence WHERE id = ANY($1) AND assignment_id = $2 AND status = 'verified' AND deleted_at IS NULL`, [evidenceIds, id]);
        if (ev.rows[0].n !== evidenceIds.length) throw badRequest('evidence_invalid', '写真のアップロードが完了していません');
      }
      const need = (states: string[]) => {
        if (!states.includes(a.state)) throw conflict('invalid_state', `現在の状態では操作できません（${a.state}）`, { state: a.state });
      };

      const noop = ['traveling', 'checked_in', 'working'].includes(b.eventType) && a.state === b.eventType;
      switch (b.eventType) {
        case 'traveling': {
          if (a.state === 'traveling') break;
          need(['accepted']);
          if (now.getTime() < new Date(a.starts_at).getTime() - 3 * 3_600_000) throw conflict('too_early', '移動開始は開始3時間前から記録できます');
          await c.query(`UPDATE assignments SET state = 'traveling', location_sharing_until = NULL, updated_at = now() WHERE id = $1`, [id]);
          break;
        }
        case 'checked_in': {
          if (a.state === 'checked_in') break;
          need(['accepted', 'traveling']);
          if (!b.location) throw badRequest('location_required', 'チェックインには現在地が必要です');
          if (now.getTime() < new Date(a.starts_at).getTime() - CHECKIN_EARLY_MIN * 60_000) throw conflict('too_early', `チェックインは開始${CHECKIN_EARLY_MIN}分前から可能です`);
          if (now > new Date(a.ends_at)) throw conflict('too_late', '終了時刻を過ぎているためチェックインできません。サポートに連絡してください');
          const d = haversineKm(b.location, a.job_loc) * 1000;
          if (d > a.check_in_radius_m) {
            throw conflict('too_far_from_site', `作業場所から約${Math.round(d)}m離れています（${a.check_in_radius_m}m以内でチェックインできます）`, { distanceMeters: Math.round(d) });
          }
          await c.query(`UPDATE assignments SET state = 'checked_in', checked_in_at = now(), checkin_point = $2::geography, updated_at = now() WHERE id = $1`, [id, toWkt(b.location)]);
          await notifyOrg(c, a.org_id, { type: 'worker_checked_in', title: 'チェックインしました', body: `「${a.title}」の担当者が到着しました`, entityType: 'assignment', entityId: id });
          break;
        }
        case 'working': {
          if (a.state === 'working') break;
          need(['checked_in']);
          await c.query(`UPDATE assignments SET state = 'working', work_started_at = now(), updated_at = now() WHERE id = $1`, [id]);
          break;
        }
        case 'step_completed': {
          need(['working', 'needs_revision']);
          const steps = a.steps as any[];
          if (b.stepIndex === undefined || b.stepIndex >= steps.length) throw badRequest('invalid_step', '手順の指定が正しくありません');
          const done = a.steps_completed as Record<string, string>;
          for (let i = 0; i < b.stepIndex; i++) if (!done[String(i)]) throw conflict('step_order', '前の手順を先に完了してください');
          if (steps[b.stepIndex].requiresPhoto && evidenceIds.length === 0 && !done[String(b.stepIndex)]) throw badRequest('photo_required', 'この手順には写真が必要です');
          await c.query(`UPDATE assignments SET steps_completed = steps_completed || jsonb_build_object($2::text, now()), updated_at = now() WHERE id = $1`, [id, String(b.stepIndex)]);
          break;
        }
        case 'submitted': {
          need(['working', 'needs_revision']);
          const done = a.steps_completed as Record<string, string>;
          const missing = (a.steps as any[]).map((s, i) => (!done[String(i)] ? s.title : null)).filter(Boolean);
          if (missing.length) throw conflict('steps_incomplete', `未完了の手順があります: ${missing.join('、')}`);
          const photos = await c.query(`SELECT count(*)::int AS n FROM evidence WHERE assignment_id = $1 AND purpose = 'work_photo' AND status = 'verified' AND deleted_at IS NULL`, [id]);
          if (photos.rows[0].n < a.min_photo_count) throw badRequest('photos_required', `完了報告には写真が${a.min_photo_count}枚以上必要です`);
          await c.query(
            `UPDATE assignments SET state = 'submitted', submitted_at = now(), report_note = $2, location_sharing_until = now(), updated_at = now() WHERE id = $1`,
            [id, b.note ?? null],
          );
          await notifyOrg(c, a.org_id, { type: 'assignment_submitted', title: '完了報告が届きました', body: `「${a.title}」の検収をお願いします`, entityType: 'assignment', entityId: id });
          break;
        }
        case 'cancelled': {
          need(['reserved', 'accepted', 'traveling']);
          const late = a.state !== 'reserved' && isLateCancel(a, now);
          await c.query(`UPDATE assignments SET state = 'cancelled', late_cancellation = $2, location_sharing_until = now(), updated_at = now() WHERE id = $1`, [id, late]);
          await releaseSlot(c, a.job_id);
          await notifyOrg(c, a.org_id, { type: 'assignment_cancelled_by_worker', title: '受諾がキャンセルされました', body: `「${a.title}」の担当者がキャンセルしました。再募集中です`, entityType: 'assignment', entityId: id });
          break;
        }
        case 'safety_alert':
        case 'help_requested': {
          need(['accepted', 'traveling', 'checked_in', 'working']);
          const text = b.eventType === 'safety_alert' ? '危険・安全上の問題が報告されました' : 'ヘルプが要請されました';
          await notifyAdmins(c, { type: b.eventType, title: text, body: `業務「${a.title}」`, entityType: 'assignment', entityId: id });
          await notifyOrg(c, a.org_id, { type: b.eventType, title: text, body: `「${a.title}」の担当者から連絡がありました`, entityType: 'assignment', entityId: id });
          await createTicket(c, u.id, 'safety', `${text}${b.note ? `: ${b.note}` : ''}`, id, a.job_id);
          break;
        }
        default:
          throw badRequest('validation', '不明な操作です');
      }
      if (!noop) await recordEvent(c, {
        entityType: 'assignment', entityId: id, eventType: b.eventType, actor, reason: b.note ?? null,
        payload: { stepIndex: b.stepIndex, evidence: evidenceIds.length, occurredAt: b.occurredAt, late: b.eventType === 'cancelled' ? isLateCancel(a, now) : undefined },
      });
      return { status: 200, body: await loadAssignmentView(ctx, c, id, u) };
    });
    return res.body;
  },

  async shareLocation(ctx, req, reply) {
    const u = requireUser(req);
    const b = body<{ location: Point; accuracyMeters?: number }>(req);
    const a = (await ctx.db.query('SELECT id, state, worker_id, location_sharing_until FROM assignments WHERE id = $1', [params(req).assignmentId])).rows[0];
    if (!a || a.worker_id !== u.id) throw notFound('業務が見つかりません');
    if (!ACTIVE_STATES.includes(a.state) || (a.location_sharing_until && new Date(a.location_sharing_until) < new Date())) {
      throw conflict('location_sharing_inactive', '業務中ではないため位置は共有されません');
    }
    await ctx.db.query('INSERT INTO location_samples(assignment_id, point, accuracy_m) VALUES ($1,$2::geography,$3)', [a.id, toWkt(b.location), b.accuracyMeters ?? null]);
    reply.code(204);
  },

  async getLiveLocation(ctx, req) {
    const u = requireUser(req);
    const a = await loadRow(ctx.db, params(req).assignmentId!);
    if (!a) throw notFound();
    const v = await viewerOf(ctx.db, u, a);
    if (v === 'worker') throw notFound();
    if (!ACTIVE_STATES.includes(a.state) || (a.location_sharing_until && new Date(a.location_sharing_until) < new Date())) throw notFound('業務中のみ位置を確認できます');
    const r = await ctx.db.query(
      `SELECT ${pointSql('point')} AS p, recorded_at FROM location_samples WHERE assignment_id = $1 AND recorded_at > now() - interval '15 minutes' ORDER BY recorded_at DESC LIMIT 1`,
      [a.id],
    );
    if (!r.rows[0]) throw notFound('最新の位置情報がありません');
    return { location: r.rows[0].p, recordedAt: r.rows[0].recorded_at };
  },

  async rateAssignment(ctx, req, reply) {
    const u = requireUser(req);
    const b = body<{ score: number; comment?: string }>(req);
    await withTx(ctx.db, async (c) => {
      const a = await loadRow(c, params(req).assignmentId!);
      if (!a) throw notFound();
      const v = await viewerOf(c, u, a);
      if (v === 'admin') throw forbidden();
      if (!['approved', 'payable', 'paid'].includes(a.state)) throw conflict('invalid_state', '検収完了後に評価できます');
      const role = v === 'worker' ? 'worker' : 'organization';
      const ins = await c.query(
        `INSERT INTO ratings(assignment_id, rater_role, rater_id, ratee_user_id, ratee_org_id, score, comment) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [a.id, role, u.id, role === 'organization' ? a.worker_id : null, role === 'worker' ? a.org_id : null, b.score, b.comment ?? null],
      );
      if (!ins.rowCount) throw conflict('already_rated', '評価済みです');
      await recordEvent(c, { entityType: 'assignment', entityId: a.id, eventType: 'rated', actor: { id: u.id, role }, payload: { score: b.score } });
    });
    reply.code(204);
  },

  async decideReservation(ctx, req) {
    const u = requireUser(req);
    const b = body<{ decision: 'approve' | 'decline'; reason?: string }>(req);
    const id = params(req).assignmentId!;
    const res = await withIdempotency(ctx, req, 'decideReservation', async (c) => {
      const a = await loadRow(c, id, true);
      if (!a) throw notFound();
      await requireOrgRole(ctx, u, a.org_id, ORG_ALL);
      if (a.state !== 'reserved') throw conflict('invalid_state', 'この応募は既に処理されています');
      if (a.reservation_expires_at && new Date(a.reservation_expires_at) < new Date()) throw conflict('reservation_expired', '承認期限が切れています');
      const actor = { id: u.id, role: 'organization' };
      if (b.decision === 'approve') {
        await c.query(`UPDATE assignments SET state = 'accepted', reservation_expires_at = NULL, updated_at = now() WHERE id = $1`, [id]);
        await notify(c, [a.worker_id], { type: 'reservation_approved', title: '応募が承認されました', body: `「${a.title}」の受諾が確定しました`, entityType: 'assignment', entityId: id });
      } else {
        await c.query(`UPDATE assignments SET state = 'declined', updated_at = now() WHERE id = $1`, [id]);
        await releaseSlot(c, a.job_id);
        await notify(c, [a.worker_id], { type: 'reservation_declined', title: '応募は見送りになりました', body: `「${a.title}」は今回見送りとなりました`, entityType: 'assignment', entityId: id });
      }
      await recordEvent(c, { entityType: 'assignment', entityId: id, eventType: b.decision === 'approve' ? 'reservation_approved' : 'reservation_declined', actor, reason: b.reason ?? null });
      return { status: 200, body: await loadAssignmentView(ctx, c, id, u) };
    });
    return res.body;
  },

  async reviewAssignment(ctx, req) {
    const u = requireUser(req);
    const b = body<{ decision: 'approved' | 'needs_revision' | 'disputed'; reason?: string }>(req);
    const id = params(req).assignmentId!;
    if (b.decision !== 'approved' && !b.reason?.trim()) throw badRequest('reason_required', '差戻し・異議の理由を入力してください');
    const res = await withIdempotency(ctx, req, 'reviewAssignment', async (c) => {
      const a = await loadRow(c, id, true);
      if (!a) throw notFound();
      await requireOrgRole(ctx, u, a.org_id, ORG_ALL);
      if (a.state !== 'submitted') throw conflict('invalid_state', '完了報告済みの業務のみ検収できます');
      const actor = { id: u.id, role: 'organization' };
      if (b.decision === 'approved') {
        const state = await approveAndBook(c, a, Number(a.accepted_amount_yen), actor, '検収完了');
        await c.query('UPDATE assignments SET review_reason = $2 WHERE id = $1', [id, b.reason ?? null]);
        await notify(c, [a.worker_id], {
          type: 'assignment_approved', title: '検収が完了しました',
          body: state === 'payable' ? `「${a.title}」の報酬が確定しました（振込予定日はマイページで確認できます）` : `「${a.title}」の報酬が確定しました。振込先を登録してください`,
          entityType: 'assignment', entityId: id,
        });
      } else if (b.decision === 'needs_revision') {
        await c.query(`UPDATE assignments SET state = 'needs_revision', review_reason = $2, updated_at = now() WHERE id = $1`, [id, b.reason]);
        await notify(c, [a.worker_id], { type: 'assignment_needs_revision', title: '完了報告が差し戻されました', body: `「${a.title}」: ${b.reason}`, entityType: 'assignment', entityId: id });
      } else {
        await c.query(`UPDATE assignments SET state = 'disputed', review_reason = $2, updated_at = now() WHERE id = $1`, [id, b.reason]);
        await notify(c, [a.worker_id], { type: 'assignment_disputed', title: '業務内容に異議が申し立てられました', body: `「${a.title}」は運営が確認します`, entityType: 'assignment', entityId: id });
        await notifyAdmins(c, { type: 'dispute_opened', title: '紛争対応が必要です', body: `業務「${a.title}」`, entityType: 'assignment', entityId: id });
        await bumpMetric(c, 'dispute_opened');
      }
      await recordEvent(c, { entityType: 'assignment', entityId: id, eventType: `review_${b.decision}`, actor, reason: b.reason ?? null });
      return { status: 200, body: await loadAssignmentView(ctx, c, id, u) };
    });
    return res.body;
  },

  async reportNoShow(ctx, req) {
    const u = requireUser(req);
    const reason = body<{ reason: string }>(req).reason;
    const id = params(req).assignmentId!;
    const res = await withIdempotency(ctx, req, 'reportNoShow', async (c) => {
      const a = await loadRow(c, id, true);
      if (!a) throw notFound();
      await requireOrgRole(ctx, u, a.org_id, ORG_ALL);
      if (!['accepted', 'traveling'].includes(a.state)) throw conflict('invalid_state', 'チェックイン前の業務のみ無断欠勤として記録できます');
      if (Date.now() < new Date(a.starts_at).getTime() + NO_SHOW_GRACE_MIN * 60_000) throw conflict('too_early', `開始時刻から${NO_SHOW_GRACE_MIN}分経過後に記録できます`);
      await c.query(`UPDATE assignments SET state = 'no_show', location_sharing_until = now(), updated_at = now() WHERE id = $1`, [id]);
      await releaseSlot(c, a.job_id);
      await notify(c, [a.worker_id], { type: 'no_show_recorded', title: '無断欠勤として記録されました', body: `「${a.title}」。事情がある場合はサポートへご連絡ください`, entityType: 'assignment', entityId: id });
      await recordEvent(c, { entityType: 'assignment', entityId: id, eventType: 'no_show', actor: { id: u.id, role: 'organization' }, reason });
      return { status: 200, body: await loadAssignmentView(ctx, c, id, u) };
    });
    return res.body;
  },
};

export async function loadAssignmentRowForAdmin(c: pg.PoolClient, id: string) {
  return loadRow(c, id, true);
}

export { LIVE_STATES };
