import type { Client } from '../db/pool.js';

export interface NotificationInput {
  type: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
}

/**
 * In-app notification (always stored, so state is visible even if push fails) plus an outbox row
 * for asynchronous APNs delivery. Bodies must not contain phone numbers, addresses or health information.
 */
export async function notify(c: Client, userIds: string[], n: NotificationInput): Promise<void> {
  for (const uid of new Set(userIds)) {
    const r = await c.query<{ id: string }>(
      `INSERT INTO notifications(user_id, type, title, body, entity_type, entity_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [uid, n.type, n.title, n.body, n.entityType ?? null, n.entityId ?? null],
    );
    await c.query(`INSERT INTO outbox(topic, payload) VALUES ('push', $1)`, [
      { notificationId: r.rows[0]!.id, userId: uid, title: n.title, body: n.body, entityType: n.entityType, entityId: n.entityId, type: n.type },
    ]);
  }
}

export async function notifyOrg(c: Client, orgId: string, n: NotificationInput): Promise<void> {
  const r = await c.query<{ user_id: string }>('SELECT user_id FROM organization_members WHERE org_id = $1', [orgId]);
  await notify(c, r.rows.map((x) => x.user_id), n);
}

export async function notifyAdmins(c: Client, n: NotificationInput): Promise<void> {
  const r = await c.query<{ id: string }>(
    `SELECT id FROM app_users WHERE deleted_at IS NULL AND roles && ARRAY['admin_operator','admin_support']::text[]`,
  );
  await notify(c, r.rows.map((x) => x.id), n);
}
