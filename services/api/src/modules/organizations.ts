import type pg from 'pg';
import type { AppContext, HandlerMap } from '../context.js';
import { body, params, query, requireUser } from '../context.js';
import type { Client } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { recordEvent } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { coarsen, pointSql, toWkt, type Point } from '../lib/geo.js';
import { currentJstMonth, jstDate, jstMonthRange } from '../lib/time.js';
import { notifyAdmins } from '../lib/notify.js';
import { ORG_ALL, ORG_EDITORS, ORG_OWNER, requireOrgRole } from '../auth/rbac.js';
import { JOB_COLUMNS, jobPublicView } from './jobs.js';
import { cancelByOrganization, loadAssignmentView } from './assignments.js';

export const RESTRICTED_CATEGORIES = ['personal_care', 'healthcare'];
const PHONE_IN_TEXT = /0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{4}/;

export function orgView(o: any) {
  return {
    id: o.id, legalName: o.legal_name, kind: o.kind, corporateNumber: o.corporate_number ?? undefined, address: o.address, contact: o.contact,
    representativeName: o.representative_name, reviewStatus: o.review_status, reviewNote: o.review_note ?? undefined, createdAt: o.created_at,
  };
}

export interface PublishCheck { code: string; ok: boolean; message: string }

/** Pre-publication checks (required disclosures, legal classification, restricted work). All must pass to publish. */
export async function publishChecks(ctx: AppContext, c: Client, j: any): Promise<PublishCheck[]> {
  const hours = (new Date(j.ends_at).getTime() - new Date(j.starts_at).getTime()) / 3_600_000;
  const skills = await c.query('SELECT code, restricted FROM skill_definitions WHERE code = ANY($1)', [j.required_skills]);
  const unknownSkills = (j.required_skills as string[]).filter((s) => !skills.rows.some((r) => r.code === s));
  const restrictedSkill = skills.rows.some((r) => r.restricted);
  const checks: PublishCheck[] = [
    { code: 'organization_approved', ok: j.org_status === 'approved', message: '発注組織の審査が完了していること' },
    { code: 'organization_disclosure', ok: !!(j.org_name && j.org_address && j.org_contact), message: '発注者の名称・所在地・連絡先が表示できること' },
    { code: 'contract_type_resolved', ok: j.contract_type !== 'other_legal_review', message: '契約区分（雇用／業務委託）が確定していること（法務審査中は公開不可）' },
    { code: 'category_allowed', ok: !RESTRICTED_CATEGORIES.includes(j.category) || ctx.cfg.restrictedCategoriesEnabled, message: '身体介護・医療関連は資格要件と事業審査が確定するまで公開不可' },
    { code: 'restricted_skill', ok: !restrictedSkill || ctx.cfg.restrictedCategoriesEnabled, message: '要資格の介護業務は事業審査が確定するまで公開不可' },
    { code: 'skills_known', ok: unknownSkills.length === 0, message: '必要資格が登録済みの資格であること' },
    { code: 'payment_terms', ok: !!j.payment_terms_text?.trim(), message: '報酬の支払期日・支払方法が明示されていること' },
    {
      code: 'employment_terms',
      ok: j.contract_type !== 'employment' || (j.employment_terms_text?.trim()?.length ?? 0) >= 20,
      message: '雇用の場合は労働条件（就業場所・業務内容・時間・休憩・賃金など）を明示すること',
    },
    {
      code: 'minimum_wage',
      ok: j.contract_type !== 'employment' || Number(j.amount_yen) / Math.max(hours, 0.25) >= ctx.cfg.minHourlyWageYen,
      message: `雇用の場合は時給換算が${ctx.cfg.minHourlyWageYen.toLocaleString('ja-JP')}円以上であること（地域別最低賃金の確認用基準）`,
    },
    { code: 'schedule', ok: new Date(j.starts_at).getTime() > Date.now() + 60 * 60_000 && hours <= 12, message: '開始が1時間以上先で、所要12時間以内であること' },
    { code: 'contact_name', ok: !!j.contact_name?.trim(), message: '現地の担当者名が設定されていること' },
    { code: 'steps', ok: Array.isArray(j.steps) && j.steps.length > 0, message: '業務手順が1つ以上あること' },
    { code: 'no_personal_phone', ok: !PHONE_IN_TEXT.test(`${j.description} ${j.meeting_point_note ?? ''}`), message: '説明文に電話番号を記載しないこと（連絡はアプリ内メッセージ）' },
  ];
  return checks;
}

async function orgJobView(ctx: AppContext, c: Client, j: any) {
  const counts = await c.query(
    `SELECT count(*) FILTER (WHERE state NOT IN ('cancelled','declined','expired'))::int AS applications,
            count(*) FILTER (WHERE state IN ('traveling','checked_in','working'))::int AS active,
            count(*) FILTER (WHERE state = 'submitted')::int AS awaiting,
            (SELECT count(*)::int FROM job_waitlist w WHERE w.job_id = $1) AS waitlist
     FROM assignments WHERE job_id = $1`,
    [j.id],
  );
  const cnt = counts.rows[0];
  return {
    ...jobPublicView(j),
    address: ctx.cipher.decrypt(j.address_ciphertext),
    location: j.loc,
    siteId: j.site_id ?? undefined,
    reviewNote: j.review_note ?? undefined,
    createdAt: j.created_at,
    checkInRadiusMeters: j.check_in_radius_m,
    reservationTtlMinutes: j.reservation_ttl_minutes,
    applicationCount: cnt.applications,
    activeCount: cnt.active,
    awaitingReviewCount: cnt.awaiting,
    waitlistCount: cnt.waitlist,
    publishChecks: ['draft', 'rejected', 'pending_review'].includes(j.status) ? await publishChecks(ctx, c, j) : undefined,
  };
}

export async function loadOrgJob(c: Client, orgId: string | null, jobId: string, lock = false) {
  const r = await c.query(
    `SELECT ${JOB_COLUMNS} FROM jobs j JOIN organizations o ON o.id = j.org_id WHERE j.id = $1 ${orgId ? 'AND j.org_id = $2' : ''} ${lock ? 'FOR UPDATE OF j' : ''}`,
    orgId ? [jobId, orgId] : [jobId],
  );
  if (!r.rows[0]) throw notFound('案件が見つかりません');
  return r.rows[0];
}

export { orgJobView };

interface NewJobInput {
  title: string; category: string; contractType: string; startsAt: string; endsAt: string; amountYen: number; expensesReimbursedYen?: number;
  workerBorneCostsNote?: string; capacity: number; siteId?: string; address: string; location: Point; areaLabel: string; description: string;
  requiredSkills?: string[]; cancellationPolicy: { freeCancelHoursBefore: number; lateCancelCompensationPercent: number; text: string };
  steps: { title: string; description?: string; requiresPhoto?: boolean }[]; minPhotoCount?: number; requiresOrgApproval?: boolean;
  reservationTtlMinutes?: number; checkInRadiusMeters?: number; meetingPointNote?: string; safetyNotes?: string; contactName?: string;
  paymentTermsText?: string; employmentTermsText?: string;
}

async function validateJobInput(ctx: AppContext, c: Client, orgId: string, b: NewJobInput) {
  if (Date.parse(b.endsAt) <= Date.parse(b.startsAt)) throw badRequest('invalid_schedule', '終了日時は開始日時より後にしてください');
  if (RESTRICTED_CATEGORIES.includes(b.category) && !ctx.cfg.restrictedCategoriesEnabled) {
    throw badRequest('category_restricted', '身体介護・医療関連の案件は、資格要件と事業審査が確定するまで作成できません');
  }
  if (b.siteId) {
    const s = await c.query('SELECT 1 FROM sites WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL', [b.siteId, orgId]);
    if (!s.rowCount) throw badRequest('invalid_site', '拠点が見つかりません');
  }
  const photoSteps = b.steps.filter((s) => s.requiresPhoto).length;
  if ((b.minPhotoCount ?? 0) > 20 || photoSteps > 20) throw badRequest('validation', '写真の必要枚数が多すぎます');
}

function jobParams(ctx: AppContext, b: NewJobInput) {
  return [
    b.title.trim(), b.category, b.contractType, b.description, ctx.cipher.encrypt(b.address.trim()), toWkt(b.location), toWkt(coarsen(b.location)),
    b.areaLabel.trim(), b.startsAt, b.endsAt, b.amountYen, b.expensesReimbursedYen ?? 0, b.workerBorneCostsNote ?? null, b.capacity,
    JSON.stringify(b.cancellationPolicy), b.requiredSkills ?? [], JSON.stringify(b.steps), b.minPhotoCount ?? 0, b.requiresOrgApproval ?? false,
    b.reservationTtlMinutes ?? 60, b.checkInRadiusMeters ?? 300, b.meetingPointNote ?? null, b.safetyNotes ?? null, b.contactName ?? null,
    b.paymentTermsText ?? null, b.employmentTermsText ?? null, b.siteId ?? null,
  ];
}

export const organizationHandlers: HandlerMap = {
  async registerOrganization(ctx, req, reply) {
    const u = requireUser(req);
    if (!u.isWebUser) throw forbidden('企業アカウントはWebポータルから登録してください');
    const b = body<{ legalName: string; kind?: string; corporateNumber?: string; address: string; contact: string; representativeName: string }>(req);
    const res = await withIdempotency(ctx, req, 'registerOrganization', async (c) => {
      const o = await c.query(
        `INSERT INTO organizations(legal_name, kind, corporate_number, address, contact, representative_name, review_status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
        [b.legalName.trim(), b.kind ?? 'company', b.corporateNumber ?? null, b.address.trim(), b.contact.trim(), b.representativeName.trim()],
      );
      await c.query(`INSERT INTO organization_members(org_id, user_id, role) VALUES ($1,$2,'owner')`, [o.rows[0].id, u.id]);
      await c.query(`UPDATE app_users SET roles = array_append(roles, 'org_member') WHERE id = $1 AND NOT ('org_member' = ANY(roles))`, [u.id]);
      await notifyAdmins(c, { type: 'admin_org_review', title: '企業審査の依頼', body: `${b.legalName} が登録を申請しました`, entityType: 'organization', entityId: o.rows[0].id });
      await recordEvent(c, { entityType: 'organization', entityId: o.rows[0].id, eventType: 'registered', actor: { id: u.id, role: 'organization' } });
      return { status: 201, body: orgView(o.rows[0]) };
    });
    reply.code(res.status);
    return res.body;
  },

  async getOrganization(ctx, req) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_ALL);
    const r = await ctx.db.query('SELECT * FROM organizations WHERE id = $1', [id]);
    return orgView(r.rows[0]);
  },

  async updateOrganization(ctx, req) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_OWNER);
    const b = body<{ legalName: string; kind?: string; corporateNumber?: string; address: string; contact: string; representativeName: string }>(req);
    return withTx(ctx.db, async (c) => {
      const prev = (await c.query('SELECT * FROM organizations WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const legalChanged = prev.legal_name !== b.legalName.trim() || (prev.corporate_number ?? null) !== (b.corporateNumber ?? null) || prev.address !== b.address.trim();
      const status = legalChanged && prev.review_status === 'approved' ? 'pending' : prev.review_status;
      const r = await c.query(
        `UPDATE organizations SET legal_name = $2, kind = $3, corporate_number = $4, address = $5, contact = $6, representative_name = $7,
           review_status = $8, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, b.legalName.trim(), b.kind ?? prev.kind, b.corporateNumber ?? null, b.address.trim(), b.contact.trim(), b.representativeName.trim(), status],
      );
      if (status !== prev.review_status) {
        await notifyAdmins(c, { type: 'admin_org_review', title: '企業情報の再審査', body: `${b.legalName} の法的情報が変更されました`, entityType: 'organization', entityId: id });
      }
      await recordEvent(c, { entityType: 'organization', entityId: id, eventType: 'updated', actor: { id: u.id, role: 'organization' }, payload: { reReview: status !== prev.review_status } });
      return orgView(r.rows[0]);
    });
  },

  async getOrganizationDashboard(ctx, req) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_ALL);
    const [month] = [jstMonthRange(currentJstMonth())];
    const s = await ctx.db.query(
      `SELECT
        (SELECT count(*)::int FROM jobs WHERE org_id = $1 AND status IN ('published','filled') AND ends_at > now()) AS published,
        (SELECT count(DISTINCT a.worker_id)::int FROM assignments a JOIN jobs j ON j.id = a.job_id
           WHERE j.org_id = $1 AND a.state IN ('accepted','traveling','checked_in','working','submitted')
             AND j.starts_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'
             AND j.starts_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') + interval '1 day') AT TIME ZONE 'Asia/Tokyo') AS active_today,
        (SELECT count(*)::int FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE j.org_id = $1 AND a.state = 'submitted') AS awaiting,
        (SELECT count(*)::int FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE j.org_id = $1 AND a.state = 'reserved') AS reservations,
        (SELECT coalesce(sum(amount_yen),0)::int FROM ledger_entries WHERE org_id = $1 AND entry_type <> 'paid' AND created_at >= $2 AND created_at < $3) AS spend`,
      [id, month[0], month[1]],
    );
    const jobs = await ctx.db.query(
      `SELECT j.id, j.title, j.category, j.status, j.starts_at,
         count(a.*) FILTER (WHERE a.state NOT IN ('cancelled','declined','expired'))::int AS applications,
         count(a.*) FILTER (WHERE a.state = 'submitted')::int AS submitted,
         count(a.*) FILTER (WHERE a.state IN ('traveling','checked_in','working'))::int AS active
       FROM jobs j LEFT JOIN assignments a ON a.job_id = j.id WHERE j.org_id = $1
       GROUP BY j.id ORDER BY (j.status IN ('published','filled')) DESC, j.starts_at DESC LIMIT 20`,
      [id],
    );
    const label: Record<string, string> = { published: '募集中', filled: '満員', draft: '下書き', pending_review: '審査中', cancelled: '取消', rejected: '却下', expired: '期限切れ', completed: '完了' };
    const row = s.rows[0];
    return {
      publishedJobCount: row.published,
      activeWorkersToday: row.active_today,
      awaitingReviewCount: row.awaiting,
      pendingReservationCount: row.reservations,
      monthToDateSpendYen: row.spend,
      jobs: jobs.rows.map((j) => ({
        id: j.id, title: j.title, category: j.category, applicationCount: j.applications, status: j.status, startsAt: j.starts_at,
        progressLabel: j.submitted > 0 ? '検収待ち' : j.active > 0 ? '実施中' : label[j.status] ?? j.status,
      })),
    };
  },

  async listSites(ctx, req) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_ALL);
    const r = await ctx.db.query(`SELECT id, name, address, area_label, ${pointSql('location')} AS loc FROM sites WHERE org_id = $1 AND deleted_at IS NULL ORDER BY name`, [id]);
    return r.rows.map((s) => ({ id: s.id, name: s.name, address: s.address, areaLabel: s.area_label, location: s.loc }));
  },

  async createSite(ctx, req, reply) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_EDITORS);
    const b = body<{ name: string; address: string; location: Point; areaLabel: string }>(req);
    const res = await withIdempotency(ctx, req, 'createSite', async (c) => {
      const r = await c.query(
        `INSERT INTO sites(org_id, name, address, location, area_label) VALUES ($1,$2,$3,$4::geography,$5) RETURNING id`,
        [id, b.name.trim(), b.address.trim(), toWkt(b.location), b.areaLabel.trim()],
      );
      return { status: 201, body: { id: r.rows[0].id, ...b } };
    });
    reply.code(res.status);
    return res.body;
  },

  async updateSite(ctx, req) {
    const u = requireUser(req);
    const p = params(req);
    await requireOrgRole(ctx, u, p.organizationId!, ORG_EDITORS);
    const b = body<{ name: string; address: string; location: Point; areaLabel: string }>(req);
    const r = await ctx.db.query(
      `UPDATE sites SET name = $3, address = $4, location = $5::geography, area_label = $6 WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL RETURNING id`,
      [p.siteId, p.organizationId, b.name.trim(), b.address.trim(), toWkt(b.location), b.areaLabel.trim()],
    );
    if (!r.rowCount) throw notFound('拠点が見つかりません');
    return { id: p.siteId, ...b };
  },

  async deleteSite(ctx, req, reply) {
    const u = requireUser(req);
    const p = params(req);
    await requireOrgRole(ctx, u, p.organizationId!, ORG_EDITORS);
    await ctx.db.query('UPDATE sites SET deleted_at = now() WHERE id = $1 AND org_id = $2', [p.siteId, p.organizationId]);
    reply.code(204);
  },

  async listMembers(ctx, req) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_ALL);
    const r = await ctx.db.query(
      `SELECT m.user_id, m.role, u.display_name, u.email, u.mfa_enabled FROM organization_members m JOIN app_users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`,
      [id],
    );
    return r.rows.map((m) => ({ userId: m.user_id, displayName: m.display_name, email: m.email ?? undefined, role: m.role, mfaEnabled: m.mfa_enabled }));
  },

  async addMember(ctx, req, reply) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_OWNER);
    const b = body<{ email: string; role: string }>(req);
    return withTx(ctx.db, async (c) => {
      const target = (await c.query('SELECT id, display_name, email, mfa_enabled FROM app_users WHERE email = $1 AND deleted_at IS NULL', [b.email.trim().toLowerCase()])).rows[0];
      if (!target) throw notFound('このメールアドレスのWebアカウントが見つかりません。先に登録してもらってください');
      await c.query(
        `INSERT INTO organization_members(org_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [id, target.id, b.role],
      );
      await c.query(`UPDATE app_users SET roles = array_append(roles, 'org_member') WHERE id = $1 AND NOT ('org_member' = ANY(roles))`, [target.id]);
      await recordEvent(c, { entityType: 'organization', entityId: id, eventType: 'member_added', actor: { id: u.id, role: 'organization' }, payload: { userId: target.id, role: b.role } });
      reply.code(201);
      return { userId: target.id, displayName: target.display_name, email: target.email, role: b.role, mfaEnabled: target.mfa_enabled };
    });
  },

  async removeMember(ctx, req, reply) {
    const u = requireUser(req);
    const p = params(req);
    await requireOrgRole(ctx, u, p.organizationId!, ORG_OWNER);
    await withTx(ctx.db, async (c) => {
      const owners = await c.query(`SELECT user_id FROM organization_members WHERE org_id = $1 AND role = 'owner' FOR UPDATE`, [p.organizationId]);
      if (owners.rows.length === 1 && owners.rows[0].user_id === p.userId) throw conflict('last_owner', '最後のオーナーは削除できません');
      await c.query('DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2', [p.organizationId, p.userId]);
      await recordEvent(c, { entityType: 'organization', entityId: p.organizationId!, eventType: 'member_removed', actor: { id: u.id, role: 'organization' }, payload: { userId: p.userId } });
    });
    reply.code(204);
  },

  async listOrganizationJobs(ctx, req) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_ALL);
    const status = query<{ status?: string }>(req).status;
    const r = await ctx.db.query(
      `SELECT ${JOB_COLUMNS} FROM jobs j JOIN organizations o ON o.id = j.org_id WHERE j.org_id = $1 ${status ? 'AND j.status = $2' : ''} ORDER BY j.starts_at DESC LIMIT 200`,
      status ? [id, status] : [id],
    );
    const out = [];
    for (const j of r.rows) out.push(await orgJobView(ctx, ctx.db, j));
    return out;
  },

  async createJob(ctx, req, reply) {
    const u = requireUser(req);
    const orgId = params(req).organizationId!;
    await requireOrgRole(ctx, u, orgId, ORG_EDITORS);
    const b = body<NewJobInput>(req);
    const res = await withIdempotency(ctx, req, 'createJob', async (c) => {
      await validateJobInput(ctx, c, orgId, b);
      const r = await c.query(
        `INSERT INTO jobs(title, category, contract_type, description, address_ciphertext, location, public_point, area_label, starts_at, ends_at,
           amount_yen, expenses_reimbursed_yen, worker_borne_costs_note, capacity, cancellation_policy, required_skills, steps, min_photo_count,
           requires_org_approval, reservation_ttl_minutes, check_in_radius_m, meeting_point_note, safety_notes, contact_name, payment_terms_text,
           employment_terms_text, site_id, org_id, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6::geography,$7::geography,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,'draft')
         RETURNING id`,
        [...jobParams(ctx, b), orgId, u.id],
      );
      await recordEvent(c, { entityType: 'job', entityId: r.rows[0].id, eventType: 'draft_created', actor: { id: u.id, role: 'organization' } });
      return { status: 201, body: await orgJobView(ctx, c, await loadOrgJob(c, orgId, r.rows[0].id)) };
    });
    reply.code(res.status);
    return res.body;
  },

  async getOrganizationJob(ctx, req) {
    const u = requireUser(req);
    const p = params(req);
    await requireOrgRole(ctx, u, p.organizationId!, ORG_ALL);
    return orgJobView(ctx, ctx.db, await loadOrgJob(ctx.db, p.organizationId!, p.jobId!));
  },

  async updateJob(ctx, req) {
    const u = requireUser(req);
    const p = params(req);
    await requireOrgRole(ctx, u, p.organizationId!, ORG_EDITORS);
    const b = body<NewJobInput>(req);
    return withTx(ctx.db, async (c) => {
      const j = await loadOrgJob(c, p.organizationId!, p.jobId!, true);
      if (!['draft', 'rejected'].includes(j.status)) throw conflict('not_editable', '公開申請後の案件は編集できません。取り消して新しく作成してください');
      await validateJobInput(ctx, c, p.organizationId!, b);
      await c.query(
        `UPDATE jobs SET title=$1, category=$2, contract_type=$3, description=$4, address_ciphertext=$5, location=$6::geography, public_point=$7::geography,
           area_label=$8, starts_at=$9, ends_at=$10, amount_yen=$11, expenses_reimbursed_yen=$12, worker_borne_costs_note=$13, capacity=$14,
           cancellation_policy=$15, required_skills=$16, steps=$17, min_photo_count=$18, requires_org_approval=$19, reservation_ttl_minutes=$20,
           check_in_radius_m=$21, meeting_point_note=$22, safety_notes=$23, contact_name=$24, payment_terms_text=$25, employment_terms_text=$26,
           site_id=$27, status='draft', updated_at=now()
         WHERE id = $28`,
        [...jobParams(ctx, b), j.id],
      );
      await recordEvent(c, { entityType: 'job', entityId: j.id, eventType: 'draft_updated', actor: { id: u.id, role: 'organization' } });
      return orgJobView(ctx, c, await loadOrgJob(c, p.organizationId!, j.id));
    });
  },

  async submitJobForReview(ctx, req) {
    const u = requireUser(req);
    const p = params(req);
    await requireOrgRole(ctx, u, p.organizationId!, ORG_EDITORS);
    const res = await withIdempotency(ctx, req, 'submitJobForReview', async (c) => {
      const j = await loadOrgJob(c, p.organizationId!, p.jobId!, true);
      if (!['draft', 'rejected'].includes(j.status)) throw conflict('invalid_state', 'この案件は申請できる状態ではありません');
      const checks = await publishChecks(ctx, c, j);
      const failed = checks.filter((x) => !x.ok);
      if (failed.length) throw badRequest('publish_checks_failed', `公開前チェックを満たしていません: ${failed.map((f) => f.message).join(' / ')}`, { checks });
      await c.query(`UPDATE jobs SET status = 'pending_review', review_note = NULL, updated_at = now() WHERE id = $1`, [j.id]);
      await notifyAdmins(c, { type: 'admin_job_review', title: '案件の公開審査', body: `「${j.title}」の審査依頼`, entityType: 'job', entityId: j.id });
      await recordEvent(c, { entityType: 'job', entityId: j.id, eventType: 'submitted_for_review', actor: { id: u.id, role: 'organization' } });
      return { status: 200, body: await orgJobView(ctx, c, await loadOrgJob(c, p.organizationId!, j.id)) };
    });
    return res.body;
  },

  async cancelJob(ctx, req) {
    const u = requireUser(req);
    const p = params(req);
    await requireOrgRole(ctx, u, p.organizationId!, ORG_EDITORS);
    const reason = body<{ reason: string }>(req).reason;
    const res = await withIdempotency(ctx, req, 'cancelJob', async (c) => {
      const j = await loadOrgJob(c, p.organizationId!, p.jobId!, true);
      await cancelJobCascade(c, j, { id: u.id, role: 'organization' }, reason);
      return { status: 200, body: await orgJobView(ctx, c, await loadOrgJob(c, p.organizationId!, j.id)) };
    });
    return res.body;
  },

  async listJobAssignments(ctx, req) {
    const u = requireUser(req);
    const p = params(req);
    await requireOrgRole(ctx, u, p.organizationId!, ORG_ALL);
    await loadOrgJob(ctx.db, p.organizationId!, p.jobId!);
    const r = await ctx.db.query('SELECT id FROM assignments WHERE job_id = $1 ORDER BY accepted_at', [p.jobId]);
    const out = [];
    for (const row of r.rows) out.push(await loadAssignmentView(ctx, ctx.db, row.id, u));
    return out;
  },

  async listOrganizationAssignments(ctx, req) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_ALL);
    const state = query<{ state?: string }>(req).state;
    const r = await ctx.db.query(
      `SELECT a.id FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE j.org_id = $1 ${state ? 'AND a.state = $2' : ''} ORDER BY j.starts_at DESC LIMIT 200`,
      state ? [id, state] : [id],
    );
    const out = [];
    for (const row of r.rows) out.push(await loadAssignmentView(ctx, ctx.db, row.id, u));
    return out;
  },

  async listInvoices(ctx, req) {
    const u = requireUser(req);
    const id = params(req).organizationId!;
    await requireOrgRole(ctx, u, id, ORG_EDITORS);
    const r = await ctx.db.query(
      `SELECT to_char(l.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS month, l.assignment_id, j.title, u.display_name, j.starts_at,
         coalesce(sum(l.amount_yen) FILTER (WHERE l.entry_type IN ('earned','compensation')), 0)::int AS base,
         coalesce(sum(l.amount_yen) FILTER (WHERE l.entry_type = 'expense'), 0)::int AS expenses,
         coalesce(sum(l.amount_yen) FILTER (WHERE l.entry_type IN ('reversal','refund')), 0)::int AS adjustments
       FROM ledger_entries l JOIN assignments a ON a.id = l.assignment_id JOIN jobs j ON j.id = a.job_id JOIN app_users u ON u.id = a.worker_id
       WHERE l.org_id = $1 AND l.entry_type <> 'paid'
       GROUP BY 1, l.assignment_id, j.title, u.display_name, j.starts_at ORDER BY 1 DESC, j.starts_at`,
      [id],
    );
    const months = new Map<string, any[]>();
    for (const row of r.rows) months.set(row.month, [...(months.get(row.month) ?? []), row]);
    return [...months.entries()].map(([month, rows]) => {
      const worker = rows.reduce((s, x) => s + x.base + x.adjustments, 0);
      const expenses = rows.reduce((s, x) => s + x.expenses, 0);
      const fee = Math.floor((worker * ctx.cfg.platformFeePercent) / 100);
      const tax = Math.floor(fee * 0.1);
      return {
        month, workerPaymentsYen: worker, expensesYen: expenses, platformFeeYen: fee, taxYen: tax, totalYen: worker + expenses + fee + tax,
        lines: rows.map((x) => ({ assignmentId: x.assignment_id, jobTitle: x.title, workerDisplayName: x.display_name, workDate: jstDate(x.starts_at), amountYen: x.base, expensesYen: x.expenses, adjustmentsYen: x.adjustments })),
      };
    });
  },
};

/** Cancels a job and every live assignment on it (used by organisations and by operators). */
export async function cancelJobCascade(c: pg.PoolClient, j: any, actor: { id: string; role: string }, reason: string) {
  if (!['draft', 'pending_review', 'published', 'filled', 'rejected'].includes(j.status)) throw conflict('invalid_state', 'この案件は取り消せません');
  const live = await c.query(
    `SELECT a.*, j.title, j.org_id, j.contract_type, j.starts_at, j.cancellation_policy FROM assignments a JOIN jobs j ON j.id = a.job_id
     WHERE a.job_id = $1 AND a.state IN ('reserved','accepted','traveling','checked_in','working') FOR UPDATE OF a`,
    [j.id],
  );
  for (const a of live.rows) await cancelByOrganization(c, a, actor, reason);
  await c.query(`UPDATE jobs SET status = 'cancelled', review_note = $2, updated_at = now() WHERE id = $1`, [j.id, reason]);
  await c.query('DELETE FROM job_waitlist WHERE job_id = $1', [j.id]);
  await recordEvent(c, { entityType: 'job', entityId: j.id, eventType: 'cancelled', actor, reason, payload: { affectedAssignments: live.rowCount } });
}
