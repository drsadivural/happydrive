import type { HandlerMap } from '../context.js';
import { body, params, query, requireUser } from '../context.js';
import { withTx } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { recordEvent } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { notify, notifyAdmins, notifyOrg } from '../lib/notify.js';
import { isAdmin } from '../auth/rbac.js';

const CHAT_OPEN_STATES = ['reserved', 'accepted', 'traveling', 'checked_in', 'working', 'submitted', 'needs_revision', 'approved', 'payable', 'disputed'];

async function chatRole(db: any, userId: string, assignmentId: string, u: { roles: string[] }) {
  const r = await db.query(
    `SELECT a.worker_id, a.state, j.org_id, j.title,
       EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = j.org_id AND m.user_id = $2) AS is_org
     FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.id = $1`,
    [assignmentId, userId],
  );
  const a = r.rows[0];
  if (!a) throw notFound();
  if (a.worker_id === userId) return { role: 'worker' as const, a };
  if (a.is_org) return { role: 'organization' as const, a };
  if (isAdmin(u as any)) return { role: 'operator' as const, a };
  throw notFound();
}

export const messagingHandlers: HandlerMap = {
  async listMessages(ctx, req) {
    const u = requireUser(req);
    const id = params(req).assignmentId!;
    const { role } = await chatRole(ctx.db, u.id, id, u);
    const after = query<{ after?: string }>(req).after;
    const r = await ctx.db.query(
      `SELECT m.*, s.display_name FROM messages m LEFT JOIN app_users s ON s.id = m.sender_id
       WHERE m.assignment_id = $1 ${after ? 'AND m.created_at > $2' : ''} ORDER BY m.created_at LIMIT 500`,
      after ? [id, after] : [id],
    );
    return r.rows.map((m) => ({
      id: m.id, assignmentId: m.assignment_id, senderRole: m.sender_role,
      senderName: m.sender_role === 'worker' && role === 'organization' ? m.display_name : m.sender_role === 'organization' ? '発注者' : m.sender_role === 'operator' ? 'HappyDrive運営' : m.display_name,
      isMine: m.sender_id === u.id, body: m.hidden_at && role !== 'operator' ? '（このメッセージは運営により非表示になりました）' : m.body,
      evidenceId: m.hidden_at ? undefined : (m.evidence_id ?? undefined), hidden: !!m.hidden_at, createdAt: m.created_at,
    }));
  },

  async sendMessage(ctx, req, reply) {
    const u = requireUser(req);
    const id = params(req).assignmentId!;
    const b = body<{ body: string; evidenceId?: string }>(req);
    const res = await withIdempotency(ctx, req, 'sendMessage', async (c) => {
      const { role, a } = await chatRole(c, u.id, id, u);
      if (!CHAT_OPEN_STATES.includes(a.state)) throw forbidden('この業務のメッセージは終了しました');
      if (role === 'operator' && !u.roles.some((r) => r === 'admin_operator' || r === 'admin_support')) throw forbidden();
      if (b.evidenceId) {
        const e = await c.query(`SELECT 1 FROM evidence WHERE id = $1 AND assignment_id = $2 AND uploaded_by = $3 AND status = 'verified'`, [b.evidenceId, id, u.id]);
        if (!e.rowCount) throw badRequest('evidence_invalid', '添付画像が見つかりません');
      }
      const m = await c.query(
        `INSERT INTO messages(assignment_id, sender_id, sender_role, body, evidence_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, u.id, role, b.body.trim(), b.evidenceId ?? null],
      );
      const n = { type: 'message', title: '新しいメッセージ', body: `「${a.title}」にメッセージが届きました`, entityType: 'assignment', entityId: id };
      if (role !== 'worker') await notify(c, [a.worker_id], n);
      if (role !== 'organization') await notifyOrg(c, a.org_id, n);
      const row = m.rows[0];
      return { status: 201, body: { id: row.id, assignmentId: id, senderRole: role, senderName: u.displayName, isMine: true, body: row.body, evidenceId: row.evidence_id ?? undefined, hidden: false, createdAt: row.created_at } };
    });
    reply.code(res.status);
    return res.body;
  },

  async createReport(ctx, req, reply) {
    const u = requireUser(req);
    const b = body<{ targetType: string; targetId: string; reason: string; detail?: string }>(req);
    const res = await withIdempotency(ctx, req, 'createReport', async (c) => {
      if (b.targetType === 'message') {
        const m = await c.query('SELECT assignment_id FROM messages WHERE id = $1', [b.targetId]);
        if (!m.rows[0]) throw notFound();
        await chatRole(c, u.id, m.rows[0].assignment_id, u);
      }
      const r = await c.query(
        `INSERT INTO reports(reporter_id, target_type, target_id, reason, detail) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [u.id, b.targetType, b.targetId, b.reason, b.detail ?? null],
      );
      await notifyAdmins(c, { type: 'admin_report', title: '通報を受け付けました', body: `対象: ${b.targetType} / 理由: ${b.reason}`, entityType: 'report', entityId: r.rows[0].id });
      await recordEvent(c, { entityType: 'report', entityId: r.rows[0].id, eventType: 'reported', actor: { id: u.id, role: 'user' }, payload: { targetType: b.targetType } });
      return { status: 201, body: reportView(r.rows[0]) };
    });
    reply.code(res.status);
    return res.body;
  },

  async blockOrganization(ctx, req, reply) {
    const u = requireUser(req);
    const orgId = body<{ organizationId: string }>(req).organizationId;
    await withTx(ctx.db, async (c) => {
      const o = await c.query('SELECT 1 FROM organizations WHERE id = $1', [orgId]);
      if (!o.rowCount) throw notFound();
      await c.query('INSERT INTO org_blocks(worker_id, org_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, orgId]);
    });
    reply.code(204);
  },
};

export function reportView(r: any) {
  return { id: r.id, reporterId: r.reporter_id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, detail: r.detail ?? undefined, status: r.status, resolution: r.resolution ?? undefined, createdAt: r.created_at };
}
