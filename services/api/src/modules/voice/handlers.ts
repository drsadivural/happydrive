import type { HandlerMap } from '../../context.js';
import { body, params, requireUser } from '../../context.js';
import { withTx } from '../../db/pool.js';
import { AppError, forbidden, notFound, tooMany, unavailable } from '../../lib/errors.js';
import { bumpMetric, recordEvent } from '../../lib/events.js';
import { requireWorker } from '../../auth/rbac.js';
import { createClientSecret, safetyIdentifier, VoiceProviderError } from './provider.js';
import { VOICE_TOOL_NAMES } from './tools.js';

const UNAVAILABLE_MESSAGE = '音声アシスタントは現在ご利用いただけません。しばらくしてから再度お試しください';

export const voiceHandlers: HandlerMap = {
  async createVoiceSession(ctx, req, reply) {
    const u = requireUser(req);
    requireWorker(u);
    if (u.suspended) throw forbidden('アカウントが利用停止中のため音声アシスタントを利用できません', 'suspended');
    // Browsers are not a supported client for this endpoint; a present Origin must be one of ours.
    const origin = req.headers.origin;
    if (origin && !ctx.cfg.corsOrigins.includes(origin)) throw forbidden('このリクエスト元からは利用できません', 'origin_not_allowed');
    const raw = (req.body ?? {}) as { previousSessionId?: unknown };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(422, 'validation', '入力内容に誤りがあります');
    const extra = Object.keys(raw).filter((k) => k !== 'previousSessionId');
    const prev = raw.previousSessionId;
    if (extra.length || (prev !== undefined && (typeof prev !== 'string' || !/^[0-9a-f-]{36}$/i.test(prev)))) {
      throw new AppError(422, 'validation', '入力内容に誤りがあります');
    }
    const vc = ctx.cfg.voice;
    if (!vc.openaiApiKey) throw unavailable('voice_unavailable', UNAVAILABLE_MESSAGE);

    // Reserve the session (counts toward limits even if the provider call fails, to stop credential-minting loops).
    const sessionId = await withTx(ctx.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`voice:${u.id}`]);
      if (prev) {
        await c.query(
          `UPDATE voice_sessions SET status = 'ended', ended_at = now(), end_reason = coalesce(end_reason, 'reconnect')
           WHERE id = $1 AND user_id = $2 AND ended_at IS NULL`,
          [prev, u.id],
        );
      }
      const lim = await c.query(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
                count(*) FILTER (WHERE ended_at IS NULL AND status IN ('pending','issued')
                                   AND created_at > now() - make_interval(secs => $2))::int AS open
         FROM voice_sessions WHERE user_id = $1`,
        [u.id, vc.maxSessionSeconds],
      );
      if (lim.rows[0].hour >= vc.sessionsPerHour) throw tooMany('音声会話の開始回数が上限に達しました。しばらくしてから再度お試しください');
      if (lim.rows[0].open >= vc.maxConcurrentSessions) throw tooMany('ほかの画面や端末で音声会話が続いています。終了してから再度お試しください');
      const r = await c.query<{ id: string }>(
        `INSERT INTO voice_sessions(user_id, status, model, voice, previous_session_id) VALUES ($1,'pending',$2,$3,$4) RETURNING id`,
        [u.id, vc.realtimeModel, vc.realtimeVoice, prev ?? null],
      );
      return r.rows[0]!.id;
    });

    let secret;
    try {
      secret = await createClientSecret(vc, safetyIdentifier(ctx.cfg.dataHmacKey, u.id));
    } catch (e) {
      const code = e instanceof VoiceProviderError ? e.code : 'provider_unavailable';
      const status = e instanceof VoiceProviderError ? e.status : undefined;
      await ctx.db.query(`UPDATE voice_sessions SET status = 'failed', failure_code = $2, ended_at = now() WHERE id = $1`, [sessionId, code]);
      await bumpMetric(ctx.db, 'voice_session_failure');
      req.log.warn({ event: 'voice_session_failure', sessionId, code, providerStatus: status }, 'realtime client secret failed');
      throw unavailable('voice_unavailable', UNAVAILABLE_MESSAGE);
    }
    await withTx(ctx.db, async (c) => {
      await c.query(`UPDATE voice_sessions SET status = 'issued' WHERE id = $1`, [sessionId]);
      await recordEvent(c, { entityType: 'voice_session', entityId: sessionId, eventType: 'voice_session_start', actor: { id: u.id, role: 'worker' }, payload: { model: vc.realtimeModel, reconnect: !!prev } });
    });
    await bumpMetric(ctx.db, 'voice_session_start');
    req.log.info({ event: 'voice_session_start', sessionId, reconnect: !!prev }, 'voice session issued');
    reply.code(201);
    return {
      sessionId,
      clientSecret: secret.value,
      expiresAt: secret.expiresAt.toISOString(),
      model: vc.realtimeModel,
      voice: vc.realtimeVoice,
      callUrl: `${vc.openaiBaseUrl}/realtime/calls`,
      maxDurationSeconds: vc.maxSessionSeconds,
      idleTimeoutSeconds: vc.idleTimeoutSeconds,
      tools: VOICE_TOOL_NAMES,
    };
  },

  async endVoiceSession(ctx, req, reply) {
    const u = requireUser(req);
    const id = params(req).sessionId!;
    const m = body<{ endReason: string } & Record<string, unknown>>(req);
    await withTx(ctx.db, async (c) => {
      const s = (await c.query('SELECT id, metrics FROM voice_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, u.id])).rows[0];
      if (!s) throw notFound();
      if (s.metrics) return; // already reported (idempotent)
      // Metrics can arrive after a reconnect already closed the row; keep the first end reason, store metrics once.
      await c.query(
        `UPDATE voice_sessions SET status = 'ended', ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, $2), metrics = $3 WHERE id = $1`,
        [id, m.endReason, m],
      );
      {
        await recordEvent(c, {
          entityType: 'voice_session', entityId: id, eventType: 'voice_session_end', actor: { id: u.id, role: 'worker' },
          payload: { endReason: m.endReason, durationSeconds: m.durationSeconds, reconnectCount: m.reconnectCount, toolCalls: m.toolCalls, toolFailures: m.toolFailures, errorCount: m.errorCount },
        });
      }
    });
    if (m.endReason === 'error' || m.endReason === 'reconnect_exhausted') await bumpMetric(ctx.db, 'voice_session_error_end');
    req.log.info({ event: 'voice_session_end', sessionId: id, endReason: m.endReason, durationSeconds: m.durationSeconds }, 'voice session ended');
    reply.code(204);
  },
};
