import type pg from 'pg';
import type { AppContext, HandlerMap } from '../context.js';
import { body, params, requireUser } from '../context.js';
import type { Client } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { recordEvent } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { maskPhone } from '../lib/phone.js';
import { notifyAdmins } from '../lib/notify.js';
import { requireWorker } from '../auth/rbac.js';

export const RETENTION_NOTICE =
  '退会すると、氏名・電話番号・住所・口座情報・位置情報・配送先情報は削除または匿名化され、同じアカウントでは再ログインできません。' +
  'ただし、報酬の支払記録・取引明細・監査記録は法令（税務・取引記録の保存義務）および紛争対応のため最長7年間、' +
  '本人を直接識別できない形で保管します。不正防止のため、電話番号の照合用データを30日間保持し、その間は同じ番号で再登録できません。';

export interface SkillRow { code: string; name: string; status: string; source: string; valid_until: string | null; note: string | null }

export function skillView(r: SkillRow, today = new Date().toISOString().slice(0, 10)) {
  const expired = r.status === 'verified' && r.valid_until !== null && r.valid_until < today;
  return {
    code: r.code,
    name: r.name,
    status: expired ? 'expired' : r.status,
    source: r.source,
    validUntil: r.valid_until ?? undefined,
    note: r.note ?? undefined,
  };
}

export async function loadSkills(c: Client, userId: string) {
  const r = await c.query<SkillRow>(
    `SELECT ws.skill_code AS code, sd.name, ws.status, ws.source, ws.valid_until::text, ws.note
     FROM worker_skills ws JOIN skill_definitions sd ON sd.code = ws.skill_code WHERE ws.worker_id = $1 ORDER BY sd.name`,
    [userId],
  );
  return r.rows.map((x) => skillView(x));
}

export async function loadMe(ctx: AppContext, userId: string, c: Client = ctx.db) {
  const r = await c.query('SELECT * FROM app_users WHERE id = $1', [userId]);
  const u = r.rows[0];
  if (!u) throw notFound();
  const skills = await loadSkills(c, userId);
  const [orgs, stats] = [
    await c.query(
      `SELECT o.id, o.legal_name, m.role, o.review_status FROM organization_members m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1 ORDER BY o.created_at`,
      [userId],
    ),
    await c.query(
      `SELECT (SELECT avg(score)::float FROM ratings WHERE ratee_user_id = $1) AS rating_avg,
              (SELECT count(*)::int FROM ratings WHERE ratee_user_id = $1) AS rating_count,
              (SELECT count(*)::int FROM assignments WHERE worker_id = $1 AND state IN ('approved','payable','paid')) AS completed`,
      [userId],
    ),
  ];
  const profile = ctx.cipher.decryptJson<Record<string, string>>(u.profile_ciphertext);
  const s = stats.rows[0];
  return {
    id: u.id,
    displayName: u.display_name,
    verificationStatus: u.verification_status,
    verificationNote: u.verification_note ?? undefined,
    skills: skills.filter((x) => x.status === 'verified').map((x) => x.code),
    skillDetails: skills,
    roles: u.roles,
    phoneMasked: u.phone_ciphertext ? maskPhone(ctx.cipher.decrypt(u.phone_ciphertext)) : undefined,
    email: u.email ?? undefined,
    termsAccepted: u.terms_version === ctx.cfg.termsVersion && u.privacy_version === ctx.cfg.privacyVersion,
    profile,
    vehicle: u.vehicle ?? undefined,
    bankAccount: u.bank_masked ?? undefined,
    preferences: u.preferences ?? {},
    organizations: orgs.rows.map((o) => ({ id: o.id, legalName: o.legal_name, role: o.role, reviewStatus: o.review_status })),
    ratingAverage: s.rating_avg ?? undefined,
    ratingCount: s.rating_count,
    completedJobCount: s.completed,
    suspended: !!u.suspended_at,
    onboardingSteps: {
      terms: u.terms_version === ctx.cfg.termsVersion,
      profile: !!u.profile_ciphertext,
      vehicle: !!u.vehicle,
      bankAccount: !!u.bank_ciphertext,
      verification: u.verification_status === 'verified',
    },
  };
}

/** Balances and live work that block deletion (the user must settle these first). */
async function deletionBlockers(c: Client, userId: string): Promise<string[]> {
  const r = await c.query(
    `SELECT
      (SELECT count(*)::int FROM assignments WHERE worker_id = $1 AND state IN ('reserved','accepted','traveling','checked_in','working','submitted','needs_revision')) AS active,
      (SELECT count(*)::int FROM assignments WHERE worker_id = $1 AND state = 'disputed') AS disputed,
      (SELECT coalesce(sum(amount_yen),0)::int FROM ledger_entries WHERE worker_id = $1 AND entry_type IN ('earned','expense','compensation','reversal','refund'))
        - (SELECT coalesce(sum(amount_yen),0)::int FROM ledger_entries WHERE worker_id = $1 AND entry_type = 'paid') AS unpaid,
      (SELECT count(*)::int FROM organization_members WHERE user_id = $1 AND role = 'owner') AS owner_of`,
    [userId],
  );
  const s = r.rows[0];
  const b: string[] = [];
  if (s.active > 0) b.push(`進行中または予定の業務が${s.active}件あります。完了またはキャンセルしてください`);
  if (s.disputed > 0) b.push('対応中の紛争があります。解決後に退会できます');
  if (s.unpaid > 0) b.push(`未払いの報酬（¥${s.unpaid.toLocaleString('ja-JP')}）があります。振込完了後に退会できます`);
  if (s.owner_of > 0) b.push('組織のオーナーです。別のオーナーを指定してから退会してください');
  return b;
}

export const identityHandlers: HandlerMap = {
  async getMe(ctx, req) {
    return loadMe(ctx, requireUser(req).id);
  },

  async updateMe(ctx, req) {
    const u = requireUser(req);
    const b = body<{ displayName?: string }>(req);
    if (b.displayName !== undefined) {
      await ctx.db.query('UPDATE app_users SET display_name = $2, updated_at = now() WHERE id = $1', [u.id, b.displayName.trim()]);
    }
    return loadMe(ctx, u.id);
  },

  async requestAccountDeletion(ctx, req, reply) {
    const u = requireUser(req);
    const b = (req.body ?? {}) as { confirm?: unknown; reason?: unknown };
    if (b.confirm !== undefined && typeof b.confirm !== 'boolean') throw badRequest('validation', 'confirm は真偽値です');
    if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 1000)) throw badRequest('validation', '理由は1000文字以内です');
    const res = await withIdempotency(ctx, req, 'requestAccountDeletion', async (c) => {
      const blockers = await deletionBlockers(c, u.id);
      if (!b.confirm || blockers.length) {
        if (b.confirm && blockers.length) throw conflict('deletion_blocked', blockers[0]!, { blockers });
        return { status: 202, body: { status: 'confirmation_required', retentionNotice: RETENTION_NOTICE, blockers } };
      }
      const row = (await c.query('SELECT phone_hash FROM app_users WHERE id = $1 FOR UPDATE', [u.id])).rows[0];
      if (row.phone_hash) {
        await c.query('INSERT INTO deleted_identities(phone_hash) VALUES ($1) ON CONFLICT (phone_hash) DO UPDATE SET deleted_at = now()', [row.phone_hash]);
      }
      await c.query(
        `UPDATE app_users SET display_name = '退会済みユーザー', phone_ciphertext = NULL, phone_hash = NULL, email = NULL,
           password_hash = NULL, totp_secret_ciphertext = NULL, profile_ciphertext = NULL, vehicle = NULL, bank_ciphertext = NULL,
           bank_masked = NULL, preferences = '{}', verification_document_ids = '{}', token_version = token_version + 1,
           deleted_at = now(), updated_at = now()
         WHERE id = $1`,
        [u.id],
      );
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
      await c.query('DELETE FROM devices WHERE user_id = $1', [u.id]);
      await c.query('DELETE FROM job_favorites WHERE worker_id = $1', [u.id]);
      await c.query('DELETE FROM job_waitlist WHERE worker_id = $1', [u.id]);
      await c.query('DELETE FROM organization_members WHERE user_id = $1', [u.id]);
      await c.query(
        `UPDATE delivery_stops SET recipient_name_ciphertext = NULL, recipient_phone_ciphertext = NULL, note_ciphertext = NULL,
           address_ciphertext = $2, deleted_at = coalesce(deleted_at, now()) WHERE worker_id = $1`,
        [u.id, ctx.cipher.encrypt('（削除済み）')],
      );
      await c.query(`DELETE FROM location_samples WHERE assignment_id IN (SELECT id FROM assignments WHERE worker_id = $1)`, [u.id]);
      await c.query(`UPDATE evidence SET expires_at = now() WHERE uploaded_by = $1 AND purpose IN ('identity_document','skill_document')`, [u.id]);
      const d = await c.query(
        `INSERT INTO deletion_requests(user_id, reason, status, completed_at) VALUES ($1,$2,'completed', now()) RETURNING id, requested_at, completed_at`,
        [u.id, typeof b.reason === 'string' ? b.reason : null],
      );
      await recordEvent(c, { entityType: 'user', entityId: u.id, eventType: 'account_deleted', actor: { id: u.id, role: 'self' } });
      const dr = d.rows[0];
      return {
        status: 202,
        body: { id: dr.id, userId: u.id, status: 'completed', requestedAt: dr.requested_at, completedAt: dr.completed_at, retentionNotice: RETENTION_NOTICE, blockers: [] },
      };
    });
    reply.code(res.status);
    return res.body;
  },

  async acceptTerms(ctx, req) {
    const u = requireUser(req);
    const b = body<{ termsVersion: string; privacyVersion: string }>(req);
    if (b.termsVersion !== ctx.cfg.termsVersion || b.privacyVersion !== ctx.cfg.privacyVersion) {
      throw badRequest('terms_outdated', '最新の利用規約・プライバシーポリシーを確認してください', {
        termsVersion: ctx.cfg.termsVersion, privacyVersion: ctx.cfg.privacyVersion,
      });
    }
    await withTx(ctx.db, async (c) => {
      await c.query('UPDATE app_users SET terms_version = $2, privacy_version = $3, terms_accepted_at = now() WHERE id = $1', [u.id, b.termsVersion, b.privacyVersion]);
      await recordEvent(c, { entityType: 'user', entityId: u.id, eventType: 'terms_accepted', actor: { id: u.id, role: 'self' }, payload: { termsVersion: b.termsVersion, privacyVersion: b.privacyVersion } });
    });
    return loadMe(ctx, u.id);
  },

  async updateProfile(ctx, req) {
    const u = requireUser(req);
    const b = body<Record<string, string>>(req);
    const birth = new Date(`${b.birthDate}T00:00:00+09:00`);
    const age = (Date.now() - birth.getTime()) / (365.25 * 86_400_000);
    if (!(age >= 18 && age < 100)) throw badRequest('age_requirement', '18歳以上の方のみ登録できます');
    await withTx(ctx.db, async (c) => {
      const prev = await c.query('SELECT verification_status FROM app_users WHERE id = $1 FOR UPDATE', [u.id]);
      // A verified identity no longer matches changed personal details: require re-verification.
      const reset = prev.rows[0].verification_status === 'verified';
      await c.query(
        `UPDATE app_users SET profile_ciphertext = $2, updated_at = now(),
           verification_status = CASE WHEN $3 THEN 'unsubmitted' ELSE verification_status END,
           verification_note = CASE WHEN $3 THEN '本人情報が変更されたため再確認が必要です' ELSE verification_note END
         WHERE id = $1`,
        [u.id, ctx.cipher.encryptJson(b), reset],
      );
      await recordEvent(c, { entityType: 'user', entityId: u.id, eventType: 'profile_updated', actor: { id: u.id, role: 'self' }, payload: { verificationReset: reset } });
    });
    return loadMe(ctx, u.id);
  },

  async updateVehicle(ctx, req) {
    const u = requireUser(req);
    await ctx.db.query('UPDATE app_users SET vehicle = $2, updated_at = now() WHERE id = $1', [u.id, body(req)]);
    return loadMe(ctx, u.id);
  },

  async updateBankAccount(ctx, req) {
    const u = requireUser(req);
    const b = body<{ bankCode: string; branchCode: string; accountType: string; accountNumber: string; holderNameKana: string }>(req);
    const masked = { bankCode: b.bankCode, branchCode: b.branchCode, accountType: b.accountType, accountNumberLast4: b.accountNumber.slice(-4), holderNameKana: b.holderNameKana };
    await withTx(ctx.db, async (c) => {
      await c.query('UPDATE app_users SET bank_ciphertext = $2, bank_masked = $3, updated_at = now() WHERE id = $1', [u.id, ctx.cipher.encryptJson(b), masked]);
      // Approved work waiting only for a payout destination becomes payable.
      await c.query(`UPDATE assignments SET state = 'payable', updated_at = now() WHERE worker_id = $1 AND state = 'approved'`, [u.id]);
      await recordEvent(c, { entityType: 'user', entityId: u.id, eventType: 'bank_account_updated', actor: { id: u.id, role: 'self' }, payload: { last4: masked.accountNumberLast4 } });
    });
    return loadMe(ctx, u.id);
  },

  async submitVerification(ctx, req, reply) {
    const u = requireUser(req);
    requireWorker(u);
    const ids = body<{ documentEvidenceIds: string[] }>(req).documentEvidenceIds;
    const res = await withIdempotency(ctx, req, 'submitVerification', async (c) => {
      const me = (await c.query('SELECT verification_status, profile_ciphertext, terms_version FROM app_users WHERE id = $1 FOR UPDATE', [u.id])).rows[0];
      if (me.verification_status === 'verified') throw conflict('already_verified', '本人確認は完了しています');
      if (me.verification_status === 'pending') throw conflict('already_pending', '本人確認の審査中です');
      if (!me.profile_ciphertext) throw badRequest('profile_required', '先に本人情報を登録してください');
      if (me.terms_version !== ctx.cfg.termsVersion) throw badRequest('terms_required', '先に利用規約に同意してください');
      await assertOwnDocuments(c, u.id, ids, 'identity_document');
      await c.query(
        `UPDATE app_users SET verification_status = 'pending', verification_document_ids = $2, verification_note = NULL, updated_at = now() WHERE id = $1`,
        [u.id, ids],
      );
      await recordEvent(c, { entityType: 'user', entityId: u.id, eventType: 'verification_submitted', actor: { id: u.id, role: 'worker' }, payload: { documents: ids.length } });
      await notifyAdmins(c, { type: 'admin_verification', title: '本人確認の審査依頼', body: '新しい本人確認書類が提出されました', entityType: 'user', entityId: u.id });
      return { status: 202, body: null };
    });
    reply.code(res.status);
    return loadMe(ctx, u.id);
  },

  async submitSkill(ctx, req, reply) {
    const u = requireUser(req);
    requireWorker(u);
    const b = body<{ skillCode: string; validUntil?: string; documentEvidenceIds: string[] }>(req);
    const res = await withIdempotency(ctx, req, 'submitSkill', async (c) => {
      const def = (await c.query('SELECT code, name, source FROM skill_definitions WHERE code = $1', [b.skillCode])).rows[0];
      if (!def) throw badRequest('unknown_skill', '資格の種類が正しくありません');
      if (def.source !== 'document') throw badRequest('training_skill', 'この資格は講習の確認テストに合格すると付与されます');
      if (b.validUntil && b.validUntil < new Date().toISOString().slice(0, 10)) throw badRequest('expired_document', '有効期限が切れています');
      await assertOwnDocuments(c, u.id, b.documentEvidenceIds, 'skill_document');
      await c.query(
        `INSERT INTO worker_skills(worker_id, skill_code, status, source, valid_until, document_evidence_ids, submitted_at)
         VALUES ($1,$2,'pending','document',$3,$4, now())
         ON CONFLICT (worker_id, skill_code) DO UPDATE SET status = 'pending', valid_until = EXCLUDED.valid_until,
           document_evidence_ids = EXCLUDED.document_evidence_ids, note = NULL, submitted_at = now(), verified_at = NULL`,
        [u.id, b.skillCode, b.validUntil ?? null, b.documentEvidenceIds],
      );
      await recordEvent(c, { entityType: 'user', entityId: u.id, eventType: 'skill_submitted', actor: { id: u.id, role: 'worker' }, payload: { skillCode: b.skillCode } });
      await notifyAdmins(c, { type: 'admin_skill', title: '資格確認の依頼', body: `${def.name}の書類が提出されました`, entityType: 'user', entityId: u.id });
      return { status: 202, body: { code: def.code, name: def.name, status: 'pending', source: 'document', validUntil: b.validUntil } };
    });
    reply.code(res.status);
    return res.body;
  },

  async listSkillCatalog(ctx) {
    const r = await ctx.db.query('SELECT code, name, source, description, course_id FROM skill_definitions ORDER BY source DESC, name');
    return r.rows.map((x) => ({ code: x.code, name: x.name, source: x.source, description: x.description ?? undefined, courseId: x.course_id ?? undefined }));
  },

  async updatePreferences(ctx, req) {
    const u = requireUser(req);
    await withTx(ctx.db, async (c) => {
      await c.query('UPDATE app_users SET preferences = preferences || $2::jsonb, updated_at = now() WHERE id = $1', [u.id, body(req)]);
      await recordEvent(c, { entityType: 'user', entityId: u.id, eventType: 'preferences_updated', actor: { id: u.id, role: 'self' }, payload: body(req) });
    });
    return loadMe(ctx, u.id);
  },

  async registerDevice(ctx, req, reply) {
    const u = requireUser(req);
    const b = body<{ apnsToken: string; environment: string }>(req);
    await ctx.db.query(
      `INSERT INTO devices(apns_token, user_id, environment) VALUES ($1,$2,$3)
       ON CONFLICT (apns_token) DO UPDATE SET user_id = EXCLUDED.user_id, environment = EXCLUDED.environment, last_error = NULL`,
      [b.apnsToken.toLowerCase(), u.id, b.environment],
    );
    reply.code(204);
  },

  async unregisterDevice(ctx, req, reply) {
    const u = requireUser(req);
    await ctx.db.query('DELETE FROM devices WHERE apns_token = $1 AND user_id = $2', [params(req).apnsToken!.toLowerCase(), u.id]);
    reply.code(204);
  },

  async createSupportTicket(ctx, req, reply) {
    const u = requireUser(req);
    const b = body<{ category: string; body: string; assignmentId?: string }>(req);
    const res = await withIdempotency(ctx, req, 'createSupportTicket', async (c) => {
      if (b.assignmentId) {
        const a = await c.query('SELECT 1 FROM assignments WHERE id = $1 AND worker_id = $2', [b.assignmentId, u.id]);
        if (!a.rowCount) throw notFound('対象の業務が見つかりません');
      }
      const t = await createTicket(c, u.id, b.category, b.body, b.assignmentId ?? null, null);
      return { status: 201, body: t };
    });
    reply.code(res.status);
    return res.body;
  },

  async listMySupportTickets(ctx, req) {
    const u = requireUser(req);
    const r = await ctx.db.query('SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [u.id]);
    return r.rows.map(ticketView);
  },
};

export async function createTicket(c: Client, userId: string, category: string, text: string, assignmentId: string | null, jobId: string | null) {
  const r = await c.query(
    `INSERT INTO support_tickets(user_id, category, body, assignment_id, job_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, category, text, assignmentId, jobId],
  );
  await notifyAdmins(c, { type: 'admin_ticket', title: '新しい問い合わせ', body: `カテゴリ: ${category}`, entityType: 'support_ticket', entityId: r.rows[0].id });
  return ticketView(r.rows[0]);
}

export function ticketView(t: any) {
  return {
    id: t.id, userId: t.user_id, userDisplayName: t.display_name ?? undefined, category: t.category, body: t.body,
    answer: t.answer ?? undefined, status: t.status, assignmentId: t.assignment_id ?? undefined, jobId: t.job_id ?? undefined, createdAt: t.created_at,
  };
}

async function assertOwnDocuments(c: pg.PoolClient, userId: string, ids: string[], purpose: string) {
  const r = await c.query(
    `SELECT count(*)::int AS n FROM evidence WHERE id = ANY($1) AND uploaded_by = $2 AND purpose = $3 AND status = 'verified' AND deleted_at IS NULL`,
    [ids, userId, purpose],
  );
  if (r.rows[0].n !== new Set(ids).size) throw badRequest('document_invalid', '書類画像のアップロードが完了していないか、無効です');
}
