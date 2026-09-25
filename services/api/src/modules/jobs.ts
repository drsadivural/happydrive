import type pg from 'pg';
import type { AppContext, AuthUser, HandlerMap } from '../context.js';
import { body, params, query, requireUser } from '../context.js';
import type { Client } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { bumpMetric, recordEvent } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';
import { pointSql, type Point } from '../lib/geo.js';
import { addMinutes, jstDate, jstStartOfDay } from '../lib/time.js';
import { notifyOrg } from '../lib/notify.js';
import { requireWorker } from '../auth/rbac.js';
import { createTicket } from './identity.js';
import { loadAssignmentView } from './assignments.js';
import { getRouteView } from './delivery.js';
import {
  EXCLUSION_LABEL, distanceKm, exclusions, loadMatchingConfig, loadWorkerContext, score,
  type Exclusion, type JobForMatch,
} from './matching.js';

export const PAYOUT_POLICY_TEXT = '検収完了後、3日以上経過した最初の15日または月末に振込予定（振込先の登録と本人確認が必要）';

export const JOB_COLUMNS = `j.*, o.legal_name AS org_name, o.review_status AS org_status, o.address AS org_address, o.contact AS org_contact,
  ${pointSql('j.public_point')} AS approx, ${pointSql('j.location')} AS loc,
  (SELECT coalesce(array_agg(sd.name ORDER BY sd.name), '{}') FROM skill_definitions sd WHERE sd.code = ANY(j.required_skills)) AS skill_names`;

export function jobPublicView(j: any) {
  return {
    id: j.id,
    organizationId: j.org_id,
    organizationName: j.org_name,
    organizationVerified: j.org_status === 'approved',
    organizationAddress: j.org_address,
    organizationContact: j.org_contact,
    title: j.title,
    category: j.category,
    contractType: j.contract_type,
    status: j.status,
    startsAt: j.starts_at,
    endsAt: j.ends_at,
    amountYen: j.amount_yen,
    expensesReimbursedYen: j.expenses_reimbursed_yen,
    workerBorneCostsNote: j.worker_borne_costs_note ?? undefined,
    capacity: j.capacity,
    remainingCapacity: Math.max(0, j.capacity - j.reserved_count),
    areaLabel: j.area_label,
    approximateLocation: j.approx,
    description: j.description,
    requiredSkills: j.required_skills,
    requiredSkillNames: j.skill_names ?? [],
    cancellationPolicy: j.cancellation_policy,
    steps: j.steps,
    minPhotoCount: j.min_photo_count,
    requiresOrgApproval: j.requires_org_approval,
    meetingPointNote: j.meeting_point_note ?? undefined,
    safetyNotes: j.safety_notes ?? undefined,
    contactName: j.contact_name ?? undefined,
    paymentTermsText: j.payment_terms_text ?? undefined,
    employmentTermsText: j.employment_terms_text ?? undefined,
    durationMinutes: Math.round((new Date(j.ends_at).getTime() - new Date(j.starts_at).getTime()) / 60_000),
    publishedAt: j.published_at ?? undefined,
    termsHash: j.terms_hash ?? undefined,
  };
}

/** The conditions a worker agrees to. Stored verbatim on the assignment at acceptance. */
export function termsSnapshot(j: any, workerFeePercent: number) {
  const workerFeeYen = Math.floor((Number(j.amount_yen) * workerFeePercent) / 100);
  return {
    jobTitle: j.title,
    organizationName: j.org_name,
    contractType: j.contract_type,
    startsAt: new Date(j.starts_at).toISOString(),
    endsAt: new Date(j.ends_at).toISOString(),
    amountYen: Number(j.amount_yen),
    expensesReimbursedYen: Number(j.expenses_reimbursed_yen),
    workerFeePercent,
    workerFeeYen,
    netAmountYen: Number(j.amount_yen) - workerFeeYen,
    workerBorneCostsNote: j.worker_borne_costs_note ?? null,
    cancellationPolicy: j.cancellation_policy,
    paymentTermsText: j.payment_terms_text ?? null,
    employmentTermsText: j.employment_terms_text ?? null,
    payoutPolicy: PAYOUT_POLICY_TEXT,
  };
}

export const termsHashOf = (j: any, workerFeePercent: number) => sha256Hex(canonicalJson(termsSnapshot(j, workerFeePercent))).slice(0, 32);

export function toMatchJob(j: any): JobForMatch {
  return {
    id: j.id, orgId: j.org_id, category: j.category, startsAt: new Date(j.starts_at), endsAt: new Date(j.ends_at),
    requiredSkills: j.required_skills, remaining: j.capacity - j.reserved_count, point: j.approx,
  };
}

interface SearchQuery {
  latitude?: number; longitude?: number; radiusKm?: number; areaQuery?: string; q?: string; category?: string; date?: string;
  startAfterHour?: number; minAmountYen?: number; eligibleOnly?: boolean; favoritesOnly?: boolean;
  sort?: 'recommended' | 'distance' | 'starts_at' | 'amount'; cursor?: string; limit?: number;
}

async function workerExtras(c: Client, workerId: string, jobIds: string[]) {
  const fav = await c.query('SELECT job_id FROM job_favorites WHERE worker_id = $1 AND job_id = ANY($2)', [workerId, jobIds]);
  const wl = await c.query('SELECT job_id FROM job_waitlist WHERE worker_id = $1 AND job_id = ANY($2)', [workerId, jobIds]);
  const mine = await c.query(`SELECT job_id, id FROM assignments WHERE worker_id = $1 AND job_id = ANY($2) AND state NOT IN ('cancelled','declined','expired','no_show')`, [workerId, jobIds]);
  return {
    fav: new Set(fav.rows.map((r) => r.job_id)),
    wl: new Set(wl.rows.map((r) => r.job_id)),
    mine: new Map(mine.rows.map((r) => [r.job_id, r.id])),
  };
}

/** Core search shared by GET /jobs and the home screen. */
export async function searchJobsFor(ctx: AppContext, u: AuthUser, q: SearchQuery) {
  const cfg = await loadMatchingConfig(ctx.db);
  const w = await loadWorkerContext(ctx.db, u.id, ctx.cfg.termsVersion);
  const here: Point | undefined = q.latitude !== undefined && q.longitude !== undefined ? { latitude: q.latitude, longitude: q.longitude } : undefined;
  const sort = q.sort ?? 'recommended';
  const maxKm = q.radiusKm ?? w.preferences.maxDistanceKm ?? cfg.maxDistanceKm;

  const where = [`j.status IN ('published','filled')`, `j.starts_at > now()`, `o.review_status = 'approved'`,
    `NOT EXISTS (SELECT 1 FROM org_blocks b WHERE b.worker_id = $1 AND b.org_id = j.org_id)`];
  const vals: unknown[] = [u.id];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  if (q.category) add('j.category = ?', q.category);
  if (q.date) {
    add('j.starts_at >= ?', jstStartOfDay(q.date));
    add(`j.starts_at < ?::timestamptz + interval '1 day'`, jstStartOfDay(q.date));
  }
  if (q.startAfterHour !== undefined) add(`extract(hour FROM j.starts_at AT TIME ZONE 'Asia/Tokyo') >= ?`, q.startAfterHour);
  if (q.minAmountYen !== undefined) add('j.amount_yen >= ?', q.minAmountYen);
  if (q.q) {
    vals.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
    const p = `$${vals.length}`;
    where.push(`(j.title ILIKE ${p} OR j.description ILIKE ${p} OR o.legal_name ILIKE ${p})`);
  }
  if (q.areaQuery) add('j.area_label ILIKE ?', `%${q.areaQuery.replace(/[%_\\]/g, '\\$&')}%`);
  if (q.favoritesOnly) where.push('EXISTS (SELECT 1 FROM job_favorites f WHERE f.worker_id = $1 AND f.job_id = j.id)');
  if (here && q.radiusKm !== undefined) {
    vals.push(here.longitude, here.latitude, q.radiusKm * 1000);
    where.push(`ST_DWithin(j.public_point, ST_SetSRID(ST_MakePoint($${vals.length - 2}, $${vals.length - 1}), 4326)::geography, $${vals.length})`);
  }
  const r = await ctx.db.query(
    `SELECT ${JOB_COLUMNS} FROM jobs j JOIN organizations o ON o.id = j.org_id WHERE ${where.join(' AND ')} ORDER BY j.starts_at LIMIT 500`,
    vals,
  );

  type Item = { row: any; dist?: number; excl: Exclusion[]; score?: number; reasons: string[] };
  let items: Item[] = r.rows.map((row) => {
    const mj = toMatchJob(row);
    const dist = distanceKm(here, mj.point);
    const excl = exclusions(w, mj, sort === 'recommended' ? dist : undefined, maxKm);
    const s = excl.length ? undefined : score(w, mj, dist, cfg);
    return { row, dist, excl, score: s?.score, reasons: s?.reasons ?? [] };
  });

  if (sort === 'recommended') {
    const excluded = items.filter((i) => i.excl.length);
    items = items.filter((i) => !i.excl.length).sort((a, b) => b.score! - a.score! || a.row.starts_at - b.row.starts_at);
    // Audit trail for fairness / exclusion monitoring (bounded per search).
    const sample = [
      ...items.slice(0, 20).map((i) => [u.id, i.row.id, i.score, i.reasons, null]),
      ...excluded.slice(0, 30).map((i) => [u.id, i.row.id, null, [], i.excl[0]]),
    ];
    if (sample.length) {
      const flat = sample.flat();
      const ph = sample.map((_, k) => `($${k * 5 + 1},$${k * 5 + 2},$${k * 5 + 3},$${k * 5 + 4},$${k * 5 + 5})`).join(',');
      await ctx.db.query(`INSERT INTO match_impressions(worker_id, job_id, score, reasons, excluded_reason) VALUES ${ph}`, flat);
    }
  } else {
    if (q.eligibleOnly) items = items.filter((i) => !i.excl.length);
    if (sort === 'distance') items.sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
    if (sort === 'amount') items.sort((a, b) => b.row.amount_yen - a.row.amount_yen);
  }

  const limit = q.limit ?? 20;
  let offset = 0;
  if (q.cursor) {
    try {
      offset = Number(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()).o) || 0;
    } catch {
      throw badRequest('invalid_cursor', 'ページ指定が正しくありません');
    }
  }
  const page = items.slice(offset, offset + limit);
  const extras = await workerExtras(ctx.db, u.id, page.map((p) => p.row.id));
  return {
    items: page.map((p) => ({
      ...jobPublicView(p.row),
      distanceKm: p.dist,
      matchReasons: p.reasons,
      matchScore: p.score,
      eligible: p.excl.length === 0,
      ineligibleReasons: p.excl.map((e) => EXCLUSION_LABEL[e]),
      isFavorite: extras.fav.has(p.row.id),
      waitlisted: extras.wl.has(p.row.id),
      myAssignmentId: extras.mine.get(p.row.id),
    })),
    nextCursor: offset + limit < items.length ? Buffer.from(JSON.stringify({ o: offset + limit })).toString('base64url') : undefined,
  };
}

async function loadJob(c: Client, id: string, lock = false) {
  const r = await c.query(`SELECT ${JOB_COLUMNS} FROM jobs j JOIN organizations o ON o.id = j.org_id WHERE j.id = $1 ${lock ? 'FOR UPDATE OF j' : ''}`, [id]);
  return r.rows[0] ?? null;
}

function eligibilityError(excl: Exclusion[]): AppError {
  const first = excl[0]!;
  if (first === 'full') return conflict('capacity_full', '募集枠が埋まりました。空き待ちに登録できます');
  if (first === 'time_conflict') return conflict('time_conflict', EXCLUSION_LABEL.time_conflict);
  return new AppError(403, 'not_eligible', EXCLUSION_LABEL[first], { reasons: excl.map((e) => EXCLUSION_LABEL[e]), codes: excl });
}

/**
 * Atomic acceptance: the job row is locked, eligibility and capacity are validated and the slot is
 * reserved in one transaction. The partial unique index backs up the one-live-assignment-per-worker rule.
 */
async function acceptInTx(ctx: AppContext, c: pg.PoolClient, u: AuthUser, jobId: string, termsHash: string | undefined) {
  const j = await loadJob(c, jobId, true);
  if (!j || !['published', 'filled'].includes(j.status) || j.org_status !== 'approved') throw notFound('この案件は現在募集していません');
  if (new Date(j.starts_at) <= new Date()) throw conflict('job_started', 'この案件は開始時刻を過ぎています');
  const currentHash = termsHashOf(j, ctx.cfg.workerFeePercent);
  if (termsHash && termsHash !== currentHash) throw conflict('terms_changed', '案件の条件が変更されました。最新の内容を確認してください');
  const mine = await c.query(`SELECT id FROM assignments WHERE job_id = $1 AND worker_id = $2 AND state NOT IN ('cancelled','declined','expired','no_show')`, [jobId, u.id]);
  if (mine.rowCount) throw conflict('already_accepted', 'この案件は受諾済みです', { assignmentId: mine.rows[0].id });
  const w = await loadWorkerContext(c, u.id, ctx.cfg.termsVersion);
  const excl = exclusions(w, toMatchJob(j), undefined, undefined);
  if (excl.length) throw eligibilityError(excl);

  const reserved = j.requires_org_approval;
  const a = await c.query(
    `INSERT INTO assignments(job_id, worker_id, state, accepted_amount_yen, terms_snapshot, reservation_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [jobId, u.id, reserved ? 'reserved' : 'accepted', j.amount_yen, termsSnapshot(j, ctx.cfg.workerFeePercent),
      reserved ? addMinutes(new Date(), j.reservation_ttl_minutes) : null],
  );
  await c.query(
    `UPDATE jobs SET reserved_count = reserved_count + 1,
       status = CASE WHEN reserved_count + 1 >= capacity THEN 'filled' ELSE status END, updated_at = now() WHERE id = $1`,
    [jobId],
  );
  await c.query('DELETE FROM job_waitlist WHERE job_id = $1 AND worker_id = $2', [jobId, u.id]);
  await notifyOrg(c, j.org_id, reserved
    ? { type: 'reservation_pending', title: '承認待ちの応募があります', body: `「${j.title}」に応募がありました。期限内に承認してください`, entityType: 'assignment', entityId: a.rows[0].id }
    : { type: 'job_accepted', title: '案件が受諾されました', body: `「${j.title}」が受諾されました`, entityType: 'assignment', entityId: a.rows[0].id });
  await recordEvent(c, {
    entityType: 'assignment', entityId: a.rows[0].id, eventType: reserved ? 'reserved' : 'accepted', actor: { id: u.id, role: 'worker' },
    payload: { jobId, amountYen: Number(j.amount_yen), termsHash: currentHash },
  });
  return a.rows[0].id as string;
}

export const jobHandlers: HandlerMap = {
  async searchJobs(ctx, req) {
    const u = requireUser(req);
    return searchJobsFor(ctx, u, query<SearchQuery>(req));
  },

  async getJob(ctx, req) {
    const u = requireUser(req);
    const j = await loadJob(ctx.db, params(req).jobId!);
    if (!j) throw notFound('案件が見つかりません');
    const visible = ['published', 'filled'].includes(j.status) && j.org_status === 'approved';
    const extras = await workerExtras(ctx.db, u.id, [j.id]);
    if (!visible && !extras.mine.has(j.id)) throw notFound('案件が見つかりません');
    const w = await loadWorkerContext(ctx.db, u.id, ctx.cfg.termsVersion);
    const cfg = await loadMatchingConfig(ctx.db);
    const mj = toMatchJob(j);
    const excl = extras.mine.has(j.id) ? [] : exclusions(w, mj, undefined, undefined);
    const s = excl.length ? undefined : score(w, mj, undefined, cfg);
    return {
      ...jobPublicView(j),
      termsHash: termsHashOf(j, ctx.cfg.workerFeePercent),
      matchReasons: s?.reasons ?? [],
      eligible: excl.length === 0,
      ineligibleReasons: excl.map((e) => EXCLUSION_LABEL[e]),
      isFavorite: extras.fav.has(j.id),
      waitlisted: extras.wl.has(j.id),
      myAssignmentId: extras.mine.get(j.id),
    };
  },

  async acceptJob(ctx, req, reply) {
    const u = requireUser(req);
    requireWorker(u);
    const raw = (req.body ?? {}) as { termsHash?: unknown };
    if (raw.termsHash !== undefined && typeof raw.termsHash !== 'string') throw badRequest('validation', 'termsHash が正しくありません');
    const jobId = params(req).jobId!;
    try {
      const res = await withIdempotency(ctx, req, 'acceptJob', async (c) => {
        const id = await acceptInTx(ctx, c, u, jobId, raw.termsHash as string | undefined);
        return { status: 201, body: await loadAssignmentView(ctx, c, id, u) };
      });
      reply.code(res.status);
      return res.body;
    } catch (e) {
      if (e instanceof AppError && e.code === 'capacity_full') await bumpMetric(ctx.db, 'accept_conflict');
      throw e;
    }
  },

  async favoriteJob(ctx, req, reply) {
    const u = requireUser(req);
    const j = await loadJob(ctx.db, params(req).jobId!);
    if (!j || !['published', 'filled'].includes(j.status)) throw notFound('案件が見つかりません');
    await ctx.db.query('INSERT INTO job_favorites(worker_id, job_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, j.id]);
    reply.code(204);
  },

  async unfavoriteJob(ctx, req, reply) {
    const u = requireUser(req);
    await ctx.db.query('DELETE FROM job_favorites WHERE worker_id = $1 AND job_id = $2', [u.id, params(req).jobId]);
    reply.code(204);
  },

  async joinWaitlist(ctx, req, reply) {
    const u = requireUser(req);
    requireWorker(u);
    const j = await loadJob(ctx.db, params(req).jobId!);
    if (!j || !['published', 'filled'].includes(j.status) || new Date(j.starts_at) <= new Date()) throw notFound('案件が見つかりません');
    if (j.reserved_count < j.capacity) throw conflict('capacity_available', '空き枠があります。そのまま受諾できます');
    const mine = await ctx.db.query(`SELECT 1 FROM assignments WHERE job_id = $1 AND worker_id = $2 AND state NOT IN ('cancelled','declined','expired','no_show')`, [j.id, u.id]);
    if (mine.rowCount) throw conflict('already_accepted', 'この案件は受諾済みです');
    await ctx.db.query('INSERT INTO job_waitlist(job_id, worker_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [j.id, u.id]);
    reply.code(204);
  },

  async leaveWaitlist(ctx, req, reply) {
    const u = requireUser(req);
    await ctx.db.query('DELETE FROM job_waitlist WHERE job_id = $1 AND worker_id = $2', [params(req).jobId, u.id]);
    reply.code(204);
  },

  async createMatchingAppeal(ctx, req, reply) {
    const u = requireUser(req);
    const b = body<{ jobId?: string; body: string }>(req);
    const res = await withIdempotency(ctx, req, 'createMatchingAppeal', async (c) => {
      if (b.jobId && !(await loadJob(c, b.jobId))) throw notFound('案件が見つかりません');
      return { status: 201, body: await createTicket(c, u.id, 'matching_appeal', b.body, null, b.jobId ?? null) };
    });
    reply.code(res.status);
    return res.body;
  },

  async getHome(ctx, req) {
    const u = requireUser(req);
    const q = query<{ latitude?: number; longitude?: number }>(req);
    const today = jstDate(new Date());
    const [stops, unread] = await Promise.all([
      ctx.db.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('delivered','failed'))::int AS done
         FROM delivery_stops WHERE worker_id = $1 AND scheduled_date = $2 AND deleted_at IS NULL`,
        [u.id, today],
      ),
      ctx.db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [u.id]),
    ]);
    const todays = await ctx.db.query(
      `SELECT a.id FROM assignments a JOIN jobs j ON j.id = a.job_id
       WHERE a.worker_id = $1 AND a.state IN ('reserved','accepted','traveling','checked_in','working','submitted','needs_revision')
         AND j.starts_at >= $2 AND j.starts_at < $2::timestamptz + interval '1 day' ORDER BY j.starts_at`,
      [u.id, jstStartOfDay(today)],
    );
    const assignments = [];
    for (const row of todays.rows) assignments.push(await loadAssignmentView(ctx, ctx.db, row.id, u));
    const todayRoute = await getRouteView(ctx.db, u.id, today);
    const nearby = await searchJobsFor(ctx, u, { latitude: q.latitude, longitude: q.longitude, sort: 'recommended', limit: 3 });
    const me = await ctx.db.query('SELECT verification_status, terms_version, profile_ciphertext IS NOT NULL AS p FROM app_users WHERE id = $1', [u.id]);
    const m = me.rows[0];
    return {
      todayStopCount: stops.rows[0].total,
      todayCompletedStopCount: stops.rows[0].done,
      todayRoute: todayRoute ?? undefined,
      todayAssignments: assignments,
      expectedEarningsYen: assignments.filter((a) => a.state !== 'reserved').reduce((s, a) => s + (a.acceptedAmountYen ?? 0), 0),
      unreadNotificationCount: unread.rows[0].n,
      nearbyJobs: nearby.items,
      onboardingComplete: m.verification_status === 'verified' && m.terms_version === ctx.cfg.termsVersion && m.p,
    };
  },
};

export { loadJob };
