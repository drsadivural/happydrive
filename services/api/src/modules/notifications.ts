import type { HandlerMap } from '../context.js';
import { body, query, requireUser } from '../context.js';

export const notificationHandlers: HandlerMap = {
  async listNotifications(ctx, req) {
    const u = requireUser(req);
    const unread = query<{ unreadOnly?: boolean }>(req).unreadOnly;
    const r = await ctx.db.query(
      `SELECT * FROM notifications WHERE user_id = $1 ${unread ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`,
      [u.id],
    );
    return r.rows.map((n) => ({
      id: n.id, type: n.type, title: n.title, body: n.body, entityType: n.entity_type ?? undefined, entityId: n.entity_id ?? undefined,
      readAt: n.read_at ?? undefined, createdAt: n.created_at,
    }));
  },

  async markNotificationsRead(ctx, req, reply) {
    const u = requireUser(req);
    const b = body<{ ids?: string[]; all?: boolean }>(req);
    if (b.all) await ctx.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [u.id]);
    else if (b.ids?.length) await ctx.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [u.id, b.ids]);
    reply.code(204);
  },
};
