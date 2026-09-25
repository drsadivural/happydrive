import type pg from 'pg';
import type { AppContext, HandlerMap } from '../context.js';
import { body, params, query, requireUser } from '../context.js';
import { withTx, type Client } from '../db/pool.js';
import { badRequest, conflict, gone, notFound } from '../lib/errors.js';
import { bumpMetric, recordEvent } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { pointSql, toWkt, type Point } from '../lib/geo.js';
import { jstDate, jstDateTime } from '../lib/time.js';
import { requireWorker } from '../auth/rbac.js';
import { EstimatedTravelTime, optimize, simulate, type RouteStopInput } from './routing/optimizer.js';
import { parseCsv } from '../lib/csv.js';

const MAX_IMPORT_ROWS = 500;
const FINAL = ['delivered', 'failed'];

/** Normalises Japanese addresses for duplicate detection (full/half width, dashes, 丁目/番地/号). */
export function normalizeAddress(a: string): string {
  return a
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[‐‑‒–—―ー−－]/g, '-')
    .replace(/(丁目|番地|番)/g, '-')
    .replace(/号/g, '')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
    .toLowerCase();
}

const STOP_COLUMNS = `s.*, ${pointSql('s.location')} AS loc,
  (SELECT coalesce(array_agg(e.id ORDER BY e.created_at), '{}') FROM evidence e WHERE e.delivery_stop_id = s.id AND e.status = 'verified') AS evidence_ids`;

export function stopView(ctx: AppContext, s: any) {
  return {
    id: s.id,
    status: s.status,
    address: ctx.cipher.decrypt(s.address_ciphertext),
    scheduledDate: s.scheduled_date,
    location: s.loc ?? undefined,
    hasLocation: !!s.loc,
    timeWindowStart: s.time_start ?? undefined,
    timeWindowEnd: s.time_end ?? undefined,
    note: ctx.cipher.decryptNullable(s.note_ciphertext),
    recipientName: ctx.cipher.decryptNullable(s.recipient_name_ciphertext),
    hasRecipientPhone: !!s.recipient_phone_ciphertext,
    packageNumber: s.package_number ?? undefined,
    priority: s.priority,
    serviceMinutes: s.service_minutes,
    sequence: s.sequence ?? undefined,
    estimatedArrivalAt: s.estimated_arrival_at ?? undefined,
    failureReason: s.failure_reason ?? undefined,
    failureNote: s.failure_note ?? undefined,
    deferredUntil: s.deferred_until ?? undefined,
    handoff: s.handoff ?? undefined,
    completedAt: s.completed_at ?? undefined,
    evidenceIds: s.evidence_ids ?? [],
    duplicateOfStopId: s.duplicate_of ?? undefined,
    version: s.version,
    source: s.source,
  };
}

async function loadStop(c: Client, workerId: string, id: string, lock = false) {
  const r = await c.query(
    `SELECT ${STOP_COLUMNS} FROM delivery_stops s WHERE s.id = $1 AND s.worker_id = $2 AND s.deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
    [id, workerId],
  );
  if (!r.rows[0]) throw notFound('配送先が見つかりません');
  return r.rows[0];
}

interface NewStopInput {
  address: string;
  scheduledDate: string;
  location?: Point;
  timeWindowStart?: string;
  timeWindowEnd?: string;
  note?: string;
  recipientName?: string;
  recipientPhone?: string;
  packageNumber?: string;
  priority?: number;
  serviceMinutes?: number;
  source?: 'manual' | 'csv' | 'ocr';
  allowDuplicate?: boolean;
}

function validateWindow(s: { timeWindowStart?: string | null; timeWindowEnd?: string | null }) {
  if (s.timeWindowStart && s.timeWindowEnd && Date.parse(s.timeWindowEnd) <= Date.parse(s.timeWindowStart)) {
    throw badRequest('invalid_time_window', '指定時間の終了は開始より後にしてください');
  }
}

async function findDuplicate(c: Client, ctx: AppContext, workerId: string, date: string, address: string): Promise<string | null> {
  const r = await c.query(
    `SELECT id FROM delivery_stops WHERE worker_id = $1 AND scheduled_date = $2 AND address_norm_hash = $3 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    [workerId, date, ctx.cipher.blindIndex(normalizeAddress(address))],
  );
  return r.rows[0]?.id ?? null;
}

async function insertStop(c: Client, ctx: AppContext, workerId: string, s: NewStopInput, duplicateOf: string | null): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO delivery_stops(worker_id, scheduled_date, address_ciphertext, address_norm_hash, location, time_start, time_end, status,
       note_ciphertext, recipient_name_ciphertext, recipient_phone_ciphertext, package_number, priority, service_minutes, source, duplicate_of)
     VALUES ($1,$2,$3,$4,$5::geography,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [
      workerId, s.scheduledDate, ctx.cipher.encrypt(s.address.trim()), ctx.cipher.blindIndex(normalizeAddress(s.address)),
      s.location ? toWkt(s.location) : null, s.timeWindowStart ?? null, s.timeWindowEnd ?? null, s.location ? 'ready' : 'draft',
      ctx.cipher.encryptNullable(s.note), ctx.cipher.encryptNullable(s.recipientName), ctx.cipher.encryptNullable(s.recipientPhone),
      s.packageNumber ?? null, s.priority ?? 0, s.serviceMinutes ?? 3, s.source ?? 'manual', duplicateOf,
    ],
  );
  return r.rows[0]!.id;
}

const TRANSITIONS: Record<string, string[]> = {
  en_route: ['ready', 'deferred'],
  arrived: ['ready', 'en_route', 'deferred'],
  delivered: ['ready', 'en_route', 'arrived'],
  failed: ['ready', 'en_route', 'arrived'],
  deferred: ['ready', 'en_route', 'arrived'],
};

function routeView(r: any) {
  return {
    id: r.id,
    date: r.scheduled_date,
    status: r.status === 'superseded' ? 'planned' : r.status,
    orderedStopIds: r.ordered_stop_ids,
    estimatedMinutes: r.estimated_minutes,
    totalDistanceKm: Number(r.total_distance_km),
    feasible: r.feasible,
    warnings: r.warnings,
    violations: r.violations,
    legs: r.legs,
    breaks: r.breaks,
    travelTimeSource: r.travel_time_source,
    departureAt: r.departure_at,
    startLocation: r.start_loc ?? undefined,
    createdAt: r.created_at,
    manuallyOrdered: r.manually_ordered,
  };
}

const ROUTE_COLUMNS = `r.*, ${pointSql('r.start_point')} AS start_loc, ${pointSql('r.end_point')} AS end_loc`;

async function latestRoute(c: Client, workerId: string, date: string) {
  const r = await c.query(
    `SELECT ${ROUTE_COLUMNS} FROM delivery_routes r WHERE r.worker_id = $1 AND r.scheduled_date = $2 AND r.status <> 'superseded'
     ORDER BY r.created_at DESC LIMIT 1`,
    [workerId, date],
  );
  return r.rows[0] ?? null;
}

async function toRouteInputs(c: Client, workerId: string, ids: string[]): Promise<{ inputs: RouteStopInput[]; rows: any[] }> {
  const r = await c.query(
    `SELECT s.id, s.status, s.scheduled_date, s.time_start, s.time_end, s.service_minutes, s.priority, ${pointSql('s.location')} AS loc
     FROM delivery_stops s WHERE s.worker_id = $1 AND s.id = ANY($2) AND s.deleted_at IS NULL`,
    [workerId, ids],
  );
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw badRequest('unknown_stop', '存在しない配送先が含まれています', { stopIds: missing });
  const noLoc = r.rows.filter((x) => !x.loc).map((x) => x.id);
  if (noLoc.length) throw badRequest('stop_without_location', '住所の位置が確定していない配送先があります。住所を確認してください', { stopIds: noLoc });
  const rows = ids.map((id) => byId.get(id)!);
  return {
    rows,
    inputs: rows.map((x) => ({
      id: x.id, location: x.loc, windowStart: x.time_start ?? undefined, windowEnd: x.time_end ?? undefined,
      serviceMinutes: x.service_minutes, priority: x.priority as 0 | 1 | 2,
    })),
  };
}

function routeWarnings(source: string, extra: string[] = []): string[] {
  return [
    ...(source === 'estimated' ? ['到着見込みは直線距離からの概算です。実際の道路状況により前後します'] : []),
    '推奨順は目安であり、最短・最適を保証するものではありません',
    ...extra,
  ];
}

async function saveRoute(c: pg.PoolClient, workerId: string, date: string, plan: ReturnType<typeof optimize>, meta: {
  status: string; source: string; departureAt: Date; start: Point; end?: Point; request: unknown; manual: boolean; warnings: string[];
}) {
  await c.query(`UPDATE delivery_routes SET status = 'superseded' WHERE worker_id = $1 AND scheduled_date = $2 AND status IN ('planned','in_progress')`, [workerId, date]);
  const r = await c.query(
    `INSERT INTO delivery_routes(worker_id, scheduled_date, status, ordered_stop_ids, legs, breaks, violations, warnings, estimated_minutes,
       total_distance_km, feasible, travel_time_source, departure_at, start_point, end_point, request, manually_ordered)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::geography,$15::geography,$16,$17) RETURNING id`,
    [
      workerId, date, meta.status, plan.orderedStopIds, JSON.stringify(plan.legs), JSON.stringify(plan.breaks), JSON.stringify(plan.violations),
      meta.warnings, plan.estimatedMinutes, plan.totalDistanceKm, plan.feasible, meta.source, meta.departureAt, toWkt(meta.start),
      meta.end ? toWkt(meta.end) : null, meta.request, meta.manual,
    ],
  );
  for (const [i, leg] of plan.legs.entries()) {
    await c.query('UPDATE delivery_stops SET sequence = $2, estimated_arrival_at = $3, updated_at = now() WHERE id = $1', [leg.stopId, i + 1, leg.arrivalAt]);
  }
  const saved = await c.query(`SELECT ${ROUTE_COLUMNS} FROM delivery_routes r WHERE r.id = $1`, [r.rows[0].id]);
  return saved.rows[0];
}

export async function getRouteView(c: Client, workerId: string, date: string) {
  const r = await latestRoute(c, workerId, date);
  return r ? routeView(r) : null;
}

export const deliveryHandlers: HandlerMap = {
  async listStops(ctx, req) {
    const u = requireUser(req);
    const date = query<{ date: string }>(req).date;
    const r = await ctx.db.query(
      `SELECT ${STOP_COLUMNS} FROM delivery_stops s WHERE s.worker_id = $1 AND s.scheduled_date = $2 AND s.deleted_at IS NULL
       ORDER BY s.sequence NULLS LAST, s.created_at`,
      [u.id, date],
    );
    return r.rows.map((s) => stopView(ctx, s));
  },

  async addStop(ctx, req, reply) {
    const u = requireUser(req);
    requireWorker(u);
    const b = body<NewStopInput>(req);
    validateWindow(b);
    const res = await withIdempotency(ctx, req, 'addStop', async (c) => {
      const dup = await findDuplicate(c, ctx, u.id, b.scheduledDate, b.address);
      if (dup && !b.allowDuplicate) throw conflict('duplicate_stop', '同じ日に同じ住所の配送先が登録されています', { existingStopId: dup });
      const id = await insertStop(c, ctx, u.id, b, dup);
      return { status: 201, body: stopView(ctx, await loadStop(c, u.id, id)) };
    });
    reply.code(res.status);
    return res.body;
  },

  async importStops(ctx, req) {
    const u = requireUser(req);
    requireWorker(u);
    const b = body<{ scheduledDate: string; csv: string; dryRun?: boolean; skipDuplicates?: boolean }>(req);
    const res = await withIdempotency(ctx, req, 'importStops', async (c) => {
      let rows: Record<string, string>[];
      try {
        rows = parseCsv(b.csv.replace(/^\uFEFF/, ''));
      } catch (e) {
        throw badRequest('csv_invalid', `CSVを読み取れません: ${(e as Error).message}`);
      }
      if (!rows.length) throw badRequest('csv_empty', 'データ行がありません');
      if (rows.length > MAX_IMPORT_ROWS) throw badRequest('csv_too_large', `一度に取り込めるのは${MAX_IMPORT_ROWS}件までです`);
      if (!('address' in rows[0]!)) throw badRequest('csv_missing_address', 'address 列が必要です');

      const errors: { row: number; message: string }[] = [];
      const duplicates: { row: number; address: string; existingStopId?: string; duplicateOfRow?: number }[] = [];
      const valid: { row: number; stop: NewStopInput; dupOf: string | null }[] = [];
      const seen = new Map<string, number>();
      for (const [i, raw] of rows.entries()) {
        const rowNo = i + 2; // header is row 1
        const address = (raw.address ?? '').trim();
        if (address.length < 4) { errors.push({ row: rowNo, message: '住所が短すぎます' }); continue; }
        const lat = raw.latitude ? Number(raw.latitude) : undefined;
        const lng = raw.longitude ? Number(raw.longitude) : undefined;
        if ((lat === undefined) !== (lng === undefined) || (lat !== undefined && (!(Math.abs(lat) <= 90) || !(Math.abs(lng!) <= 180)))) {
          errors.push({ row: rowNo, message: '緯度・経度が正しくありません' }); continue;
        }
        const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
        if ((raw.time_start && !hhmm.test(raw.time_start)) || (raw.time_end && !hhmm.test(raw.time_end))) {
          errors.push({ row: rowNo, message: '時間はHH:MM形式で入力してください' }); continue;
        }
        const ts = raw.time_start ? jstDateTime(b.scheduledDate, raw.time_start.padStart(5, '0')).toISOString() : undefined;
        const te = raw.time_end ? jstDateTime(b.scheduledDate, raw.time_end.padStart(5, '0')).toISOString() : undefined;
        if (ts && te && te <= ts) { errors.push({ row: rowNo, message: '終了時刻は開始より後にしてください' }); continue; }
        const priority = raw.priority ? Number(raw.priority) : 0;
        if (![0, 1, 2].includes(priority)) { errors.push({ row: rowNo, message: '優先度は0〜2です' }); continue; }
        const service = raw.service_minutes ? Number(raw.service_minutes) : 3;
        if (!Number.isInteger(service) || service < 0 || service > 120) { errors.push({ row: rowNo, message: '作業時間は0〜120分です' }); continue; }
        const phone = raw.recipient_phone?.trim();
        if (phone && !/^[0-9+-]{10,15}$/.test(phone)) { errors.push({ row: rowNo, message: '電話番号の形式が正しくありません' }); continue; }
        const norm = normalizeAddress(address);
        const stop: NewStopInput = {
          address, scheduledDate: b.scheduledDate, location: lat !== undefined ? { latitude: lat, longitude: lng! } : undefined,
          timeWindowStart: ts, timeWindowEnd: te, priority, serviceMinutes: service, recipientName: raw.recipient_name || undefined,
          recipientPhone: phone || undefined, packageNumber: raw.package_number || undefined, note: raw.note || undefined, source: 'csv',
        };
        const inFile = seen.get(norm);
        const existing = await findDuplicate(c, ctx, u.id, b.scheduledDate, address);
        if (inFile !== undefined || existing) {
          duplicates.push({ row: rowNo, address, existingStopId: existing ?? undefined, duplicateOfRow: inFile });
          if (b.skipDuplicates !== false) continue;
        }
        seen.set(norm, rowNo);
        valid.push({ row: rowNo, stop, dupOf: existing });
      }
      const created = [];
      if (!b.dryRun) {
        for (const v of valid) created.push(stopView(ctx, await loadStop(c, u.id, await insertStop(c, ctx, u.id, v.stop, v.dupOf))));
        await recordEvent(c, { entityType: 'user', entityId: u.id, eventType: 'stops_imported', actor: { id: u.id, role: 'worker' }, payload: { count: created.length, date: b.scheduledDate } });
      }
      return { status: 200, body: { dryRun: !!b.dryRun, created, valid: valid.length, duplicates, errors } };
    });
    return res.body;
  },

  async getStop(ctx, req) {
    const u = requireUser(req);
    return stopView(ctx, await loadStop(ctx.db, u.id, params(req).stopId!));
  },

  async updateStop(ctx, req) {
    const u = requireUser(req);
    const b = body<Record<string, any>>(req);
    return withTx(ctx.db, async (c) => {
      const s = await loadStop(c, u.id, params(req).stopId!, true);
      if (s.version !== b.version) throw conflict('version_conflict', '他の端末で更新されています。最新の内容を確認してください', { version: s.version });
      if (!['draft', 'ready', 'deferred'].includes(s.status)) throw conflict('invalid_state', '配達中・完了済みの配送先は編集できません');
      validateWindow({
        timeWindowStart: b.timeWindowStart !== undefined ? b.timeWindowStart : s.time_start?.toISOString(),
        timeWindowEnd: b.timeWindowEnd !== undefined ? b.timeWindowEnd : s.time_end?.toISOString(),
      });
      const sets: string[] = [];
      const vals: unknown[] = [s.id];
      const set = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
      if (b.address !== undefined) {
        set('address_ciphertext', ctx.cipher.encrypt(b.address.trim()));
        set('address_norm_hash', ctx.cipher.blindIndex(normalizeAddress(b.address)));
        if (b.location === undefined) set('location', null);
      }
      if (b.location !== undefined) set('location', toWkt(b.location), '::geography');
      if (b.timeWindowStart !== undefined) set('time_start', b.timeWindowStart);
      if (b.timeWindowEnd !== undefined) set('time_end', b.timeWindowEnd);
      if (b.note !== undefined) set('note_ciphertext', ctx.cipher.encryptNullable(b.note));
      if (b.recipientName !== undefined) set('recipient_name_ciphertext', ctx.cipher.encryptNullable(b.recipientName));
      if (b.recipientPhone !== undefined) set('recipient_phone_ciphertext', ctx.cipher.encryptNullable(b.recipientPhone));
      if (b.packageNumber !== undefined) set('package_number', b.packageNumber);
      if (b.priority !== undefined) set('priority', b.priority);
      if (b.serviceMinutes !== undefined) set('service_minutes', b.serviceMinutes);
      sets.push('version = version + 1', 'updated_at = now()');
      await c.query(`UPDATE delivery_stops SET ${sets.join(', ')} WHERE id = $1`, vals);
      await c.query(
        `UPDATE delivery_stops SET status = CASE WHEN location IS NULL THEN 'draft' WHEN status = 'draft' THEN 'ready' ELSE status END WHERE id = $1`,
        [s.id],
      );
      return stopView(ctx, await loadStop(c, u.id, s.id));
    });
  },

  async deleteStop(ctx, req, reply) {
    const u = requireUser(req);
    await withTx(ctx.db, async (c) => {
      const s = await loadStop(c, u.id, params(req).stopId!, true);
      if (!['draft', 'ready', 'deferred'].includes(s.status)) throw conflict('invalid_state', '配達中・完了済みの配送先は削除できません');
      await c.query('UPDATE delivery_stops SET deleted_at = now() WHERE id = $1', [s.id]);
    });
    reply.code(204);
  },

  async getStopContact(ctx, req) {
    const u = requireUser(req);
    return withTx(ctx.db, async (c) => {
      const s = await loadStop(c, u.id, params(req).stopId!);
      if (!s.recipient_phone_ciphertext) {
        if (s.contact_purge_after && new Date(s.contact_purge_after) < new Date()) throw gone('保管期間を過ぎたため連絡先は削除されました');
        throw notFound('連絡先が登録されていません');
      }
      await recordEvent(c, { entityType: 'delivery_stop', entityId: s.id, eventType: 'recipient_contact_accessed', actor: { id: u.id, role: 'worker' } });
      return { recipientPhone: ctx.cipher.decrypt(s.recipient_phone_ciphertext), recipientName: ctx.cipher.decryptNullable(s.recipient_name_ciphertext) };
    });
  },

  async optimizeRoute(ctx, req) {
    const u = requireUser(req);
    requireWorker(u);
    const b = body<{ date: string; stopIds: string[]; startLocation?: Point; endLocation?: Point; departureAt?: string; breaks?: { earliestStart: string; latestStart: string; durationMinutes: number }[]; averageSpeedKmh?: number }>(req);
    const res = await withIdempotency(ctx, req, 'optimizeRoute', async (c) => {
      const current = await latestRoute(c, u.id, b.date);
      const { inputs, rows } = await toRouteInputs(c, u.id, [...new Set(b.stopIds)]);
      const wrongDate = rows.filter((r) => r.scheduled_date !== b.date).map((r) => r.id);
      if (wrongDate.length) throw badRequest('stop_date_mismatch', '別の日付の配送先が含まれています', { stopIds: wrongDate });
      if (rows.some((r) => r.status === 'en_route')) {
        throw conflict('vehicle_moving', '移動中は再計算できません。停車して到着を記録してから再計算してください');
      }
      const extra: string[] = [];
      const done = rows.filter((r) => FINAL.includes(r.status)).map((r) => r.id);
      if (done.length) extra.push(`完了済みの${done.length}件は順番の計算から除外しました`);
      const remaining = inputs.filter((s) => !done.includes(s.id));
      if (remaining.length < 1) throw badRequest('nothing_to_route', '計算対象の配送先がありません');
      let start = b.startLocation;
      if (!start) {
        start = remaining[0]!.location;
        extra.push('出発地が未指定のため、最初の配送先を出発地として計算しました');
      }
      for (const br of b.breaks ?? []) {
        if (Date.parse(br.latestStart) < Date.parse(br.earliestStart)) throw badRequest('invalid_break', '休憩の開始可能時刻の範囲が正しくありません');
      }
      const departureAt = b.departureAt ? new Date(b.departureAt) : b.date === jstDate(new Date()) ? new Date() : jstDateTime(b.date, '09:00');
      const travel = new EstimatedTravelTime(b.averageSpeedKmh ?? 22);
      const t0 = Date.now();
      const plan = optimize({
        start, end: b.endLocation, departureAt, travel, stops: remaining,
        breaks: (b.breaks ?? []).map((x) => ({ earliestStart: new Date(x.earliestStart), latestStart: new Date(x.latestStart), durationMinutes: x.durationMinutes })),
      });
      ctx.log.info({ stops: remaining.length, ms: Date.now() - t0, feasible: plan.feasible }, 'route optimized');
      if (!plan.feasible) await bumpMetric(c, 'route_infeasible');
      const saved = await saveRoute(c, u.id, b.date, plan, {
        status: current?.status === 'in_progress' ? 'in_progress' : 'planned', source: travel.source, departureAt, start, end: b.endLocation,
        request: { ...b, startLocation: start }, manual: false,
        warnings: routeWarnings(travel.source, [...extra, ...(plan.feasible ? [] : ['すべての条件を満たす順番が見つかりませんでした。違反内容を確認し、順番や時間指定を手動で調整してください'])]),
      });
      await recordEvent(c, { entityType: 'delivery_route', entityId: saved.id, eventType: 'route_optimized', actor: { id: u.id, role: 'worker' }, payload: { stops: remaining.length, feasible: plan.feasible } });
      return { status: 200, body: routeView(saved) };
    });
    return res.body;
  },

  async getRoute(ctx, req) {
    const u = requireUser(req);
    const r = await latestRoute(ctx.db, u.id, query<{ date: string }>(req).date);
    if (!r) throw notFound('この日のルートはまだ作成されていません');
    return routeView(r);
  },

  async reorderRoute(ctx, req) {
    const u = requireUser(req);
    const ids = body<{ orderedStopIds: string[] }>(req).orderedStopIds;
    const res = await withIdempotency(ctx, req, 'reorderRoute', async (c) => {
      const r = (await c.query(`SELECT ${ROUTE_COLUMNS} FROM delivery_routes r WHERE r.id = $1 AND r.worker_id = $2 FOR UPDATE`, [params(req).routeId, u.id])).rows[0];
      if (!r || r.status === 'superseded') throw notFound('ルートが見つかりません（新しいルートが作成されている可能性があります）');
      const same = ids.length === r.ordered_stop_ids.length && new Set(ids).size === ids.length && ids.every((id: string) => r.ordered_stop_ids.includes(id));
      if (!same) throw badRequest('order_mismatch', '並べ替えにはルート内のすべての配送先を1回ずつ指定してください');
      const { inputs, rows } = await toRouteInputs(c, u.id, ids);
      if (rows.some((x) => x.status === 'en_route')) throw conflict('vehicle_moving', '移動中は並べ替えできません。停車してから操作してください');
      const departureAt = r.status === 'in_progress' ? new Date() : new Date(r.departure_at);
      const pending = inputs.filter((s) => !FINAL.includes(rows.find((x) => x.id === s.id)!.status));
      const breaks = ((r.request?.breaks ?? []) as any[]).map((x) => ({ earliestStart: new Date(x.earliestStart), latestStart: new Date(x.latestStart), durationMinutes: x.durationMinutes }));
      const travel = new EstimatedTravelTime(r.request?.averageSpeedKmh ?? 22);
      const { cost: _c, ...plan } = simulate(pending, { start: r.start_loc, end: r.end_loc ?? undefined, departureAt, breaks, travel });
      plan.orderedStopIds = ids;
      const saved = await saveRoute(c, u.id, r.scheduled_date, plan, {
        status: r.status, source: travel.source, departureAt, start: r.start_loc, end: r.end_loc ?? undefined, request: r.request, manual: true,
        warnings: routeWarnings(travel.source, plan.feasible ? [] : ['手動の順番では条件を満たせない配送先があります']),
      });
      await recordEvent(c, { entityType: 'delivery_route', entityId: saved.id, eventType: 'route_reordered', actor: { id: u.id, role: 'worker' } });
      return { status: 200, body: routeView(saved) };
    });
    return res.body;
  },

  async startRoute(ctx, req) {
    const u = requireUser(req);
    const res = await withIdempotency(ctx, req, 'startRoute', async (c) => {
      const r = (await c.query(`SELECT ${ROUTE_COLUMNS} FROM delivery_routes r WHERE r.id = $1 AND r.worker_id = $2 FOR UPDATE`, [params(req).routeId, u.id])).rows[0];
      if (!r || r.status === 'superseded') throw notFound('ルートが見つかりません');
      if (r.status === 'completed') throw conflict('invalid_state', 'このルートは完了しています');
      if (r.status === 'planned') {
        await c.query(`UPDATE delivery_routes SET status = 'in_progress' WHERE id = $1`, [r.id]);
        const first = await c.query(
          `SELECT id FROM delivery_stops WHERE id = ANY($1) AND status = 'ready' AND deleted_at IS NULL ORDER BY array_position($1, id) LIMIT 1`,
          [r.ordered_stop_ids],
        );
        if (first.rows[0]) await c.query(`UPDATE delivery_stops SET status = 'en_route', version = version + 1, updated_at = now() WHERE id = $1`, [first.rows[0].id]);
        await recordEvent(c, { entityType: 'delivery_route', entityId: r.id, eventType: 'route_started', actor: { id: u.id, role: 'worker' } });
      }
      return { status: 200, body: routeView((await c.query(`SELECT ${ROUTE_COLUMNS} FROM delivery_routes r WHERE r.id = $1`, [r.id])).rows[0]) };
    });
    return res.body;
  },

  async recordStopEvent(ctx, req) {
    const u = requireUser(req);
    const b = body<{ eventType: string; failureReason?: string; failureNote?: string; deferredUntil?: string; handoff?: string; evidenceIds?: string[]; location?: Point; occurredAt?: string }>(req);
    const res = await withIdempotency(ctx, req, 'recordStopEvent', async (c) => {
      const s = await loadStop(c, u.id, params(req).stopId!, true);
      if (s.status === b.eventType) return { status: 200, body: stopView(ctx, s) };
      if (!TRANSITIONS[b.eventType]!.includes(s.status)) {
        throw conflict('invalid_transition', `現在の状態（${s.status}）からは「${b.eventType}」にできません`, { status: s.status });
      }
      if ((b.eventType === 'failed' || b.eventType === 'deferred') && !b.failureReason) throw badRequest('reason_required', '未配達の理由を選択してください');
      if (b.eventType === 'deferred' && (!b.deferredUntil || Date.parse(b.deferredUntil) <= Date.now())) throw badRequest('deferred_until_required', '再配達の日時を指定してください');
      const evidenceIds = [...new Set(b.evidenceIds ?? [])];
      if (evidenceIds.length) {
        const ev = await c.query(`SELECT count(*)::int AS n FROM evidence WHERE id = ANY($1) AND delivery_stop_id = $2 AND status = 'verified'`, [evidenceIds, s.id]);
        if (ev.rows[0].n !== evidenceIds.length) throw badRequest('evidence_invalid', '写真のアップロードが完了していません');
      }
      if (b.eventType === 'delivered' && ['safe_place', 'delivery_box'].includes(b.handoff ?? '')) {
        const have = s.evidence_ids.length + evidenceIds.filter((x) => !s.evidence_ids.includes(x)).length;
        if (have < 1) throw badRequest('photo_required', '置き配・宅配ボックスの場合は写真の記録が必要です');
      }
      const occurred = b.occurredAt && Date.parse(b.occurredAt) <= Date.now() + 60_000 ? new Date(b.occurredAt) : new Date();
      const isFinal = FINAL.includes(b.eventType);
      await c.query(
        `UPDATE delivery_stops SET status = $2, failure_reason = $3, failure_note = $4, deferred_until = $5, handoff = coalesce($6, handoff),
           completed_at = CASE WHEN $7 THEN $8::timestamptz ELSE completed_at END,
           contact_purge_after = CASE WHEN $7 THEN $8::timestamptz + make_interval(days => $9) ELSE contact_purge_after END,
           version = version + 1, updated_at = now()
         WHERE id = $1`,
        [s.id, b.eventType, b.failureReason ?? null, b.failureNote ?? null, b.deferredUntil ?? null, b.handoff ?? null, isFinal, occurred, ctx.cfg.recipientContactRetentionDays],
      );
      // Advance the in-progress route to the next pending stop and complete it when nothing is left.
      if (isFinal || b.eventType === 'deferred') {
        const route = await c.query(`SELECT id, ordered_stop_ids FROM delivery_routes WHERE worker_id = $1 AND scheduled_date = $2 AND status = 'in_progress' AND $3 = ANY(ordered_stop_ids) LIMIT 1`, [u.id, s.scheduled_date, s.id]);
        const rt = route.rows[0];
        if (rt) {
          const next = await c.query(
            `SELECT id, status FROM delivery_stops WHERE id = ANY($1) AND deleted_at IS NULL AND status IN ('ready','en_route','arrived') ORDER BY array_position($1, id) LIMIT 1`,
            [rt.ordered_stop_ids],
          );
          if (!next.rows[0]) await c.query(`UPDATE delivery_routes SET status = 'completed' WHERE id = $1`, [rt.id]);
          else if (next.rows[0].status === 'ready') await c.query(`UPDATE delivery_stops SET status = 'en_route', version = version + 1 WHERE id = $1`, [next.rows[0].id]);
        }
      }
      if (b.eventType === 'failed') await bumpMetric(c, 'delivery_failed');
      if (b.eventType === 'delivered') await bumpMetric(c, 'delivery_completed');
      await recordEvent(c, {
        entityType: 'delivery_stop', entityId: s.id, eventType: `stop_${b.eventType}`, actor: { id: u.id, role: 'worker' },
        reason: b.failureReason ?? null, payload: { occurredAt: occurred.toISOString(), handoff: b.handoff, evidence: evidenceIds.length },
      });
      return { status: 200, body: stopView(ctx, await loadStop(c, u.id, s.id)) };
    });
    return res.body;
  },

  async getDeliveryReport(ctx, req) {
    const u = requireUser(req);
    const q = query<{ from: string; to: string }>(req);
    if (q.to < q.from) throw badRequest('validation', '期間の指定が正しくありません');
    if (Date.parse(q.to) - Date.parse(q.from) > 366 * 86_400_000) throw badRequest('validation', '期間は1年以内で指定してください');
    const r = await ctx.db.query(
      `SELECT scheduled_date::text AS date, count(*)::int AS total,
         count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
         count(*) FILTER (WHERE status = 'failed')::int AS failed,
         count(*) FILTER (WHERE status = 'deferred')::int AS deferred,
         count(*) FILTER (WHERE status IN ('draft','ready','en_route','arrived'))::int AS pending
       FROM delivery_stops WHERE worker_id = $1 AND scheduled_date BETWEEN $2 AND $3 AND deleted_at IS NULL
       GROUP BY scheduled_date ORDER BY scheduled_date`,
      [u.id, q.from, q.to],
    );
    const dist = await ctx.db.query(
      `SELECT DISTINCT ON (scheduled_date) scheduled_date::text AS date, total_distance_km FROM delivery_routes
       WHERE worker_id = $1 AND scheduled_date BETWEEN $2 AND $3 AND status <> 'superseded' ORDER BY scheduled_date, created_at DESC`,
      [u.id, q.from, q.to],
    );
    const km = new Map(dist.rows.map((d) => [d.date, Number(d.total_distance_km)]));
    return r.rows.map((x) => ({ ...x, estimatedDistanceKm: km.get(x.date) }));
  },
};

