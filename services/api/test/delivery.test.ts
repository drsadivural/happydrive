// DEL-01 / DEL-02 / DEL-03: stop registration (manual/CSV), duplicates, optimisation via API, execution and offline-safe sync.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, key, setupApp, uploadEvidence, verifiedWorker, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => { env = await setupApp(); });
afterAll(async () => env.close());

const DATE = '2026-10-05';
const jst = (hhmm: string) => new Date(`${DATE}T${hhmm}:00+09:00`).toISOString();
const pt = (i: number) => ({ latitude: 35.43 + (i % 5) * 0.006, longitude: 139.62 + Math.floor(i / 5) * 0.007 });

describe('DEL-01 stop registration', () => {
  it('adds a stop, warns on duplicates, accepts confirmed duplicates', async () => {
    const w = await verifiedWorker(env);
    const s1 = await call(env, w, 'POST', '/delivery/stops', { address: '横浜市中区山下町１丁目２番３号', scheduledDate: DATE, location: pt(0), recipientPhone: '090-1111-2222' });
    expect(s1.status).toBe(201);
    expect(s1.body.status).toBe('ready');
    expect(s1.body.hasRecipientPhone).toBe(true);
    expect(s1.body.recipientPhone).toBeUndefined();
    const dup = await call(env, w, 'POST', '/delivery/stops', { address: '横浜市中区山下町1-2-3', scheduledDate: DATE });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate_stop');
    expect(dup.body.details.existingStopId).toBe(s1.body.id);
    const ok = await call(env, w, 'POST', '/delivery/stops', { address: '横浜市中区山下町1-2-3', scheduledDate: DATE, allowDuplicate: true });
    expect(ok.status).toBe(201);
    expect(ok.body.duplicateOfStopId).toBe(s1.body.id);
    expect(ok.body.status).toBe('draft');
  });

  it('imports CSV with dry-run validation, duplicate detection and row errors', async () => {
    const w = await verifiedWorker(env);
    const csv = [
      'address,latitude,longitude,time_start,time_end,priority,recipient_phone,note',
      '"横浜市西区みなとみらい2-2-1",35.4545,139.6317,10:00,11:00,1,045-000-1111,"置き配不可, 手渡し"',
      '横浜市西区みなとみらい２－２－１,35.4545,139.6317,,,0,,',
      'x,,,,,,,',
      '横浜市神奈川区栄町4-9,35.4700,139.6300,12:00,11:00,0,,',
      '横浜市中区本町6-50,35.4480,139.6360,,,5,,',
      '横浜市港北区新横浜2-4,,,,,0,,',
    ].join('\n');
    const dry = await call(env, w, 'POST', '/delivery/stops/import', { scheduledDate: DATE, csv, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.created).toHaveLength(0);
    expect(dry.body.valid).toBe(2);
    expect(dry.body.duplicates).toHaveLength(1);
    expect(dry.body.errors.map((e: any) => e.row).sort()).toEqual([4, 5, 6]);
    const real = await call(env, w, 'POST', '/delivery/stops/import', { scheduledDate: DATE, csv });
    expect(real.body.created).toHaveLength(2);
    const first = real.body.created[0];
    expect(first.note).toBe('置き配不可, 手渡し');
    expect(first.timeWindowStart).toBe(jst('10:00'));
    expect(real.body.created[1].status).toBe('draft');
  });

  it('refuses to optimise stops without a confirmed location', async () => {
    const w = await verifiedWorker(env);
    const a = await call(env, w, 'POST', '/delivery/stops', { address: '住所不明のテスト1', scheduledDate: DATE });
    const b = await call(env, w, 'POST', '/delivery/stops', { address: '横浜市中区日本大通1', scheduledDate: DATE, location: pt(1) });
    const r = await call(env, w, 'POST', '/delivery/routes/optimize', { date: DATE, stopIds: [a.body.id, b.body.id], startLocation: pt(0) });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('stop_without_location');
    expect(r.body.details.stopIds).toEqual([a.body.id]);
  });
});

describe('DEL-02 optimisation via API', () => {
  it('optimises 24 stops with windows, priority and a break; supports manual reorder', async () => {
    const w = await verifiedWorker(env);
    const ids: string[] = [];
    for (let i = 0; i < 24; i++) {
      const extra = i === 3 ? { timeWindowStart: jst('13:00'), timeWindowEnd: jst('14:00') } : i === 10 ? { priority: 2 } : {};
      const s = await call(env, w, 'POST', '/delivery/stops', { address: `横浜市中区テスト町${i + 1}-1`, scheduledDate: DATE, location: pt(i), serviceMinutes: 4, ...extra });
      ids.push(s.body.id);
    }
    const r = await call(env, w, 'POST', '/delivery/routes/optimize', {
      date: DATE, stopIds: ids, startLocation: { latitude: 35.44, longitude: 139.63 }, departureAt: jst('09:00'),
      breaks: [{ earliestStart: jst('11:30'), latestStart: jst('12:30'), durationMinutes: 45 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.orderedStopIds).toHaveLength(24);
    expect(r.body.travelTimeSource).toBe('estimated');
    expect(r.body.warnings.join()).toMatch(/概算/);
    expect(r.body.warnings.join()).toMatch(/保証するものではありません/);
    const windowLeg = r.body.legs.find((l: any) => l.stopId === ids[3]);
    expect(new Date(windowLeg.arrivalAt).getTime() + windowLeg.waitMinutes * 60_000).toBeGreaterThanOrEqual(Date.parse(jst('13:00')));
    expect(windowLeg.lateMinutes).toBe(0);
    expect(r.body.breaks).toHaveLength(1);
    const stops = await call(env, w, 'GET', `/delivery/stops?date=${DATE}`);
    expect(stops.body[0].sequence).toBe(1);
    expect(stops.body[0].estimatedArrivalAt).toBeDefined();

    const reversed = [...r.body.orderedStopIds].reverse();
    const re = await call(env, w, 'POST', `/delivery/routes/${r.body.id}/reorder`, { orderedStopIds: reversed });
    expect(re.status).toBe(200);
    expect(re.body.manuallyOrdered).toBe(true);
    expect(re.body.orderedStopIds).toEqual(reversed);
    const bad = await call(env, w, 'POST', `/delivery/routes/${re.body.id}/reorder`, { orderedStopIds: reversed.slice(1) });
    expect(bad.status).toBe(422);
    // The superseded route can no longer be edited.
    expect((await call(env, w, 'POST', `/delivery/routes/${r.body.id}/reorder`, { orderedStopIds: reversed })).status).toBe(404);
  });

  it('returns infeasibility reasons for impossible windows', async () => {
    const w = await verifiedWorker(env);
    const a = await call(env, w, 'POST', '/delivery/stops', { address: '東京都千代田区丸の内1-1', scheduledDate: DATE, location: { latitude: 35.68, longitude: 139.767 }, timeWindowStart: jst('09:00'), timeWindowEnd: jst('09:10') });
    const b = await call(env, w, 'POST', '/delivery/stops', { address: '神奈川県鎌倉市雪ノ下1-1', scheduledDate: DATE, location: { latitude: 35.32, longitude: 139.556 }, timeWindowStart: jst('09:00'), timeWindowEnd: jst('09:15') });
    const r = await call(env, w, 'POST', '/delivery/routes/optimize', { date: DATE, stopIds: [a.body.id, b.body.id], startLocation: pt(0), departureAt: jst('09:00') });
    expect(r.status).toBe(200);
    expect(r.body.feasible).toBe(false);
    expect(r.body.violations.length).toBeGreaterThan(0);
    expect(r.body.warnings.join()).toMatch(/手動で調整/);
  });
});

describe('DEL-03 execution', () => {
  it('runs a route: start, arrive, deliver with photo, fail with reason, offline replay without duplicates', async () => {
    const w = await verifiedWorker(env);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await call(env, w, 'POST', '/delivery/stops', { address: `横浜市西区実行町${i + 1}-1`, scheduledDate: DATE, location: pt(i + 10), recipientPhone: '09033334444' })).body.id);
    }
    const route = await call(env, w, 'POST', '/delivery/routes/optimize', { date: DATE, stopIds: ids, startLocation: pt(0) });
    const started = await call(env, w, 'POST', `/delivery/routes/${route.body.id}/start`);
    expect(started.body.status).toBe('in_progress');
    const [first, second, third] = route.body.orderedStopIds;
    expect((await call(env, w, 'GET', `/delivery/stops/${first}`)).body.status).toBe('en_route');

    // Re-optimising while moving is blocked.
    const moving = await call(env, w, 'POST', '/delivery/routes/optimize', { date: DATE, stopIds: ids, startLocation: pt(0) });
    expect(moving.status).toBe(409);
    expect(moving.body.code).toBe('vehicle_moving');

    const contact = await call(env, w, 'GET', `/delivery/stops/${first}/contact`);
    expect(contact.body.recipientPhone).toBe('09033334444');

    expect((await call(env, w, 'POST', `/delivery/stops/${first}/events`, { eventType: 'arrived' })).body.status).toBe('arrived');
    const noPhoto = await call(env, w, 'POST', `/delivery/stops/${first}/events`, { eventType: 'delivered', handoff: 'safe_place' });
    expect(noPhoto.status).toBe(422);
    expect(noPhoto.body.code).toBe('photo_required');
    const photo = await uploadEvidence(env, w, { deliveryStopId: first, purpose: 'delivery_photo' });
    expect(photo.complete.status).toBe(200);

    // Offline: the same queued mutation is sent twice with the same key.
    const k = key();
    const occurredAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const d1 = await call(env, w, 'POST', `/delivery/stops/${first}/events`, { eventType: 'delivered', handoff: 'safe_place', evidenceIds: [photo.id], occurredAt }, { 'idempotency-key': k });
    const d2 = await call(env, w, 'POST', `/delivery/stops/${first}/events`, { eventType: 'delivered', handoff: 'safe_place', evidenceIds: [photo.id], occurredAt }, { 'idempotency-key': k });
    expect(d1.status).toBe(200);
    expect(d2.body).toEqual(d1.body);
    expect(d1.body.completedAt).toBe(occurredAt);
    const events = await env.ctx.db.query(`SELECT count(*)::int AS n FROM domain_events WHERE entity_id = $1 AND event_type = 'stop_delivered'`, [first]);
    expect(events.rows[0].n).toBe(1);
    const mismatch = await call(env, w, 'POST', `/delivery/stops/${first}/events`, { eventType: 'failed', failureReason: 'absent' }, { 'idempotency-key': k });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe('idempotency_mismatch');

    // The route advanced to the next stop automatically.
    expect((await call(env, w, 'GET', `/delivery/stops/${second}`)).body.status).toBe('en_route');
    const noReason = await call(env, w, 'POST', `/delivery/stops/${second}/events`, { eventType: 'failed' });
    expect(noReason.status).toBe(422);
    const failed = await call(env, w, 'POST', `/delivery/stops/${second}/events`, { eventType: 'failed', failureReason: 'absent', failureNote: '不在票投函' });
    expect(failed.body.status).toBe('failed');
    const deferred = await call(env, w, 'POST', `/delivery/stops/${third}/events`, { eventType: 'deferred', failureReason: 'absent', deferredUntil: new Date(Date.now() + 86_400_000).toISOString() });
    expect(deferred.body.status).toBe('deferred');
    const invalid = await call(env, w, 'POST', `/delivery/stops/${second}/events`, { eventType: 'arrived' });
    expect(invalid.status).toBe(409);

    const report = await call(env, w, 'GET', `/delivery/reports/daily?from=${DATE}&to=${DATE}`);
    expect(report.body[0]).toMatchObject({ date: DATE, total: 3, delivered: 1, failed: 1, deferred: 1 });
  });

  it('purges recipient contact after the retention period', async () => {
    const w = await verifiedWorker(env);
    const s = await call(env, w, 'POST', '/delivery/stops', { address: '横浜市中区保管期限1-1', scheduledDate: DATE, location: pt(3), recipientPhone: '09055556666' });
    await call(env, w, 'POST', `/delivery/stops/${s.body.id}/events`, { eventType: 'delivered', handoff: 'in_person' });
    await env.ctx.db.query(`UPDATE delivery_stops SET contact_purge_after = now() - interval '1 minute' WHERE id = $1`, [s.body.id]);
    const { applyRetention } = await import('../src/jobs/maintenance.js');
    await applyRetention(env.ctx);
    const r = await call(env, w, 'GET', `/delivery/stops/${s.body.id}/contact`);
    expect(r.status).toBe(410);
  });
});
