// Periodic, idempotent maintenance run by the worker process. Each task is safe to run concurrently
// on several workers (row locks with SKIP LOCKED or set-based updates).
import type { AppContext } from '../context.js';
import { withTx } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { notify, notifyOrg } from '../lib/notify.js';
import { releaseSlot } from '../modules/assignments.js';
import { confirmTransfer, submitPayout } from '../modules/payouts.js';
import type { ApnsClient } from '../adapters/apns.js';

/** Reserved slots not approved in time are released (and the waitlist notified). */
export async function expireReservations(ctx: AppContext): Promise<number> {
  return withTx(ctx.db, async (c) => {
    const r = await c.query(
      `SELECT a.id, a.job_id, a.worker_id, j.title, j.org_id FROM assignments a JOIN jobs j ON j.id = a.job_id
       WHERE a.state = 'reserved' AND a.reservation_expires_at < now() FOR UPDATE OF a SKIP LOCKED LIMIT 200`,
    );
    for (const a of r.rows) {
      await c.query(`UPDATE assignments SET state = 'expired', updated_at = now() WHERE id = $1`, [a.id]);
      await releaseSlot(c, a.job_id);
      await notify(c, [a.worker_id], { type: 'reservation_expired', title: '応募の承認期限が切れました', body: `「${a.title}」は発注者の承認が得られなかったため取り消されました`, entityType: 'assignment', entityId: a.id });
      await notifyOrg(c, a.org_id, { type: 'reservation_expired', title: '承認期限切れ', body: `「${a.title}」の応募が期限切れになりました`, entityType: 'assignment', entityId: a.id });
      await recordEvent(c, { entityType: 'assignment', entityId: a.id, eventType: 'reservation_expired', actor: { id: null, role: 'system' } });
    }
    return r.rowCount ?? 0;
  });
}

/** Voice sessions whose app never reported an end (crash, kill) are closed so they stop counting as concurrent. */
export async function closeStaleVoiceSessions(ctx: AppContext): Promise<number> {
  const r = await ctx.db.query(
    `UPDATE voice_sessions SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE 'ended' END, ended_at = now(), end_reason = 'expired'
     WHERE ended_at IS NULL AND created_at < now() - make_interval(secs => $1)`,
    [ctx.cfg.voice.maxSessionSeconds + 300],
  );
  return r.rowCount ?? 0;
}

/** Published jobs past their start stop recruiting; finished jobs with no live work are completed. */
export async function closeJobs(ctx: AppContext): Promise<{ expired: number; completed: number }> {
  return withTx(ctx.db, async (c) => {
    const exp = await c.query(`UPDATE jobs SET status = 'expired', updated_at = now() WHERE status IN ('published','pending_review') AND starts_at < now() AND reserved_count = 0 RETURNING id`);
    const done = await c.query(
      `UPDATE jobs j SET status = 'completed', updated_at = now()
       WHERE j.status IN ('published','filled') AND j.ends_at < now() - interval '1 hour'
         AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.job_id = j.id AND a.state IN ('reserved','accepted','traveling','checked_in','working'))
       RETURNING id`,
    );
    for (const row of [...exp.rows, ...done.rows]) {
      await recordEvent(c, { entityType: 'job', entityId: row.id, eventType: exp.rows.includes(row) ? 'expired' : 'completed', actor: { id: null, role: 'system' } });
    }
    return { expired: exp.rowCount ?? 0, completed: done.rowCount ?? 0 };
  });
}

/** Retention: location samples, recipient contacts, expired evidence objects, OTP/attempt logs, deletion tombstones. */
export async function applyRetention(ctx: AppContext): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  out.locationSamples = (await ctx.db.query(`DELETE FROM location_samples WHERE recorded_at < now() - make_interval(days => $1)`, [ctx.cfg.locationRetentionDays])).rowCount ?? 0;
  out.recipientContacts = (await ctx.db.query(
    `UPDATE delivery_stops SET recipient_phone_ciphertext = NULL, recipient_name_ciphertext = NULL WHERE contact_purge_after < now() AND (recipient_phone_ciphertext IS NOT NULL OR recipient_name_ciphertext IS NOT NULL)`,
  )).rowCount ?? 0;
  const ev = await ctx.db.query(`SELECT id, object_key FROM evidence WHERE expires_at < now() AND deleted_at IS NULL LIMIT 500`);
  for (const e of ev.rows) {
    await ctx.storage.delete(e.object_key);
    await ctx.db.query('UPDATE evidence SET deleted_at = now() WHERE id = $1', [e.id]);
  }
  out.evidence = ev.rowCount ?? 0;
  const stale = await ctx.db.query(`SELECT id, object_key FROM evidence WHERE status = 'pending_upload' AND created_at < now() - interval '1 day' AND deleted_at IS NULL LIMIT 500`);
  for (const e of stale.rows) {
    await ctx.storage.delete(e.object_key);
    await ctx.db.query('UPDATE evidence SET deleted_at = now() WHERE id = $1', [e.id]);
  }
  out.staleUploads = stale.rowCount ?? 0;
  out.otp = (await ctx.db.query(`DELETE FROM otp_challenges WHERE created_at < now() - interval '1 day'`)).rowCount ?? 0;
  out.authAttempts = (await ctx.db.query(`DELETE FROM auth_attempts WHERE created_at < now() - interval '1 day'`)).rowCount ?? 0;
  out.tombstones = (await ctx.db.query(`DELETE FROM deleted_identities WHERE deleted_at < now() - interval '30 days'`)).rowCount ?? 0;
  out.idempotency = (await ctx.db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`)).rowCount ?? 0;
  out.impressions = (await ctx.db.query(`DELETE FROM match_impressions WHERE created_at < now() - interval '180 days'`)).rowCount ?? 0;
  return out;
}

/** Payouts left 'requested' (crash between commit and provider call) are submitted; 'processing' ones are re-checked with the provider. */
export async function reconcilePayouts(ctx: AppContext): Promise<void> {
  if (!ctx.payouts.enabled) return;
  const req = await ctx.db.query(`SELECT id FROM payouts WHERE status = 'requested' AND updated_at < now() - interval '2 minutes' LIMIT 100`);
  for (const p of req.rows) await submitPayout(ctx, p.id);
  const proc = await ctx.db.query(`SELECT provider_reference FROM payouts WHERE status = 'processing' AND provider_reference IS NOT NULL AND updated_at < now() - interval '10 minutes' LIMIT 100`);
  for (const p of proc.rows) await confirmTransfer(ctx, p.provider_reference);
}

/** Delivers queued push notifications with retry/backoff. Invalid device tokens are removed. */
export async function deliverOutbox(ctx: AppContext, apns: ApnsClient): Promise<number> {
  const c = await ctx.db.connect();
  let n = 0;
  try {
    await c.query('BEGIN');
    const rows = await c.query(
      `SELECT id, topic, payload, attempts FROM outbox WHERE delivered_at IS NULL AND next_attempt_at <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100`,
    );
    for (const row of rows.rows) {
      try {
        if (row.topic === 'push') {
          const prefs = await c.query('SELECT preferences FROM app_users WHERE id = $1 AND deleted_at IS NULL', [row.payload.userId]);
          const p = prefs.rows[0]?.preferences ?? {};
          const muted = (row.payload.type === 'message' && p.notifyMessages === false) || (row.payload.type === 'waitlist_opening' && p.notifyNewJobs === false);
          if (prefs.rows[0] && !muted && apns.enabled) {
            const devices = await c.query('SELECT apns_token, environment FROM devices WHERE user_id = $1', [row.payload.userId]);
            let retry = false;
            for (const d of devices.rows) {
              const r = await apns.send(d.apns_token, d.environment, {
                title: row.payload.title, body: row.payload.body,
                data: { entityType: row.payload.entityType ?? '', entityId: row.payload.entityId ?? '', notificationId: row.payload.notificationId },
              });
              if (r === 'invalid_token') await c.query('DELETE FROM devices WHERE apns_token = $1', [d.apns_token]);
              if (r === 'retry') retry = true;
            }
            if (retry && row.attempts < 5) throw new Error('apns retry');
          }
        }
        await c.query('UPDATE outbox SET delivered_at = now(), attempts = attempts + 1 WHERE id = $1', [row.id]);
        n++;
      } catch (e) {
        const backoffSec = Math.min(3600, 30 * 2 ** row.attempts);
        await c.query(
          `UPDATE outbox SET attempts = attempts + 1, last_error = $2, next_attempt_at = now() + make_interval(secs => $3),
             delivered_at = CASE WHEN attempts + 1 >= 8 THEN now() ELSE NULL END WHERE id = $1`,
          [row.id, (e as Error).message.slice(0, 200), backoffSec],
        );
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return n;
}
