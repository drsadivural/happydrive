import { describe, expect, it, vi } from 'vitest';
import { createApiRefresh, forwardWithRefresh, RefreshCoordinator, type RefreshOutcome } from '../src/bff/refresh';
import type { TokenSet } from '../src/bff/session';

const newTokens: TokenSet = {
  accessToken: 'at-2',
  refreshToken: 'rt-2',
  accessTokenExpiresAt: '2026-10-01T00:15:00Z',
  refreshTokenExpiresAt: '2026-10-31T00:00:00Z',
};

function res(status: number, body: unknown = { code: 'x', message: 'm' }): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('forwardWithRefresh', () => {
  it('成功時はリフレッシュしない', async () => {
    const send = vi.fn(async () => res(200, { ok: true }));
    const refresh = vi.fn();
    const r = await forwardWithRefresh({ accessToken: 'at-1', refreshToken: 'rt-1', send, refresh });
    expect(r.response.status).toBe(200);
    expect(r.tokens).toBeUndefined();
    expect(r.clearSession).toBe(false);
    expect(send).toHaveBeenCalledWith('at-1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('401 ならリフレッシュして新しいトークンで1回だけ再送する', async () => {
    const send = vi.fn(async (t: string) => (t === 'at-2' ? res(200) : res(401)));
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: true, tokens: newTokens }));
    const r = await forwardWithRefresh({ accessToken: 'at-1', refreshToken: 'rt-1', send, refresh });
    expect(r.response.status).toBe(200);
    expect(r.tokens).toEqual(newTokens);
    expect(r.clearSession).toBe(false);
    expect(refresh).toHaveBeenCalledWith('rt-1');
    expect(send.mock.calls.map((c) => c[0])).toEqual(['at-1', 'at-2']);
  });

  it('再送でも 401 ならセッションを破棄し、それ以上は再試行しない', async () => {
    const send = vi.fn(async () => res(401));
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: true, tokens: newTokens }));
    const r = await forwardWithRefresh({ accessToken: 'at-1', refreshToken: 'rt-1', send, refresh });
    expect(r.response.status).toBe(401);
    expect(r.clearSession).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('リフレッシュトークンが無効（fatal）ならセッション破棄', async () => {
    const send = vi.fn(async () => res(401));
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: false, fatal: true, status: 401 }));
    const r = await forwardWithRefresh({ accessToken: 'at-1', refreshToken: 'rt-1', send, refresh });
    expect(r.response.status).toBe(401);
    expect(r.clearSession).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('リフレッシュの一時的失敗は 503 でセッションは保持', async () => {
    const send = vi.fn(async () => res(401));
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: false, fatal: false, status: 0 }));
    const r = await forwardWithRefresh({ accessToken: 'at-1', refreshToken: 'rt-1', send, refresh });
    expect(r.response.status).toBe(503);
    expect(r.clearSession).toBe(false);
  });

  it('アクセストークン Cookie が無ければ先にリフレッシュする', async () => {
    const send = vi.fn(async () => res(200));
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: true, tokens: newTokens }));
    const r = await forwardWithRefresh({ accessToken: undefined, refreshToken: 'rt-1', send, refresh });
    expect(send).toHaveBeenCalledWith('at-2');
    expect(r.tokens).toEqual(newTokens);
  });

  it('事前リフレッシュ後に 401 なら再リフレッシュせずセッション破棄', async () => {
    const send = vi.fn(async () => res(401));
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: true, tokens: newTokens }));
    const r = await forwardWithRefresh({ accessToken: null, refreshToken: 'rt-1', send, refresh });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.clearSession).toBe(true);
  });

  it('トークンが何も無ければ送信せず 401', async () => {
    const send = vi.fn();
    const r = await forwardWithRefresh({ accessToken: null, refreshToken: null, send, refresh: vi.fn() });
    expect(r.response.status).toBe(401);
    expect(r.clearSession).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('リフレッシュ後の送信が通信断でも新トークンは返す（Cookie を更新できる）', async () => {
    const send = vi.fn(async (t: string) => {
      if (t === 'at-1') return res(401);
      throw new TypeError('fetch failed');
    });
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: true, tokens: newTokens }));
    const r = await forwardWithRefresh({ accessToken: 'at-1', refreshToken: 'rt-1', send, refresh });
    expect(r.response.status).toBe(502);
    expect(r.tokens).toEqual(newTokens);
    expect(r.clearSession).toBe(false);
  });

  it('タイムアウトは 504', async () => {
    const send = vi.fn(async () => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    const r = await forwardWithRefresh({ accessToken: 'at-1', refreshToken: 'rt-1', send, refresh: vi.fn() });
    expect(r.response.status).toBe(504);
    const body = (await r.response.json()) as { message: string };
    expect(body.message).toMatch(/接続できません/);
  });
});

describe('RefreshCoordinator', () => {
  it('同じリフレッシュトークンの並行リフレッシュは1回にまとめる（再利用検知による全失効を防ぐ）', async () => {
    let resolve!: (o: RefreshOutcome) => void;
    const fn = vi.fn(() => new Promise<RefreshOutcome>((r) => (resolve = r)));
    const c = new RefreshCoordinator(fn);
    const p1 = c.refresh('rt-1');
    const p2 = c.refresh('rt-1');
    resolve({ ok: true, tokens: newTokens });
    await expect(p1).resolves.toEqual({ ok: true, tokens: newTokens });
    await expect(p2).resolves.toEqual({ ok: true, tokens: newTokens });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('直後に古いトークンで来たリクエストには猶予時間内だけ同じ結果を返す', async () => {
    let now = 1_000;
    const fn = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: true, tokens: newTokens }));
    const c = new RefreshCoordinator(fn, { graceMs: 30_000, now: () => now });
    await c.refresh('rt-1');
    now += 10_000;
    await c.refresh('rt-1');
    expect(fn).toHaveBeenCalledTimes(1);
    now += 30_001;
    await c.refresh('rt-1');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('一時的な失敗はキャッシュせず次回再試行する', async () => {
    const fn = vi
      .fn<() => Promise<RefreshOutcome>>()
      .mockResolvedValueOnce({ ok: false, fatal: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, tokens: newTokens });
    const c = new RefreshCoordinator(fn);
    expect((await c.refresh('rt-1')).ok).toBe(false);
    expect((await c.refresh('rt-1')).ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('例外は一時的失敗として扱う', async () => {
    const c = new RefreshCoordinator(async () => {
      throw new Error('boom');
    });
    await expect(c.refresh('rt-1')).resolves.toEqual({ ok: false, fatal: false, status: 0 });
  });
});

describe('createApiRefresh', () => {
  it('POST /auth/refresh を呼び、200 ならトークンを返す', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => res(200, newTokens));
    const r = await createApiRefresh('http://api.test/v1', fetchImpl as unknown as typeof fetch)('rt-1');
    expect(r).toEqual({ ok: true, tokens: newTokens });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://api.test/v1/auth/refresh');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'rt-1' });
  });
  it('401 は fatal、500・通信断は一時的', async () => {
    expect(await createApiRefresh('x', (async () => res(401)) as unknown as typeof fetch)('rt')).toEqual({ ok: false, fatal: true, status: 401 });
    expect(await createApiRefresh('x', (async () => res(500)) as unknown as typeof fetch)('rt')).toEqual({ ok: false, fatal: false, status: 500 });
    expect(
      await createApiRefresh('x', (async () => {
        throw new TypeError('network');
      }) as unknown as typeof fetch)('rt'),
    ).toEqual({ ok: false, fatal: false, status: 0 });
  });
});
