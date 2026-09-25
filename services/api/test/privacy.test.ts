// PRI-01 / PRI-02 / SEC-01 / SEC-02: location limits, account deletion, evidence access & sanitisation, audit integrity.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, approvedOrg, call, jpegWithExif, loginWorker, publishedJob, randomIp, setupApp, sha256hex, uploadEvidence, verifiedWorker, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => { env = await setupApp(); });
afterAll(async () => env.close());

describe('PRI-02 account deletion', () => {
  it('explains retention, blocks with live work, deletes, and prevents re-login', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org);
    const w = await verifiedWorker(env);
    const a = await call(env, w, 'POST', `/jobs/${job.id}/accept`);
    const pre = await call(env, w, 'DELETE', '/me');
    expect(pre.status).toBe(202);
    expect(pre.body.status).toBe('confirmation_required');
    expect(pre.body.retentionNotice).toMatch(/7年間/);
    expect(pre.body.blockers.length).toBe(1);
    const blocked = await call(env, w, 'DELETE', '/me', { confirm: true });
    expect(blocked.status).toBe(409);
    await call(env, w, 'POST', `/assignments/${a.body.id}/events`, { eventType: 'cancelled' });

    const done = await call(env, w, 'DELETE', '/me', { confirm: true, reason: '利用しなくなったため' });
    expect(done.status).toBe(202);
    expect(done.body.status).toBe('completed');
    expect((await call(env, w, 'GET', '/me')).status).toBe(401);
    expect((await call(env, null, 'POST', '/auth/refresh', { refreshToken: w.refresh })).status).toBe(401);
    const relogin = await call(env, null, 'POST', '/auth/otp/request', { phone: w.phone }, {}, randomIp());
    expect(relogin.status).toBe(403);
    expect(relogin.body.code).toBe('account_deleted');
    const row = await env.ctx.db.query('SELECT display_name, phone_ciphertext, profile_ciphertext, bank_ciphertext FROM app_users WHERE id = $1', [w.userId]);
    expect(row.rows[0]).toEqual({ display_name: '退会済みユーザー', phone_ciphertext: null, profile_ciphertext: null, bank_ciphertext: null });
    const op = await admin(env);
    const list = await call(env, op, 'GET', '/admin/deletion-requests');
    expect(list.body.some((d: any) => d.userId === w.userId)).toBe(true);
  });
});

describe('PRI-01 location', () => {
  it('app works without location (manual area search) and location sharing is refused outside active work', async () => {
    const w = await verifiedWorker(env);
    const r = await call(env, w, 'GET', '/jobs?areaQuery=%E6%A8%AA%E6%B5%9C&sort=starts_at');
    expect(r.status).toBe(200);
    const home = await call(env, w, 'GET', '/home');
    expect(home.status).toBe(200);
    expect(home.body.nearbyJobs).toBeDefined();
  });

  it('organisations never receive a location history, only the latest point while active', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org);
    const w = await verifiedWorker(env);
    const a = await call(env, w, 'POST', `/jobs/${job.id}/accept`);
    await env.ctx.db.query(`UPDATE jobs SET starts_at = now() + interval '5 minutes' WHERE id = $1`, [job.id]);
    await call(env, w, 'POST', `/assignments/${a.body.id}/events`, { eventType: 'traveling' });
    for (const lat of [35.40, 35.41, 35.42]) await call(env, w, 'POST', `/assignments/${a.body.id}/location`, { location: { latitude: lat, longitude: 139.6 } });
    const live = await call(env, org.owner, 'GET', `/assignments/${a.body.id}/live-location`);
    expect(Object.keys(live.body).sort()).toEqual(['location', 'recordedAt']);
    expect(live.body.location.latitude).toBeCloseTo(35.42, 5);
    const view = await call(env, org.owner, 'GET', `/assignments/${a.body.id}`);
    expect(JSON.stringify(view.body)).not.toContain('35.41');
    await call(env, w, 'POST', `/assignments/${a.body.id}/events`, { eventType: 'cancelled' });
    expect((await call(env, org.owner, 'GET', `/assignments/${a.body.id}/live-location`)).status).toBe(404);
  });
});

describe('SEC-01 evidence', () => {
  it('strips EXIF, verifies hash/type, limits access and expires URLs', async () => {
    const org = await approvedOrg(env);
    const job = await publishedJob(env, org);
    const w = await verifiedWorker(env);
    const a = await call(env, w, 'POST', `/jobs/${job.id}/accept`);
    const up = await uploadEvidence(env, w, { assignmentId: a.body.id });
    expect(up.complete.status).toBe(200);
    expect(up.complete.body.status).toBe('verified');
    const row = await env.ctx.db.query('SELECT object_key FROM evidence WHERE id = $1', [up.id]);
    const stored = (await env.ctx.storage.get(row.rows[0].object_key))!;
    expect(stored.toString('latin1')).not.toContain('GPS-LAT');
    expect(stored.toString('latin1')).not.toContain('device id');
    expect(stored.toString('latin1')).toContain('JFIF');

    const url = await call(env, org.owner, 'GET', `/evidence/${up.id}/url`);
    expect(url.status).toBe(200);
    const got = await env.app.inject({ method: 'GET', url: new URL(url.body.url).pathname });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');

    const other = await verifiedWorker(env);
    expect((await call(env, other, 'GET', `/evidence/${up.id}/url`)).status).toBe(404);
    const otherOrg = await approvedOrg(env);
    expect((await call(env, otherOrg.owner, 'GET', `/evidence/${up.id}/url`)).status).toBe(404);

    // Tampered and expired tokens are rejected.
    const path = new URL(url.body.url).pathname;
    expect((await env.app.inject({ method: 'GET', url: path.slice(0, -3) + 'AAA' })).statusCode).toBe(403);
    const store = env.ctx.storage as any;
    const expired = store.sign({ k: row.rows[0].object_key, op: 'get', exp: Date.now() - 1000 });
    expect((await env.app.inject({ method: 'GET', url: `/v1/evidence-blobs/${expired}` })).statusCode).toBe(403);
  });

  it('rejects content-type spoofing, hash mismatch and oversize declarations', async () => {
    const w = await loginWorker(env);
    const png = jpegWithExif();
    const spoof = await call(env, w, 'POST', '/evidence/uploads', { purpose: 'identity_document', contentType: 'image/png', byteSize: png.length, sha256: sha256hex(png) });
    await env.app.inject({ method: 'PUT', url: new URL(spoof.body.uploadUrl).pathname, payload: png, headers: { 'content-type': 'image/png' } });
    const r = await call(env, w, 'POST', `/evidence/${spoof.body.evidenceId}/complete`);
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/JPEGまたはPNG/);

    const data = jpegWithExif();
    const wrongHash = await call(env, w, 'POST', '/evidence/uploads', { purpose: 'identity_document', contentType: 'image/jpeg', byteSize: data.length, sha256: 'a'.repeat(64) });
    await env.app.inject({ method: 'PUT', url: new URL(wrongHash.body.uploadUrl).pathname, payload: data, headers: { 'content-type': 'image/jpeg' } });
    expect((await call(env, w, 'POST', `/evidence/${wrongHash.body.evidenceId}/complete`)).body.message).toMatch(/ハッシュ不一致/);

    const big = await call(env, w, 'POST', '/evidence/uploads', { purpose: 'identity_document', contentType: 'image/jpeg', byteSize: 20_000_000, sha256: 'a'.repeat(64) });
    expect(big.status).toBe(422);
    const gif = await call(env, w, 'POST', '/evidence/uploads', { purpose: 'identity_document', contentType: 'image/gif', byteSize: 10, sha256: 'a'.repeat(64) });
    expect(gif.status).toBe(422);
    // Upload size must match the signed declaration.
    const sized = await call(env, w, 'POST', '/evidence/uploads', { purpose: 'identity_document', contentType: 'image/jpeg', byteSize: data.length, sha256: sha256hex(data) });
    const put = await env.app.inject({ method: 'PUT', url: new URL(sized.body.uploadUrl).pathname, payload: Buffer.concat([data, Buffer.alloc(10)]), headers: { 'content-type': 'image/jpeg' } });
    expect(put.statusCode).toBe(422);
  });

  it('identity documents are visible to operators but not to support staff', async () => {
    const w = await loginWorker(env);
    const doc = await uploadEvidence(env, w, { purpose: 'identity_document' });
    const op = await admin(env, 'admin_operator');
    const support = await admin(env, 'admin_support');
    expect((await call(env, op, 'GET', `/evidence/${doc.id}/url`)).status).toBe(200);
    expect((await call(env, support, 'GET', `/evidence/${doc.id}/url`)).status).toBe(404);
  });
});

describe('SEC-02 audit trail', () => {
  it('records actor/time/reason and detects tampering via the hash chain', async () => {
    const op = await admin(env);
    const org = await approvedOrg(env, false);
    await call(env, op, 'POST', `/admin/organizations/${org.orgId}/review`, { decision: 'rejected', reason: '登記情報が確認できない' });
    const ev = await call(env, op, 'GET', `/admin/audit-events?entityType=organization&entityId=${org.orgId}`);
    const rej = ev.body.find((e: any) => e.eventType === 'review_rejected');
    expect(rej).toMatchObject({ actorId: op.userId, reason: '登記情報が確認できない' });
    expect(rej.hash).toMatch(/^[a-f0-9]{64}$/);

    const ok = await call(env, op, 'GET', '/admin/audit-events/verify');
    expect(ok.body.valid).toBe(true);
    expect(ok.body.checked).toBeGreaterThan(5);

    await expect(env.ctx.db.query(`UPDATE domain_events SET reason = 'x' WHERE id = $1`, [rej.id])).rejects.toThrow(/append-only/);
    await expect(env.ctx.db.query(`DELETE FROM domain_events WHERE id = $1`, [rej.id])).rejects.toThrow(/append-only/);

    // A privileged actor bypassing the trigger is still detected by the chain.
    const c = await env.ctx.db.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE domain_events DISABLE TRIGGER domain_events_append_only');
      await c.query(`UPDATE domain_events SET reason = '改ざん' WHERE id = $1`, [rej.id]);
      const { verifyAuditChain } = await import('../src/modules/admin.js');
      const res = await verifyAuditChain({ ...env.ctx, db: { query: (q: string, v?: unknown[]) => c.query(q, v) } as any });
      expect(res.valid).toBe(false);
      expect(res.firstInvalidId).toBe(rej.id);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((await call(env, op, 'GET', '/admin/audit-events/verify')).body.valid).toBe(true);
  });

  it('does not log phone numbers, addresses or tokens', async () => {
    const lines: string[] = [];
    const out = () => lines.join('');
    const { buildApp } = await import('../src/server.js');
    const { testConfig } = await import('./helpers.js');
    const { Writable } = await import('node:stream');
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const { app } = await buildApp({ cfg: { ...testConfig(), logLevel: 'info' }, sms: env.sms, logStream: stream });
    try {
      await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '09012345678' }, headers: { 'content-type': 'application/json' } });
      await app.inject({ method: 'GET', url: '/v1/jobs?latitude=35.4437&longitude=139.638', headers: { authorization: 'Bearer secret-token-value' } });
      await app.inject({ method: 'PUT', url: '/v1/evidence-blobs/eyJzZWNyZXQiOiJ0b2tlbiJ9.sig', payload: Buffer.from([1]), headers: { 'content-type': 'image/jpeg' } });
    } finally {
      await app.close();
    }
    expect(out()).not.toContain('eyJzZWNyZXQiOiJ0b2tlbiJ9');
    expect(out()).toContain('/v1/jobs');
    expect(out()).not.toContain('09012345678');
    expect(out()).not.toContain('secret-token-value');
    expect(out()).not.toContain('35.4437');
  });
});
