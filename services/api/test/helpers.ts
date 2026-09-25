import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../src/config.js';
import { buildApp } from '../src/server.js';
import type { AppContext } from '../src/context.js';
import type { SmsAdapter } from '../src/adapters/sms.js';
import { hashPassword } from '../src/lib/crypto.js';
import { contractValidator } from './contract-validator.js';

export class CapturingSms implements SmsAdapter {
  readonly name = 'capture';
  codes = new Map<string, string>();
  async sendOtp(phone: string, code: string) {
    this.codes.set(phone, code);
  }
}

export interface TestEnv {
  app: FastifyInstance;
  ctx: AppContext;
  sms: CapturingSms;
  close(): Promise<void>;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    publicBaseUrl: 'http://localhost',
    storage: { provider: 'local', dir: mkdtempSync(join(tmpdir(), 'hd-objects-')), signingKey: Buffer.alloc(32, 7) },
    ...overrides,
  };
}

export async function setupApp(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const cv = await contractValidator();
  setResponseValidator(cv.validate);
  const sms = new CapturingSms();
  const { app, ctx } = await buildApp({ cfg: testConfig(overrides), sms });
  await app.ready();
  return { app, ctx, sms, close: () => app.close() };
}

export const key = () => `test-${randomUUID()}`;
export const randomPhone = () => `090${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

export interface Session { token: string; refresh: string; userId: string; headers: Record<string, string> }

export function asSession(tokens: { accessToken: string; refreshToken: string }, userId: string): Session {
  return { token: tokens.accessToken, refresh: tokens.refreshToken, userId, headers: { authorization: `Bearer ${tokens.accessToken}` } };
}

type Validator = (method: string, url: string, status: number, body: unknown) => void;
let responseValidator: Validator | undefined;
/** Contract tests install a validator so that every API call made through helpers is checked against the OpenAPI contract. */
export function setResponseValidator(v: Validator | undefined) {
  responseValidator = v;
}

export const randomIp = () => `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 250)}`;

export async function call(env: TestEnv, s: Session | null, method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}, remoteAddress?: string) {
  const headers: Record<string, string> = { ...(s?.headers ?? {}), ...extraHeaders };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers['idempotency-key']) headers['idempotency-key'] = key();
  const res = await env.app.inject({ method: method as any, url: `/v1${url}`, payload: payload as any, headers, remoteAddress });
  let body: any;
  try {
    body = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    body = res.body;
  }
  responseValidator?.(method, url, res.statusCode, body);
  return { status: res.statusCode, body, headers: res.headers };
}

export async function loginWorker(env: TestEnv, phone = randomPhone()): Promise<Session & { phone: string }> {
  const ip = randomIp();
  const r1 = await call(env, null, 'POST', '/auth/otp/request', { phone }, {}, ip);
  if (r1.status !== 202) throw new Error(`otp request failed ${r1.status} ${JSON.stringify(r1.body)}`);
  const e164 = `+81${phone.slice(1)}`;
  const r2 = await call(env, null, 'POST', '/auth/otp/verify', { phone, code: env.sms.codes.get(e164) }, {}, ip);
  if (r2.status !== 200) throw new Error(`otp verify failed ${r2.status} ${JSON.stringify(r2.body)}`);
  return { ...asSession(r2.body.tokens, r2.body.user.id), phone };
}

/** Worker who completed onboarding and was verified (verification decided directly in DB to keep tests focused). */
export async function verifiedWorker(env: TestEnv, opts: { bank?: boolean; accountNumber?: string; skills?: string[] } = {}) {
  const w = await loginWorker(env);
  const c = env.ctx.cfg;
  await call(env, w, 'POST', '/me/terms', { termsVersion: c.termsVersion, privacyVersion: c.privacyVersion });
  await call(env, w, 'PUT', '/me/profile', { legalName: '山田 太郎', legalNameKana: 'ヤマダ タロウ', birthDate: '1990-04-01', postalCode: '231-0001', address: '神奈川県横浜市中区新港1-1-1' });
  await call(env, w, 'PUT', '/me/vehicle', { type: 'kei_van', plateNumber: '横浜480あ1234', blackPlateRegistered: true });
  if (opts.bank !== false) {
    await call(env, w, 'PUT', '/me/bank-account', { bankCode: '0001', branchCode: '001', accountType: 'ordinary', accountNumber: opts.accountNumber ?? '1234567', holderNameKana: 'ヤマダ タロウ' });
  }
  await env.ctx.db.query(`UPDATE app_users SET verification_status = 'verified' WHERE id = $1`, [w.userId]);
  for (const s of opts.skills ?? []) {
    await env.ctx.db.query(`INSERT INTO worker_skills(worker_id, skill_code, status, source, valid_until, verified_at) VALUES ($1,$2,'verified','training','2099-01-01', now())`, [w.userId, s]);
  }
  return w;
}

export async function webUser(env: TestEnv, roles: string[] = []): Promise<Session & { email: string; totp: OTPAuth.TOTP }> {
  const email = `u-${randomUUID()}@example.test`;
  const secret = new OTPAuth.Secret({ size: 20 });
  await env.ctx.db.query(
    `INSERT INTO app_users(display_name, email, password_hash, totp_secret_ciphertext, mfa_enabled, roles) VALUES ($1,$2,$3,$4,true,$5)`,
    ['テスト担当', email, await hashPassword('correct horse battery staple'), env.ctx.cipher.encrypt(secret.base32), roles],
  );
  const totp = new OTPAuth.TOTP({ issuer: 'HappyDrive', label: email, secret });
  const l = await call(env, null, 'POST', '/auth/web/login', { email, password: 'correct horse battery staple' }, {}, randomIp());
  const v = await call(env, null, 'POST', '/auth/web/mfa/verify', { mfaToken: l.body.mfaToken, code: totp.generate() });
  if (v.status !== 200) throw new Error(`mfa failed ${JSON.stringify(v.body)}`);
  return { ...asSession(v.body.tokens, v.body.user.id), email, totp };
}

export async function admin(env: TestEnv, role = 'admin_operator') {
  return webUser(env, [role]);
}

/** Registers an organisation and (optionally) approves it through the admin API. */
export async function approvedOrg(env: TestEnv, approve = true) {
  const owner = await webUser(env);
  const o = await call(env, owner, 'POST', '/organizations', { legalName: '株式会社テスト物流', address: '神奈川県横浜市中区山下町1-1', contact: '045-000-0000', representativeName: '代表 太郎' });
  if (o.status !== 201) throw new Error(`org failed ${JSON.stringify(o.body)}`);
  if (approve) {
    const a = await admin(env);
    await call(env, a, 'POST', `/admin/organizations/${o.body.id}/review`, { decision: 'approved', reason: '書類確認済み' });
  }
  return { owner, orgId: o.body.id as string };
}

export const YOKOHAMA = { latitude: 35.4437, longitude: 139.638 };

export function jobInput(overrides: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 3 * 3_600_000);
  start.setUTCSeconds(0, 0);
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    title: '買い物付き添い（テスト）',
    category: 'shopping_assist',
    contractType: 'contractor',
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    amountYen: 900,
    expensesReimbursedYen: 100,
    capacity: 1,
    address: '神奈川県横浜市中区山下町1-2-3',
    location: YOKOHAMA,
    areaLabel: '横浜市中区',
    description: '近くのスーパーでの買い物に付き添い、依頼者を安全にご案内します。',
    requiredSkills: [],
    cancellationPolicy: { freeCancelHoursBefore: 24, lateCancelCompensationPercent: 50, text: '開始24時間前以降の発注者都合キャンセルは報酬の50%を補償します' },
    steps: [{ title: '本人確認・あいさつ' }, { title: '買い物に付き添う', requiresPhoto: true }, { title: '完了報告' }],
    minPhotoCount: 1,
    contactName: '佐藤',
    paymentTermsText: '検収後、翌月15日までに銀行振込',
    ...overrides,
  };
}

/** Creates, submits and publishes a job. */
export async function publishedJob(env: TestEnv, org: { owner: Session; orgId: string }, overrides: Record<string, unknown> = {}) {
  const j = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs`, jobInput(overrides));
  if (j.status !== 201) throw new Error(`job create failed ${JSON.stringify(j.body)}`);
  const s = await call(env, org.owner, 'POST', `/organizations/${org.orgId}/jobs/${j.body.id}/submit`);
  if (s.status !== 200) throw new Error(`job submit failed ${JSON.stringify(s.body)}`);
  const a = await admin(env);
  const p = await call(env, a, 'POST', `/admin/jobs/${j.body.id}/review`, { decision: 'published', reason: '内容確認済み' });
  if (p.status !== 200) throw new Error(`publish failed ${JSON.stringify(p.body)}`);
  return p.body;
}

export function sha256hex(b: Buffer) {
  return createHash('sha256').update(b).digest('hex');
}

/** Minimal JPEG with an EXIF (APP1) segment carrying a fake GPS marker, plus a COM segment. */
export function jpegWithExif(): Buffer {
  const seg = (marker: number, payload: Buffer) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0GPS-LAT-35.4437-LON-139.638', 'latin1')),
    seg(0xfe, Buffer.from('comment with device id', 'latin1')),
    seg(0xdb, Buffer.alloc(65, 1)),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Uploads an image through the full signed-URL flow and returns the evidence id. */
export async function uploadEvidence(env: TestEnv, s: Session, target: Record<string, string>, data = jpegWithExif(), contentType = 'image/jpeg') {
  const c = await call(env, s, 'POST', '/evidence/uploads', { ...target, contentType, byteSize: data.length, sha256: sha256hex(data) });
  if (c.status !== 201) throw new Error(`upload create failed ${JSON.stringify(c.body)}`);
  const url = new URL(c.body.uploadUrl);
  const put = await env.app.inject({ method: 'PUT', url: url.pathname, payload: data, headers: { 'content-type': contentType } });
  if (put.statusCode !== 204) throw new Error(`put failed ${put.statusCode} ${put.body}`);
  const done = await call(env, s, 'POST', `/evidence/${c.body.evidenceId}/complete`);
  return { id: c.body.evidenceId as string, complete: done };
}
