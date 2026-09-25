import type { Client } from '../db/pool.js';

export interface Actor {
  id: string | null;
  role: string;
}

export interface EventInput {
  entityType: string;
  entityId: string;
  eventType: string;
  actor: Actor;
  reason?: string | null;
  payload?: Record<string, unknown>;
  /** Optional outbox message delivered asynchronously by the worker (e.g. 'push'). */
  outbox?: { topic: string; payload: Record<string, unknown> };
}

/**
 * Append an immutable, hash-chained domain event (and outbox rows) in the caller's transaction.
 * The chain trigger takes a global advisory lock until commit, so call this as late as possible in the transaction.
 */
export async function recordEvent(c: Client, e: EventInput): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO domain_events(entity_type, entity_id, event_type, actor_id, actor_role, reason, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [e.entityType, e.entityId, e.eventType, e.actor.id, e.actor.role, e.reason ?? null, e.payload ?? {}],
  );
  const id = r.rows[0]!.id;
  if (e.outbox) {
    await c.query('INSERT INTO outbox(event_id, topic, payload) VALUES ($1,$2,$3)', [id, e.outbox.topic, e.outbox.payload]);
  }
  return id;
}

export async function bumpMetric(c: Client, name: string, by = 1): Promise<void> {
  await c.query(
    `INSERT INTO metric_counters(name, day, value) VALUES ($1, (now() AT TIME ZONE 'Asia/Tokyo')::date, $2)
     ON CONFLICT (name, day) DO UPDATE SET value = metric_counters.value + EXCLUDED.value`,
    [name, by],
  );
}
