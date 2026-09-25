import type { AppContext, HandlerMap } from '../context.js';
import { body, params, query, requireUser } from '../context.js';
import { withTx } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { recordEvent } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { maskPhone } from '../lib/phone.js';
import { jstStartOfDay } from '../lib/time.js';
import { notify, notifyOrg } from '../lib/notify.js';
import { requireAdmin } from '../auth/rbac.js';
import { RETENTION_NOTICE, loadSkills, ticketView } from './identity.js';
import { JOB_COLUMNS, termsHashOf, toMatchJob } from './jobs.js';
import { approveAndBook, loadAssignmentRowForAdmin, loadAssignmentView } from './assignments.js';
import { cancelJobCascade, loadOrgJob, orgJobView, orgView, publishChecks } from './organizations.js';
import { reportView } from './messaging.js';
import { exclusions, loadMatchingConfig, loadWorkerContext, EXCLUSION_LABEL } from './matching.js';

function adminUserView(ctx: AppContext, u: any) {
  return {
    id: u.id, displayName: u.display_name, verificationStatus: u.verification_status, roles: u.roles, suspended: !!u.suspended_at,
    phoneMasked: u.phone_ciphertext ? maskPhone(ctx.cipher.decrypt(u.phone_ciphertext)) : undefined, email: u.email ?? undefined,
    pendingSkillCount: u.pending_skills ?? 0, deleted: !!u.deleted_at, createdAt: u.created_at,
  };
}

async function adminUserDetail(ctx: AppContext, id: string) {
  const r = await ctx.db.query(
    `SELECT u.*, (SELECT count(*)::int FROM worker_skills ws WHERE ws.worker_id = u.id AND ws.status = 'pending') AS pending_skills,
       (SELECT count(*)::int FROM assignments a WHERE a.worker_id = u.id) AS assignments,
       (SELECT avg(score)::float FROM ratings WHERE ratee_user_id = u.id) AS rating
     FROM app_users u WHERE u.id = $1`,
    [id],
  );
  const u = r.rows[0];
  if (!u) throw notFound();
  const skills = await loadSkills(ctx.db, id);
  const docs = await ctx.db.query('SELECT skill_code, document_evidence_ids FROM worker_skills WHERE worker_id = $1', [id]);
  const docMap = new Map(docs.rows.map((d) => [d.skill_code, d.document_evidence_ids]));
  return {
    ...adminUserView(ctx, u),
    profile: ctx.cipher.decryptJson(u.profile_ciphertext),
    vehicle: u.vehicle ?? undefined,
    bankAccount: u.bank_masked ?? undefined,
    skills: skills.map((s) => ({ ...s, documentEvidenceIds: docMap.get(s.code) ?? [] })),
    verificationDocumentIds: u.verification_document_ids,
    verificationNote: u.verification_note ?? undefined,
    assignmentCount: u.assignments,
    ratingAverage: u.rating ?? undefined,
  };
}

export const adminHandlers: HandlerMap = {
  async adminListUsers(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const q = query<{ verificationStatus?: string; q?: string }>(req);
    const vals: unknown[] = [];
    const where = ['true'];
    if (q.verificationStatus) { vals.push(q.verificationStatus); where.push(`u.verification_status = $${vals.length}`); }
    if (q.q) { vals.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(u.display_name ILIKE $${vals.length} OR u.email ILIKE $${vals.length})`); }
    const r = await ctx.db.query(
      `SELECT u.*, (SELECT count(*)::int FROM worker_skills ws WHERE ws.worker_id = u.id AND ws.status = 'pending') AS pending_skills
       FROM app_users u WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC LIMIT 200`,
      vals,
    );
    return r.rows.map((u) => adminUserView(ctx, u));
  },

  async adminGetUser(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'read');
    const id = params(req).userId!;
    const detail = await adminUserDetail(ctx, id);
    await withTx(ctx.db, (c) => recordEvent(c, { entityType: 'user', entityId: id, eventType: 'admin_viewed_pii', actor: { id: me.id, role: me.roles.join(',') } }));
    return detail;
  },

  async adminDecideVerification(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'operate');
    const id = params(req).userId!;
    const b = body<{ decision: 'verified' | 'rejected'; reason: string }>(req);
    await withIdempotency(ctx, req, 'adminDecideVerification', async (c) => {
      const u = (await c.query('SELECT verification_status FROM app_users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!u) throw notFound();
      if (u.verification_status !== 'pending') throw conflict('invalid_state', '審査待ちではありません');
      await c.query('UPDATE app_users SET verification_status = $2, verification_note = $3, updated_at = now() WHERE id = $1', [id, b.decision, b.decision === 'rejected' ? b.reason : null]);
      await notify(c, [id], b.decision === 'verified'
        ? { type: 'verification_verified', title: '本人確認が完了しました', body: '案件の受諾ができるようになりました', entityType: 'user', entityId: id }
        : { type: 'verification_rejected', title: '本人確認ができませんでした', body: b.reason, entityType: 'user', entityId: id });
      await recordEvent(c, { entityType: 'user', entityId: id, eventType: `verification_${b.decision}`, actor: { id: me.id, role: 'admin_operator' }, reason: b.reason });
      return { status: 200, body: null };
    });
    return adminUserDetail(ctx, id);
  },

  async adminSetSuspension(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'operate');
    const id = params(req).userId!;
    const b = body<{ suspended: boolean; reason: string }>(req);
    await withIdempotency(ctx, req, 'adminSetSuspension', async (c) => {
      const r = await c.query('UPDATE app_users SET suspended_at = CASE WHEN $2 THEN now() ELSE NULL END, suspension_reason = $3, updated_at = now() WHERE id = $1 RETURNING id', [id, b.suspended, b.reason]);
      if (!r.rowCount) throw notFound();
      if (b.suspended) await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await recordEvent(c, { entityType: 'user', entityId: id, eventType: b.suspended ? 'suspended' : 'unsuspended', actor: { id: me.id, role: 'admin_operator' }, reason: b.reason });
      return { status: 200, body: null };
    });
    return adminUserDetail(ctx, id);
  },

  async adminDecideSkill(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'operate');
    const p = params(req);
    const b = body<{ decision: 'verified' | 'rejected'; reason: string; validUntil?: string }>(req);
    const res = await withIdempotency(ctx, req, 'adminDecideSkill', async (c) => {
      const s = (await c.query('SELECT * FROM worker_skills WHERE worker_id = $1 AND skill_code = $2 FOR UPDATE', [p.userId, p.skillCode])).rows[0];
      if (!s) throw notFound();
      if (s.status !== 'pending') throw conflict('invalid_state', '確認待ちではありません');
      await c.query(
        `UPDATE worker_skills SET status = $3, note = $4, valid_until = coalesce($5, valid_until), verified_at = CASE WHEN $3 = 'verified' THEN now() END, verified_by = $6
         WHERE worker_id = $1 AND skill_code = $2`,
        [p.userId, p.skillCode, b.decision, b.decision === 'rejected' ? b.reason : null, b.validUntil ?? null, me.id],
      );
      await notify(c, [p.userId!], { type: `skill_${b.decision}`, title: b.decision === 'verified' ? '資格が確認されました' : '資格が確認できませんでした', body: b.decision === 'verified' ? '確認済みの資格として登録されました' : b.reason, entityType: 'user', entityId: p.userId });
      await recordEvent(c, { entityType: 'user', entityId: p.userId!, eventType: `skill_${b.decision}`, actor: { id: me.id, role: 'admin_operator' }, reason: b.reason, payload: { skillCode: p.skillCode } });
      return { status: 200, body: (await loadSkills(c, p.userId!)).find((x) => x.code === p.skillCode) };
    });
    return res.body;
  },

  async adminListOrganizations(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const st = query<{ reviewStatus?: string }>(req).reviewStatus;
    const r = await ctx.db.query(`SELECT * FROM organizations ${st ? 'WHERE review_status = $1' : ''} ORDER BY created_at DESC LIMIT 300`, st ? [st] : []);
    return r.rows.map(orgView);
  },

  async adminGetOrganization(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const r = await ctx.db.query('SELECT * FROM organizations WHERE id = $1', [params(req).organizationId]);
    if (!r.rows[0]) throw notFound();
    return orgView(r.rows[0]);
  },

  async adminGetJob(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    return orgJobView(ctx, ctx.db, await loadOrgJob(ctx.db, null, params(req).jobId!));
  },

  async adminReviewOrganization(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'operate');
    const id = params(req).organizationId!;
    const b = body<{ decision: 'approved' | 'rejected' | 'suspended'; reason: string }>(req);
    const res = await withIdempotency(ctx, req, 'adminReviewOrganization', async (c) => {
      const r = await c.query('UPDATE organizations SET review_status = $2, review_note = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, b.decision, b.reason]);
      if (!r.rowCount) throw notFound();
      if (b.decision === 'suspended') {
        const jobs = await c.query(`SELECT j.*, o.legal_name AS org_name FROM jobs j JOIN organizations o ON o.id = j.org_id WHERE j.org_id = $1 AND j.status IN ('pending_review','published','filled') FOR UPDATE OF j`, [id]);
        for (const j of jobs.rows) await cancelJobCascade(c, j, { id: me.id, role: 'admin_operator' }, `発注組織の利用停止: ${b.reason}`);
      }
      await notifyOrg(c, id, { type: `organization_${b.decision}`, title: b.decision === 'approved' ? '企業審査が完了しました' : '企業審査の結果', body: b.decision === 'approved' ? '案件を公開申請できるようになりました' : b.reason, entityType: 'organization', entityId: id });
      await recordEvent(c, { entityType: 'organization', entityId: id, eventType: `review_${b.decision}`, actor: { id: me.id, role: 'admin_operator' }, reason: b.reason });
      return { status: 200, body: orgView(r.rows[0]) };
    });
    return res.body;
  },

  async adminListJobs(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const st = query<{ status?: string }>(req).status;
    const r = await ctx.db.query(`SELECT ${JOB_COLUMNS} FROM jobs j JOIN organizations o ON o.id = j.org_id ${st ? 'WHERE j.status = $1' : ''} ORDER BY j.created_at DESC LIMIT 200`, st ? [st] : []);
    const out = [];
    for (const j of r.rows) out.push(await orgJobView(ctx, ctx.db, j));
    return out;
  },

  async adminReviewJob(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'operate');
    const id = params(req).jobId!;
    const b = body<{ decision: 'published' | 'rejected' | 'cancelled'; reason: string }>(req);
    const res = await withIdempotency(ctx, req, 'adminReviewJob', async (c) => {
      const j = await loadOrgJob(c, null, id, true);
      const actor = { id: me.id, role: 'admin_operator' };
      if (b.decision === 'cancelled') {
        await cancelJobCascade(c, j, actor, b.reason);
      } else {
        if (j.status !== 'pending_review') throw conflict('invalid_state', '審査待ちの案件ではありません');
        if (b.decision === 'published') {
          const failed = (await publishChecks(ctx, c, j)).filter((x) => !x.ok);
          if (failed.length) throw badRequest('publish_checks_failed', `公開前チェックを満たしていません: ${failed.map((f) => f.message).join(' / ')}`);
          await c.query(`UPDATE jobs SET status = 'published', published_at = now(), terms_hash = $2, review_note = $3, updated_at = now() WHERE id = $1`, [id, termsHashOf(j, ctx.cfg.workerFeePercent), b.reason]);
        } else {
          await c.query(`UPDATE jobs SET status = 'rejected', review_note = $2, updated_at = now() WHERE id = $1`, [id, b.reason]);
        }
        await notifyOrg(c, j.org_id, { type: `job_${b.decision}`, title: b.decision === 'published' ? '案件が公開されました' : '案件が公開されませんでした', body: `「${j.title}」${b.decision === 'rejected' ? `: ${b.reason}` : ''}`, entityType: 'job', entityId: id });
        await recordEvent(c, { entityType: 'job', entityId: id, eventType: b.decision, actor, reason: b.reason });
      }
      return { status: 200, body: await orgJobView(ctx, c, await loadOrgJob(c, null, id)) };
    });
    return res.body;
  },

  async adminListAssignments(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'read');
    const st = query<{ state?: string }>(req).state;
    const r = await ctx.db.query(`SELECT id FROM assignments ${st ? 'WHERE state = $1' : ''} ORDER BY updated_at DESC LIMIT 200`, st ? [st] : []);
    const out = [];
    for (const row of r.rows) out.push(await loadAssignmentView(ctx, ctx.db, row.id, me));
    return out;
  },

  async adminResolveDispute(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'operate');
    const id = params(req).assignmentId!;
    const b = body<{ resolution: 'pay_worker' | 'partial' | 'no_pay'; amountYen?: number; reason: string }>(req);
    const res = await withIdempotency(ctx, req, 'adminResolveDispute', async (c) => {
      const a = await loadAssignmentRowForAdmin(c, id);
      if (!a) throw notFound();
      if (a.state !== 'disputed') throw conflict('invalid_state', '紛争中の業務ではありません');
      const actor = { id: me.id, role: 'admin_operator' };
      const note = `紛争裁定: ${b.reason}`;
      if (b.resolution === 'no_pay') {
        await c.query(`UPDATE assignments SET state = 'refunded', review_reason = $2, completed_at = now(), updated_at = now() WHERE id = $1`, [id, note]);
      } else {
        const amount = b.resolution === 'pay_worker' ? Number(a.accepted_amount_yen) : b.amountYen;
        if (!amount || amount > Number(a.accepted_amount_yen)) throw badRequest('invalid_amount', '金額は受諾時の報酬以下で指定してください');
        await c.query('UPDATE assignments SET review_reason = $2 WHERE id = $1', [id, note]);
        await approveAndBook(c, a, amount, actor, note);
      }
      await notify(c, [a.worker_id], { type: 'dispute_resolved', title: '紛争の対応結果', body: `「${a.title}」: ${b.reason}`, entityType: 'assignment', entityId: id });
      await notifyOrg(c, a.org_id, { type: 'dispute_resolved', title: '紛争の対応結果', body: `「${a.title}」: ${b.reason}`, entityType: 'assignment', entityId: id });
      await recordEvent(c, { entityType: 'assignment', entityId: id, eventType: `dispute_${b.resolution}`, actor, reason: b.reason, payload: { amountYen: b.amountYen } });
      return { status: 200, body: await loadAssignmentView(ctx, c, id, me) };
    });
    return res.body;
  },

  async adminReverseEarning(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'operate');
    const id = params(req).assignmentId!;
    const b = body<{ amountYen: number; reason: string }>(req);
    const res = await withIdempotency(ctx, req, 'adminReverseEarning', async (c) => {
      const a = await loadAssignmentRowForAdmin(c, id);
      if (!a) throw notFound();
      const bal = (await c.query(
        `SELECT coalesce(sum(amount_yen) FILTER (WHERE entry_type <> 'paid'),0)::int AS net, coalesce(sum(amount_yen) FILTER (WHERE entry_type = 'paid'),0)::int AS paid
         FROM ledger_entries WHERE assignment_id = $1`,
        [id],
      )).rows[0];
      if (bal.net <= 0) throw conflict('nothing_to_reverse', '取り消せる報酬がありません');
      if (b.amountYen > bal.net) throw badRequest('invalid_amount', `取消額は確定額（¥${bal.net.toLocaleString('ja-JP')}）以下にしてください`);
      const live = await c.query(`SELECT 1 FROM payout_items pi JOIN payouts p ON p.id = pi.payout_id WHERE pi.assignment_id = $1 AND pi.released_at IS NULL AND p.status IN ('requested','processing')`, [id]);
      if (live.rowCount) throw conflict('payout_in_progress', '振込処理中のため取り消せません。振込完了後に返金として処理してください');
      const type = bal.paid > 0 ? 'refund' : 'reversal';
      await c.query(
        `INSERT INTO ledger_entries(assignment_id, worker_id, org_id, contract_type, entry_type, amount_yen, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, a.worker_id, a.org_id, a.contract_type, type, -b.amountYen, b.reason, me.id],
      );
      if (bal.net - b.amountYen <= 0) await c.query(`UPDATE assignments SET state = 'refunded', updated_at = now() WHERE id = $1`, [id]);
      await notify(c, [a.worker_id], { type: 'earning_reversed', title: '報酬が取り消されました', body: `「${a.title}」: ¥${b.amountYen.toLocaleString('ja-JP')}（${b.reason}）`, entityType: 'assignment', entityId: id });
      await recordEvent(c, { entityType: 'assignment', entityId: id, eventType: `earning_${type}`, actor: { id: me.id, role: 'admin_operator' }, reason: b.reason, payload: { amountYen: b.amountYen } });
      return { status: 200, body: await loadAssignmentView(ctx, c, id, me) };
    });
    return res.body;
  },

  async adminReassign(ctx, req, reply) {
    const me = requireUser(req);
    requireAdmin(me, 'support');
    const id = params(req).assignmentId!;
    const b = body<{ workerId: string; reason: string }>(req);
    const res = await withIdempotency(ctx, req, 'adminReassign', async (c) => {
      const a = await loadAssignmentRowForAdmin(c, id);
      if (!a) throw notFound();
      if (!['accepted', 'traveling', 'reserved'].includes(a.state)) throw conflict('invalid_state', '作業開始前の業務のみ再割当できます');
      if (b.workerId === a.worker_id) throw badRequest('same_worker', '同じ担当者には再割当できません');
      const job = await loadOrgJob(c, null, a.job_id, true);
      const w = await loadWorkerContext(c, b.workerId, ctx.cfg.termsVersion);
      const excl = exclusions(w, { ...toMatchJob(job), remaining: 1 }, undefined, undefined);
      if (excl.length) throw conflict('not_eligible', `指定の担当者は受諾条件を満たしません: ${excl.map((e) => EXCLUSION_LABEL[e]).join('、')}`);
      const actor = { id: me.id, role: 'admin' };
      await c.query(`UPDATE assignments SET state = 'cancelled', location_sharing_until = now(), updated_at = now() WHERE id = $1`, [id]);
      await recordEvent(c, { entityType: 'assignment', entityId: id, eventType: 'reassigned_away', actor, reason: b.reason, payload: { toWorkerId: b.workerId } });
      const n = await c.query(
        `INSERT INTO assignments(job_id, worker_id, state, accepted_amount_yen, terms_snapshot) VALUES ($1,$2,'accepted',$3,$4) RETURNING id`,
        [a.job_id, b.workerId, a.accepted_amount_yen, a.terms_snapshot],
      );
      await notify(c, [a.worker_id], { type: 'assignment_reassigned', title: '担当が変更されました', body: `「${a.title}」は運営の判断で別の担当者に変更されました`, entityType: 'assignment', entityId: id });
      await notify(c, [b.workerId], { type: 'assignment_assigned', title: '業務が割り当てられました', body: `「${a.title}」を担当することになりました。内容を確認してください`, entityType: 'assignment', entityId: n.rows[0].id });
      await notifyOrg(c, a.org_id, { type: 'assignment_reassigned', title: '担当者が変更されました', body: `「${a.title}」`, entityType: 'assignment', entityId: n.rows[0].id });
      await recordEvent(c, { entityType: 'assignment', entityId: n.rows[0].id, eventType: 'reassigned_to', actor, reason: b.reason, payload: { fromAssignmentId: id } });
      return { status: 201, body: await loadAssignmentView(ctx, c, n.rows[0].id, me) };
    });
    reply.code(res.status);
    return res.body;
  },

  async adminListReports(ctx, req) {
    requireAdmin(requireUser(req), 'support');
    const st = query<{ status?: string }>(req).status;
    const r = await ctx.db.query(`SELECT * FROM reports ${st ? 'WHERE status = $1' : ''} ORDER BY created_at DESC LIMIT 300`, st ? [st] : []);
    return r.rows.map(reportView);
  },

  async adminResolveReport(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'support');
    const b = body<{ action: string; reason: string }>(req);
    const res = await withIdempotency(ctx, req, 'adminResolveReport', async (c) => {
      const r = (await c.query('SELECT * FROM reports WHERE id = $1 FOR UPDATE', [params(req).reportId])).rows[0];
      if (!r) throw notFound();
      if (r.status === 'resolved') throw conflict('invalid_state', '対応済みです');
      const actor = { id: me.id, role: 'admin' };
      if (b.action === 'hide_content') {
        if (r.target_type !== 'message') throw badRequest('invalid_action', '非表示にできるのはメッセージのみです');
        await c.query('UPDATE messages SET hidden_at = now() WHERE id = $1', [r.target_id]);
      } else if (b.action === 'suspend_target') {
        requireAdmin(me, 'operate');
        if (r.target_type === 'user') await c.query('UPDATE app_users SET suspended_at = now(), suspension_reason = $2 WHERE id = $1', [r.target_id, b.reason]);
        else if (r.target_type === 'organization') await c.query(`UPDATE organizations SET review_status = 'suspended', review_note = $2 WHERE id = $1`, [r.target_id, b.reason]);
        else throw badRequest('invalid_action', 'この対象は利用停止にできません');
      } else if (b.action === 'cancel_job') {
        requireAdmin(me, 'operate');
        if (r.target_type !== 'job') throw badRequest('invalid_action', '案件の通報ではありません');
        await cancelJobCascade(c, await loadOrgJob(c, null, r.target_id, true), actor, b.reason);
      }
      const u = await c.query(`UPDATE reports SET status = 'resolved', resolution = $2, resolved_by = $3 WHERE id = $1 RETURNING *`, [r.id, `${b.action}: ${b.reason}`, me.id]);
      await notify(c, [r.reporter_id], { type: 'report_resolved', title: '通報への対応が完了しました', body: 'ご報告ありがとうございました', entityType: 'report', entityId: r.id });
      await recordEvent(c, { entityType: 'report', entityId: r.id, eventType: `resolved_${b.action}`, actor, reason: b.reason });
      return { status: 200, body: reportView(u.rows[0]) };
    });
    return res.body;
  },

  async adminListSupportTickets(ctx, req) {
    requireAdmin(requireUser(req), 'support');
    const st = query<{ status?: string }>(req).status;
    const r = await ctx.db.query(
      `SELECT t.*, u.display_name FROM support_tickets t JOIN app_users u ON u.id = t.user_id ${st ? 'WHERE t.status = $1' : ''} ORDER BY t.created_at DESC LIMIT 300`,
      st ? [st] : [],
    );
    return r.rows.map(ticketView);
  },

  async adminAnswerSupportTicket(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'support');
    const b = body<{ answer: string; close?: boolean }>(req);
    const res = await withIdempotency(ctx, req, 'adminAnswerSupportTicket', async (c) => {
      const t = await c.query(`UPDATE support_tickets SET answer = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *`, [params(req).ticketId, b.answer, b.close ? 'closed' : 'answered']);
      if (!t.rowCount) throw notFound();
      await notify(c, [t.rows[0].user_id], { type: 'support_answered', title: 'お問い合わせに回答しました', body: b.answer.slice(0, 80), entityType: 'support_ticket', entityId: t.rows[0].id });
      await recordEvent(c, { entityType: 'support_ticket', entityId: t.rows[0].id, eventType: 'answered', actor: { id: me.id, role: 'admin' } });
      return { status: 200, body: ticketView(t.rows[0]) };
    });
    return res.body;
  },

  async adminListAuditEvents(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const q = query<{ entityType?: string; entityId?: string; limit?: number }>(req);
    const vals: unknown[] = [];
    const where = ['true'];
    if (q.entityType) { vals.push(q.entityType); where.push(`entity_type = $${vals.length}`); }
    if (q.entityId) { vals.push(q.entityId); where.push(`entity_id = $${vals.length}`); }
    vals.push(q.limit ?? 200);
    const r = await ctx.db.query(`SELECT * FROM domain_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${vals.length}`, vals);
    return r.rows.map((e) => ({
      id: e.id, entityType: e.entity_type, entityId: e.entity_id, eventType: e.event_type, actorId: e.actor_id ?? undefined, actorRole: e.actor_role ?? undefined,
      reason: e.reason ?? undefined, payload: e.payload, hash: e.hash, createdAt: e.created_at,
    }));
  },

  async adminVerifyAuditChain(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    return verifyAuditChain(ctx);
  },

  async adminAnalytics(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const q = query<{ from: string; to: string }>(req);
    const from = jstStartOfDay(q.from);
    const to = new Date(jstStartOfDay(q.to).getTime() + 86_400_000);
    const r = await ctx.db.query(
      `SELECT
        (SELECT count(*)::int FROM app_users WHERE 'worker' = ANY(roles) AND created_at >= $1 AND created_at < $2) AS new_workers,
        (SELECT count(*)::int FROM app_users WHERE verification_status = 'verified' AND deleted_at IS NULL) AS verified_workers,
        (SELECT count(*)::int FROM jobs WHERE published_at >= $1 AND published_at < $2) AS published_jobs,
        (SELECT count(*)::int FROM assignments WHERE accepted_at >= $1 AND accepted_at < $2) AS accepted,
        (SELECT count(*)::int FROM assignments WHERE state IN ('approved','payable','paid') AND completed_at >= $1 AND completed_at < $2) AS approved,
        (SELECT count(*)::int FROM assignments WHERE state = 'cancelled' AND updated_at >= $1 AND updated_at < $2) AS cancelled,
        (SELECT count(*)::int FROM assignments WHERE state = 'no_show' AND updated_at >= $1 AND updated_at < $2) AS no_shows,
        (SELECT count(*)::int FROM domain_events WHERE event_type = 'review_disputed' AND created_at >= $1 AND created_at < $2) AS disputes,
        (SELECT coalesce(sum(amount_yen),0)::int FROM ledger_entries WHERE entry_type <> 'paid' AND created_at >= $1 AND created_at < $2) AS gross,
        (SELECT coalesce(sum(value),0)::int FROM metric_counters WHERE name = 'delivery_completed' AND day >= $3::date AND day <= $4::date) AS delivered,
        (SELECT coalesce(sum(value),0)::int FROM metric_counters WHERE name = 'delivery_failed' AND day >= $3::date AND day <= $4::date) AS failed,
        (SELECT coalesce(sum(value),0)::int FROM metric_counters WHERE name = 'accept_conflict' AND day >= $3::date AND day <= $4::date) AS conflicts`,
      [from, to, q.from, q.to],
    );
    const cat = await ctx.db.query(
      `SELECT j.category, count(DISTINCT j.id)::int AS jobs, count(a.id)::int AS assignments,
         coalesce((SELECT sum(l.amount_yen) FROM ledger_entries l JOIN assignments a2 ON a2.id = l.assignment_id JOIN jobs j2 ON j2.id = a2.job_id
                   WHERE j2.category = j.category AND l.entry_type <> 'paid' AND l.created_at >= $1 AND l.created_at < $2), 0)::int AS gross
       FROM jobs j LEFT JOIN assignments a ON a.job_id = j.id AND a.accepted_at >= $1 AND a.accepted_at < $2
       WHERE j.created_at < $2 GROUP BY j.category ORDER BY j.category`,
      [from, to],
    );
    const x = r.rows[0];
    return {
      from: q.from, to: q.to, newWorkers: x.new_workers, verifiedWorkers: x.verified_workers, publishedJobs: x.published_jobs,
      acceptedAssignments: x.accepted, approvedAssignments: x.approved, cancelledAssignments: x.cancelled, noShows: x.no_shows, disputes: x.disputes,
      grossYen: x.gross, deliveriesCompleted: x.delivered, deliveriesFailed: x.failed, acceptConflicts: x.conflicts,
      byCategory: cat.rows.map((c) => ({ category: c.category, jobs: c.jobs, assignments: c.assignments, grossYen: c.gross })),
    };
  },

  async adminGetMatchingConfig(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    return loadMatchingConfig(ctx.db);
  },

  async adminUpdateMatchingConfig(ctx, req) {
    const me = requireUser(req);
    requireAdmin(me, 'operate');
    const b = body<{ weights: Record<string, number>; maxDistanceKm: number; reason?: string }>(req);
    if (!b.reason?.trim()) throw badRequest('reason_required', '変更理由を入力してください');
    if (Object.values(b.weights).every((v) => v === 0)) throw badRequest('invalid_weights', 'すべての重みを0にはできません');
    await withIdempotency(ctx, req, 'adminUpdateMatchingConfig', async (c) => {
      const r = await c.query('INSERT INTO matching_config(weights, max_distance_km, reason, updated_by) VALUES ($1,$2,$3,$4) RETURNING id', [b.weights, b.maxDistanceKm, b.reason, me.id]);
      await recordEvent(c, { entityType: 'matching_config', entityId: me.id, eventType: 'matching_config_updated', actor: { id: me.id, role: 'admin_operator' }, reason: b.reason, payload: { configId: r.rows[0].id, weights: b.weights, maxDistanceKm: b.maxDistanceKm } });
      return { status: 200, body: null };
    });
    return loadMatchingConfig(ctx.db);
  },

  async adminMatchingAudit(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const q = query<{ from: string; to: string }>(req);
    const from = jstStartOfDay(q.from);
    const to = new Date(jstStartOfDay(q.to).getTime() + 86_400_000);
    const shown = await ctx.db.query(
      `SELECT worker_id, count(*)::int AS n FROM match_impressions WHERE excluded_reason IS NULL AND created_at >= $1 AND created_at < $2 GROUP BY worker_id ORDER BY n DESC`,
      [from, to],
    );
    const excl = await ctx.db.query(
      `SELECT excluded_reason AS reason, count(*)::int AS count FROM match_impressions WHERE excluded_reason IS NOT NULL AND created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC`,
      [from, to],
    );
    const accepted = await ctx.db.query(
      `SELECT count(DISTINCT (mi.worker_id, mi.job_id))::int AS pairs,
              count(DISTINCT (mi.worker_id, mi.job_id)) FILTER (WHERE EXISTS (SELECT 1 FROM assignments a WHERE a.worker_id = mi.worker_id AND a.job_id = mi.job_id))::int AS accepted
       FROM match_impressions mi WHERE mi.excluded_reason IS NULL AND mi.created_at >= $1 AND mi.created_at < $2`,
      [from, to],
    );
    const appeals = await ctx.db.query(`SELECT count(*)::int AS n FROM support_tickets WHERE category = 'matching_appeal' AND status = 'open'`);
    const counts = shown.rows.map((r) => r.n);
    const total = counts.reduce((s, n) => s + n, 0);
    const topN = Math.max(1, Math.ceil(counts.length * 0.1));
    const topShare = total ? counts.slice(0, topN).reduce((s, n) => s + n, 0) / total : 0;
    return {
      impressions: total,
      uniqueWorkersShown: counts.length,
      top10PercentShare: Math.round(topShare * 1000) / 1000,
      acceptRate: accepted.rows[0].pairs ? Math.round((accepted.rows[0].accepted / accepted.rows[0].pairs) * 1000) / 1000 : 0,
      exclusionReasons: excl.rows.map((e) => ({ reason: EXCLUSION_LABEL[e.reason as keyof typeof EXCLUSION_LABEL] ?? e.reason, count: e.count })),
      openAppeals: appeals.rows[0].n,
    };
  },

  async adminListDeletionRequests(ctx, req) {
    requireAdmin(requireUser(req), 'read');
    const r = await ctx.db.query('SELECT * FROM deletion_requests ORDER BY requested_at DESC LIMIT 300');
    return r.rows.map((d) => ({ id: d.id, userId: d.user_id, status: d.status, requestedAt: d.requested_at, completedAt: d.completed_at ?? undefined, retentionNotice: RETENTION_NOTICE, blockers: [] }));
  },
};

/** Recomputes the hash chain in chain order; any edited/deleted/reordered event breaks it. */
export async function verifyAuditChain(ctx: AppContext) {
  const r = await ctx.db.query(
    `WITH chain AS (
       SELECT d.id, d.chain_seq, d.prev_hash, d.hash, lag(d.hash) OVER (ORDER BY d.chain_seq) AS expected_prev,
              lag(d.chain_seq) OVER (ORDER BY d.chain_seq) AS prev_seq, d AS rec
       FROM domain_events d)
     SELECT count(*)::int AS checked,
            min(id) FILTER (WHERE prev_hash IS DISTINCT FROM expected_prev
                               OR hash <> domain_event_hash(expected_prev, chain_seq, rec)
                               OR chain_seq <> coalesce(prev_seq, 0) + 1) AS first_invalid
     FROM chain`,
  );
  const row = r.rows[0];
  return { valid: row.first_invalid === null, checked: row.checked, firstInvalidId: row.first_invalid ?? undefined };
}
