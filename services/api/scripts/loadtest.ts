// Development-only latency check for the NFR targets (docs/spec/PRODUCT.md §7):
//   read p95 < 500 ms (search/home), accept p95 < 1 s under concurrency.
// Creates its own verified workers and a high-capacity job directly in the dev DB, then drives the running API over HTTP.
// Usage: NODE_ENV=development API=http://localhost:8088/v1 tsx scripts/loadtest.ts [workers=200] [concurrency=50]
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { FieldCipher } from '../src/lib/crypto.js';
import { coarsen, toWkt } from '../src/lib/geo.js';
import { signAccessToken } from '../src/auth/tokens.js';

const cfg = loadConfig();
if (cfg.env !== 'development') throw new Error('development only');
const API = process.env.API ?? 'http://localhost:8080/v1';
const N = Number(process.argv[2] ?? 200);
const C = Number(process.argv[3] ?? 50);
const db = createPool(cfg.databaseUrl, 5);
const cipher = new FieldCipher(cfg.dataEncryptionKey, cfg.dataHmacKey);
const ctx = { cfg } as any;

const org = (await db.query(`SELECT o.id, m.user_id FROM organizations o JOIN organization_members m ON m.org_id = o.id WHERE o.review_status = 'approved' LIMIT 1`)).rows[0];
if (!org) throw new Error('run seed:dev first');
const start = new Date(Date.now() + 5 * 3_600_000);
const job = (await db.query(
  `INSERT INTO jobs(org_id, created_by, title, category, contract_type, status, description, address_ciphertext, location, public_point, area_label, starts_at, ends_at,
     amount_yen, capacity, cancellation_policy, steps, contact_name, payment_terms_text, published_at)
   VALUES ($1,$2,'負荷試験用案件','corporate_task','contractor','published','負荷試験のための案件です（開発環境）',$3,$4::geography,$5::geography,'横浜市中区',$6,$7,1000,$8,
     '{"freeCancelHoursBefore":24,"lateCancelCompensationPercent":0,"text":"試験"}','[{"title":"作業"}]','試験','試験', now()) RETURNING id`,
  [org.id, org.user_id, cipher.encrypt('試験住所'), toWkt({ latitude: 35.4437, longitude: 139.638 }), toWkt(coarsen({ latitude: 35.4437, longitude: 139.638 })),
    start, new Date(start.getTime() + 3_600_000), N],
)).rows[0].id;

const tokens: string[] = [];
for (let i = 0; i < N; i++) {
  const phone = `+8170${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const u = await db.query(
    `INSERT INTO app_users(display_name, phone_ciphertext, phone_hash, roles, verification_status, terms_version, privacy_version, profile_ciphertext, vehicle)
     VALUES ('負荷試験', $1, $2, '{worker}', 'verified', $3, $4, $5, '{"type":"kei_van"}') RETURNING id`,
    [cipher.encrypt(phone), cipher.blindIndex(phone), cfg.termsVersion, cfg.privacyVersion, cipher.encryptJson({ legalName: 'x' })],
  );
  tokens.push((await signAccessToken(ctx, u.rows[0].id, 0)).token);
}

async function run(label: string, total: number, fn: (i: number) => Promise<Response>) {
  const times: number[] = [];
  const statuses = new Map<number, number>();
  let next = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: C }, async () => {
    while (next < total) {
      const i = next++;
      const s = performance.now();
      const r = await fn(i);
      await r.arrayBuffer();
      times.push(performance.now() - s);
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    }
  }));
  times.sort((a, b) => a - b);
  const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(0);
  console.warn(`${label.padEnd(28)} n=${total} c=${C} p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms max=${p(1)}ms rps=${(total / ((Date.now() - t0) / 1000)).toFixed(0)} status=${JSON.stringify(Object.fromEntries(statuses))}`);
}

const auth = (i: number) => ({ authorization: `Bearer ${tokens[i % tokens.length]}` });
await run('GET /jobs (recommended)', N * 2, (i) => fetch(`${API}/jobs?latitude=35.4437&longitude=139.638&sort=recommended`, { headers: auth(i) }));
await run('GET /home', N, (i) => fetch(`${API}/home?latitude=35.4437&longitude=139.638`, { headers: auth(i) }));
await run(`POST /jobs/{id}/accept (cap=${N})`, N, (i) => fetch(`${API}/jobs/${job}/accept`, { method: 'POST', headers: { ...auth(i), 'idempotency-key': `load-${randomUUID()}`, 'content-type': 'application/json' }, body: '{}' }));
const cnt = (await db.query('SELECT reserved_count, capacity, status FROM jobs WHERE id = $1', [job])).rows[0];
console.warn(`job after accept storm: ${JSON.stringify(cnt)}`);
// Clean up like a real cancellation would: no live assignments may remain on a cancelled job.
await db.query(`UPDATE assignments SET state = 'cancelled' WHERE job_id = $1 AND state IN ('reserved','accepted')`, [job]);
await db.query(`UPDATE jobs SET status = 'cancelled', reserved_count = 0 WHERE id = $1`, [job]);
await db.end();
