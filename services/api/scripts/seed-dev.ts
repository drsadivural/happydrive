// Development data only. Refuses to run outside NODE_ENV=development.
// Creates an operator, an approved organisation with a site and published jobs around Yokohama, and a verified demo worker.
import * as OTPAuth from 'otpauth';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { FieldCipher, hashPassword } from '../src/lib/crypto.js';
import { coarsen, toWkt } from '../src/lib/geo.js';
import { termsHashOf } from '../src/modules/jobs.js';

const cfg = loadConfig();
if (cfg.env !== 'development') throw new Error('seed-dev は NODE_ENV=development でのみ実行できます');
const db = createPool(cfg.databaseUrl, 2);
const cipher = new FieldCipher(cfg.dataEncryptionKey, cfg.dataHmacKey);
await migrate(db);

const DEV_PASSWORD = 'happydrive-dev-password';
// Fixed dev-only TOTP secrets so the web apps can be tried locally with any authenticator app.
const secrets = { admin: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', partner: 'KRUGKIDROVUWG2ZAMJZG653OEBTG6WDA' };

async function webUser(email: string, name: string, roles: string[], secret: string) {
  const r = await db.query(
    `INSERT INTO app_users(display_name, email, password_hash, totp_secret_ciphertext, mfa_enabled, roles) VALUES ($1,$2,$3,$4,true,$5)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
    [name, email, await hashPassword(DEV_PASSWORD), cipher.encrypt(secret), roles],
  );
  return r.rows[0].id as string;
}

await webUser('admin@happydrive.local', '運営 管理者', ['admin_operator'], secrets.admin);
const partnerId = await webUser('partner@happydrive.local', '発注 担当者', ['org_member'], secrets.partner);

let org = (await db.query(`SELECT o.id FROM organizations o JOIN organization_members m ON m.org_id = o.id WHERE m.user_id = $1 LIMIT 1`, [partnerId])).rows[0];
if (!org) {
  org = (await db.query(
    `INSERT INTO organizations(legal_name, kind, address, contact, representative_name, review_status) VALUES
     ('横浜地域サポート株式会社（開発用）','company','神奈川県横浜市中区山下町1-1','dev-contact@example.jp','代表 開発','approved') RETURNING id`,
  )).rows[0];
  await db.query(`INSERT INTO organization_members(org_id, user_id, role) VALUES ($1,$2,'owner')`, [org.id, partnerId]);
  await db.query(
    `INSERT INTO sites(org_id, name, address, location, area_label) VALUES ($1,'横浜中央拠点','神奈川県横浜市中区山下町1-1',$2::geography,'横浜市中区')`,
    [org.id, toWkt({ latitude: 35.4437, longitude: 139.638 })],
  );
}

const orgRow = (await db.query('SELECT legal_name FROM organizations WHERE id = $1', [org.id])).rows[0];
const jobs = [
  { title: '買い物付き添い', category: 'shopping_assist', amount: 900, mins: 30, h: 3, lat: 35.4437, lng: 139.638, area: '横浜市中区', skills: ['life_support_training'] },
  { title: '書類の回収', category: 'corporate_task', amount: 850, mins: 25, h: 4, lat: 35.4658, lng: 139.6223, area: '横浜市西区', skills: [] },
  { title: '道路状況の撮影', category: 'community_info', amount: 600, mins: 20, h: 26, lat: 35.4526, lng: 139.6422, area: '横浜市中区', skills: [] },
  { title: '高齢者の見守り訪問', category: 'elderly_watch', amount: 1500, mins: 40, h: 28, lat: 35.4295, lng: 139.6200, area: '横浜市南区', skills: ['elderly_watch_training'] },
];
const existing = (await db.query('SELECT count(*)::int AS n FROM jobs WHERE org_id = $1 AND status = $2 AND starts_at > now()', [org.id, 'published'])).rows[0].n;
if (existing === 0) {
  for (const j of jobs) {
    const start = new Date(Date.now() + j.h * 3_600_000);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + j.mins * 60_000);
    const row = {
      title: j.title, org_name: orgRow.legal_name, contract_type: 'contractor', starts_at: start, ends_at: end, amount_yen: j.amount, expenses_reimbursed_yen: 0,
      worker_borne_costs_note: '移動の燃料費・通信費は各自負担', cancellation_policy: { freeCancelHoursBefore: 24, lateCancelCompensationPercent: 50, text: '開始24時間前以降の発注者都合のキャンセルは報酬の50%を補償します' },
      payment_terms_text: '検収後、3日以上経過した最初の15日または月末に銀行振込', employment_terms_text: null,
    };
    await db.query(
      `INSERT INTO jobs(org_id, created_by, title, category, contract_type, status, description, address_ciphertext, location, public_point, area_label,
         starts_at, ends_at, amount_yen, capacity, cancellation_policy, required_skills, steps, min_photo_count, contact_name, payment_terms_text,
         worker_borne_costs_note, published_at, terms_hash)
       VALUES ($1,$2,$3,$4,'contractor','published',$5,$6,$7::geography,$8::geography,$9,$10,$11,$12,2,$13,$14,$15,1,'開発 担当',$16,$17, now(), $18)`,
      [org.id, partnerId, j.title, j.category, `【開発用データ】${j.title}の業務です。手順に沿って実施し、完了報告をお願いします。`,
        cipher.encrypt(`神奈川県${j.area}（開発用住所）`), toWkt({ latitude: j.lat, longitude: j.lng }), toWkt(coarsen({ latitude: j.lat, longitude: j.lng })), j.area,
        start, end, j.amount, JSON.stringify(row.cancellation_policy), j.skills,
        JSON.stringify([{ title: '本人確認・あいさつ' }, { title: '依頼内容を確認' }, { title: `${j.title}を実施`, requiresPhoto: true }, { title: '完了報告を送る' }]),
        row.payment_terms_text, row.worker_borne_costs_note, termsHashOf(row, cfg.workerFeePercent)],
    );
  }
}

// Demo worker: log in from the iOS app with 090-0000-0001; the OTP appears in the API log (SMS_PROVIDER=console).
const phone = '+819000000001';
const phoneHash = cipher.blindIndex(phone);
const w = await db.query(
  `INSERT INTO app_users(display_name, phone_ciphertext, phone_hash, roles, verification_status, terms_version, privacy_version, terms_accepted_at,
     profile_ciphertext, vehicle, preferences)
   VALUES ('山田 太郎', $1, $2, '{worker}', 'verified', $3, $4, now(), $5, '{"type":"kei_van","blackPlateRegistered":true}', '{"useLocationForMatching":true,"useHistoryForMatching":true,"notifyNewJobs":true,"notifyMessages":true,"maxDistanceKm":10}')
   ON CONFLICT (phone_hash) DO UPDATE SET verification_status = 'verified' RETURNING id`,
  [cipher.encrypt(phone), phoneHash, cfg.termsVersion, cfg.privacyVersion,
    cipher.encryptJson({ legalName: '山田 太郎', legalNameKana: 'ヤマダ タロウ', birthDate: '1990-04-01', postalCode: '231-0001', address: '神奈川県横浜市中区（開発用）' })],
);
await db.query(
  `INSERT INTO worker_skills(worker_id, skill_code, status, source, valid_until, verified_at) VALUES ($1,'life_support_training','verified','training', now() + interval '1 year', now())
   ON CONFLICT DO NOTHING`,
  [w.rows[0].id],
);
await db.end();

const uri = (label: string, s: string) => new OTPAuth.TOTP({ issuer: 'HappyDrive (dev)', label, secret: OTPAuth.Secret.fromBase32(s) }).toString();
console.warn(`
開発用データを作成しました（本番では使用しないでください）
- 運営Web   admin@happydrive.local   / ${DEV_PASSWORD}   TOTP: ${uri('admin@happydrive.local', secrets.admin)}
- 企業Web   partner@happydrive.local / ${DEV_PASSWORD}   TOTP: ${uri('partner@happydrive.local', secrets.partner)}
- ドライバー 090-0000-0001（確認コードはAPIログに表示されます）
`);
