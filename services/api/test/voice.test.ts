// Realtime voice credential endpoint: auth, provider request shape, secret handling, rate limits, failure mapping.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, loginWorker, setupApp, testConfig, webUser, type TestEnv } from './helpers.js';
import { closeStaleVoiceSessions } from '../src/jobs/maintenance.js';

const PERMANENT_KEY = 'sk-test-permanent-key-must-never-leak-0123456789';

interface Captured { url: string; headers: IncomingMessage['headers']; body: any }
let fake: Server;
let fakeUrl: string;
let captured: Captured[] = [];
let mode: 'ok' | 'error500' | 'error400' | 'slow' | 'garbage' = 'ok';

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      captured.push({ url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      if (mode === 'slow') return; // never answers → client timeout
      if (mode === 'error500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `internal detail with key ${PERMANENT_KEY}` } }));
      }
      if (mode === 'error400') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Unknown parameter: session.foo', type: 'invalid_request_error' } }));
      }
      if (mode === 'garbage') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"nope":true}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: 'ek_test_ephemeral_secret_abc', expires_at: Math.floor(Date.now() / 1000) + 120, session: { type: 'realtime' } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { fake.closeAllConnections(); await new Promise((r) => fake.close(r)); });
beforeEach(() => { captured = []; mode = 'ok'; });

async function envWith(voice: Partial<ReturnType<typeof testConfig>['voice']> = {}): Promise<TestEnv> {
  const base = testConfig().voice;
  return setupApp({ voice: { ...base, openaiApiKey: PERMANENT_KEY, openaiBaseUrl: fakeUrl, providerTimeoutMs: 1500, ...voice } });
}

describe('POST /voice/realtime-session', () => {
  it('issues an ephemeral secret using the server key and full session config; never returns the permanent key', async () => {
    const env = await envWith();
    try {
      const w = await loginWorker(env);
      const r = await call(env, w, 'POST', '/voice/realtime-session', {});
      expect(r.status).toBe(201);
      expect(r.body.clientSecret).toBe('ek_test_ephemeral_secret_abc');
      expect(r.body).toMatchObject({ model: 'gpt-realtime-2.1', voice: 'marin', callUrl: `${fakeUrl}/realtime/calls`, maxDurationSeconds: 900, idleTimeoutSeconds: 120 });
      expect(r.body.tools).toEqual(expect.arrayContaining(['get_today_overview', 'search_jobs', 'get_earnings_summary']));
      expect(JSON.stringify(r.body)).not.toContain(PERMANENT_KEY);
      expect(JSON.stringify(r.headers)).not.toContain(PERMANENT_KEY);

      const req = captured[0]!;
      expect(req.url).toBe('/v1/realtime/client_secrets');
      expect(req.headers.authorization).toBe(`Bearer ${PERMANENT_KEY}`);
      expect(req.headers['openai-safety-identifier']).toMatch(/^[a-f0-9]{32}$/);
      expect(req.headers['openai-safety-identifier']).not.toContain(w.userId);
      expect(req.headers['openai-beta']).toBeUndefined(); // GA flow, no beta header
      const s = req.body.session;
      expect(req.body.expires_after).toEqual({ anchor: 'created_at', seconds: 120 });
      expect(s.type).toBe('realtime');
      expect(s.model).toBe('gpt-realtime-2.1');
      expect(s.audio.output.voice).toBe('marin');
      expect(s.audio.input.transcription.language).toBe('ja');
      expect(s.audio.input.turn_detection).toEqual({ type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true });
      expect(s.instructions).toMatch(/自然な日本語/);
      expect(s.instructions).toMatch(/割り込み/);
      expect(s.tools.map((t: any) => t.name)).toEqual(r.body.tools);
      for (const t of s.tools) expect(t.parameters.additionalProperties).toBe(false);

      const row = await env.ctx.db.query('SELECT status, user_id FROM voice_sessions WHERE id = $1', [r.body.sessionId]);
      expect(row.rows[0]).toEqual({ status: 'issued', user_id: w.userId });
    } finally {
      await env.close();
    }
  });

  it('requires an authenticated worker', async () => {
    const env = await envWith();
    try {
      expect((await call(env, null, 'POST', '/voice/realtime-session', {})).status).toBe(401);
      const web = await webUser(env);
      expect((await call(env, web, 'POST', '/voice/realtime-session', {})).status).toBe(403);
      expect(captured).toHaveLength(0);
    } finally {
      await env.close();
    }
  });

  it('rejects unexpected fields, foreign origins and ignores client-supplied identity', async () => {
    const env = await envWith();
    try {
      const w = await loginWorker(env);
      expect((await call(env, w, 'POST', '/voice/realtime-session', { userId: 'someone-else' })).status).toBe(422);
      expect((await call(env, w, 'POST', '/voice/realtime-session', { previousSessionId: 'not-a-uuid' })).status).toBe(422);
      expect((await call(env, w, 'POST', '/voice/realtime-session', {}, { origin: 'https://evil.example' })).status).toBe(403);
      expect(captured).toHaveLength(0);
    } finally {
      await env.close();
    }
  });

  it('returns a sanitized 503 when the key is not configured or the provider fails', async () => {
    const noKey = await setupApp();
    try {
      const w = await loginWorker(noKey);
      const r = await call(noKey, w, 'POST', '/voice/realtime-session', {});
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('voice_unavailable');
    } finally {
      await noKey.close();
    }
    const env = await envWith();
    try {
      const w = await loginWorker(env);
      for (const m of ['error500', 'error400', 'garbage', 'slow'] as const) {
        mode = m;
        const r = await call(env, w, 'POST', '/voice/realtime-session', {});
        expect(r.status, m).toBe(503);
        expect(r.body.code).toBe('voice_unavailable');
        expect(r.body.message).toMatch(/音声アシスタント/);
        expect(JSON.stringify(r.body)).not.toMatch(/internal detail|Unknown parameter|sk-test/);
      }
      const failed = await env.ctx.db.query(`SELECT failure_code FROM voice_sessions WHERE user_id = $1 ORDER BY created_at`, [w.userId]);
      expect(failed.rows.map((x) => x.failure_code)).toEqual(['provider_unavailable', 'provider_rejected', 'bad_response', 'timeout']);
    } finally {
      await env.close();
    }
  });

  it('limits concurrent sessions and hourly credential minting per user; reconnect replaces the previous session', async () => {
    const env = await envWith({ sessionsPerHour: 4, maxConcurrentSessions: 2 });
    try {
      const w = await loginWorker(env);
      const a = await call(env, w, 'POST', '/voice/realtime-session', {});
      const b = await call(env, w, 'POST', '/voice/realtime-session', {});
      expect([a.status, b.status]).toEqual([201, 201]);
      const c = await call(env, w, 'POST', '/voice/realtime-session', {});
      expect(c.status).toBe(429);
      // Reconnect closes the previous session so it doesn't count as concurrent.
      const re = await call(env, w, 'POST', '/voice/realtime-session', { previousSessionId: a.body.sessionId });
      expect(re.status).toBe(201);
      const prev = await env.ctx.db.query('SELECT end_reason FROM voice_sessions WHERE id = $1', [a.body.sessionId]);
      expect(prev.rows[0].end_reason).toBe('reconnect');
      await call(env, w, 'POST', `/voice/sessions/${b.body.sessionId}/end`, { endReason: 'user_ended', durationSeconds: 5 });
      await call(env, w, 'POST', `/voice/sessions/${re.body.sessionId}/end`, { endReason: 'user_ended', durationSeconds: 5 });
      // Rejected attempts are not recorded; the 4th minted session is allowed, the 5th exceeds the hourly limit.
      const fourth = await call(env, w, 'POST', '/voice/realtime-session', {});
      expect(fourth.status).toBe(201);
      await call(env, w, 'POST', `/voice/sessions/${fourth.body.sessionId}/end`, { endReason: 'user_ended', durationSeconds: 5 });
      const hourly = await call(env, w, 'POST', '/voice/realtime-session', {});
      expect(hourly.status).toBe(429);
      expect(hourly.body.message).toMatch(/上限/);
      // Limits are per authenticated user, not global.
      const other = await loginWorker(env);
      expect((await call(env, other, 'POST', '/voice/realtime-session', {})).status).toBe(201);
    } finally {
      await env.close();
    }
  });
});

describe('POST /voice/sessions/{id}/end', () => {
  it('stores metrics once, only for the owner', async () => {
    const env = await envWith();
    try {
      const w = await loginWorker(env);
      const s = await call(env, w, 'POST', '/voice/realtime-session', {});
      const other = await loginWorker(env);
      expect((await call(env, other, 'POST', `/voice/sessions/${s.body.sessionId}/end`, { endReason: 'user_ended', durationSeconds: 1 })).status).toBe(404);
      const metrics = { endReason: 'user_ended', durationSeconds: 42, connectMs: 800, reconnectCount: 1, userTurns: 3, firstAudioLatencyMsP50: 650, interruptionStopMsP50: 120, toolCalls: 2, toolFailures: 0, toolLatencyMsP50: 300, errorCount: 0 };
      expect((await call(env, w, 'POST', `/voice/sessions/${s.body.sessionId}/end`, metrics)).status).toBe(204);
      expect((await call(env, w, 'POST', `/voice/sessions/${s.body.sessionId}/end`, { endReason: 'error', durationSeconds: 99 })).status).toBe(204);
      const row = await env.ctx.db.query('SELECT status, end_reason, metrics FROM voice_sessions WHERE id = $1', [s.body.sessionId]);
      expect(row.rows[0]).toMatchObject({ status: 'ended', end_reason: 'user_ended' });
      expect(row.rows[0].metrics.durationSeconds).toBe(42);
      const ev = await env.ctx.db.query(`SELECT count(*)::int AS n FROM domain_events WHERE entity_id = $1 AND event_type = 'voice_session_end'`, [s.body.sessionId]);
      expect(ev.rows[0].n).toBe(1);
      expect((await call(env, w, 'POST', `/voice/sessions/${s.body.sessionId}/end`, { endReason: 'user_ended', durationSeconds: 1, transcript: 'x' })).status).toBe(422);
    } finally {
      await env.close();
    }
  });

  it('closes abandoned sessions so they stop counting as concurrent', async () => {
    const env = await envWith({ maxConcurrentSessions: 1 });
    try {
      const w = await loginWorker(env);
      const s = await call(env, w, 'POST', '/voice/realtime-session', {});
      expect((await call(env, w, 'POST', '/voice/realtime-session', {})).status).toBe(429);
      await env.ctx.db.query(`UPDATE voice_sessions SET created_at = now() - interval '2 hours' WHERE id = $1`, [s.body.sessionId]);
      expect(await closeStaleVoiceSessions(env.ctx)).toBeGreaterThanOrEqual(1);
      expect((await call(env, w, 'POST', '/voice/realtime-session', {})).status).toBe(201);
    } finally {
      await env.close();
    }
  });
});
