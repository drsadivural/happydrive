/**
 * トークンのリフレッシュと 401 時の単発リトライ。
 * API はリフレッシュトークンをローテーションし、使用済みトークンの再利用を検知すると系列ごと失効させる。
 * そのため同一プロセス内では同じリフレッシュトークンの更新を1回にまとめ（in-flight 共有）、
 * 直後に古い Cookie で届いた並行リクエストには短時間だけ同じ結果を返す。
 */
import type { TokenSet } from './session';

export type RefreshOutcome =
  | { ok: true; tokens: TokenSet }
  /** fatal=true: リフレッシュトークンが無効（再ログインが必要）。false: 通信断など一時的な失敗 */
  | { ok: false; fatal: boolean; status: number };

export type RefreshFn = (refreshToken: string) => Promise<RefreshOutcome>;

export class RefreshCoordinator {
  private readonly inflight = new Map<string, Promise<RefreshOutcome>>();
  private readonly recent = new Map<string, { outcome: RefreshOutcome; at: number }>();

  constructor(
    private readonly refreshFn: RefreshFn,
    private readonly options: { graceMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  refresh(refreshToken: string): Promise<RefreshOutcome> {
    const graceMs = this.options.graceMs ?? 30_000;
    const now = this.now();
    for (const [key, entry] of this.recent) {
      if (now - entry.at > graceMs) this.recent.delete(key);
    }
    const cached = this.recent.get(refreshToken);
    if (cached) return Promise.resolve(cached.outcome);
    const running = this.inflight.get(refreshToken);
    if (running) return running;

    const p = this.refreshFn(refreshToken)
      .catch((): RefreshOutcome => ({ ok: false, fatal: false, status: 0 }))
      .then((outcome) => {
        // 一時的な失敗はキャッシュしない（次のリクエストで再試行できる）
        if (outcome.ok || outcome.fatal) this.recent.set(refreshToken, { outcome, at: this.now() });
        return outcome;
      })
      .finally(() => {
        this.inflight.delete(refreshToken);
      });
    this.inflight.set(refreshToken, p);
    return p;
  }
}

/** API の POST /auth/refresh を呼ぶ RefreshFn */
export function createApiRefresh(apiBase: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): RefreshFn {
  return async (refreshToken) => {
    let res: Response;
    try {
      res = await fetchImpl(`${apiBase}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
    } catch {
      return { ok: false, fatal: false, status: 0 };
    }
    if (res.ok) {
      const tokens = (await res.json().catch(() => null)) as Partial<TokenSet> | null;
      if (tokens && typeof tokens.accessToken === 'string' && typeof tokens.refreshToken === 'string') {
        return {
          ok: true,
          tokens: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessTokenExpiresAt: String(tokens.accessTokenExpiresAt ?? ''),
            refreshTokenExpiresAt: String(tokens.refreshTokenExpiresAt ?? ''),
          },
        };
      }
      return { ok: false, fatal: false, status: 502 };
    }
    const fatal = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422;
    return { ok: false, fatal, status: res.status };
  };
}

export interface ForwardResult {
  response: Response;
  /** ローテーションされた新しいトークン（Cookie に保存する） */
  tokens?: TokenSet;
  /** セッションが無効になったので Cookie を消す */
  clearSession: boolean;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export const SESSION_EXPIRED_MESSAGE = 'ログインの有効期限が切れました。再度ログインしてください。';
export const UPSTREAM_ERROR_MESSAGE = 'サーバーに接続できませんでした。しばらくしてから再試行してください。';
export const REFRESH_UNAVAILABLE_MESSAGE = '認証サーバーに接続できませんでした。しばらくしてから再試行してください。';

/**
 * アクセストークンを付けて送信し、401 ならリフレッシュして1回だけ再送する。
 * - アクセストークン Cookie が無くリフレッシュトークンがある場合は先にリフレッシュ
 * - リフレッシュ後の再送でも 401 ならセッションを破棄
 */
export async function forwardWithRefresh(opts: {
  accessToken?: string | null;
  refreshToken?: string | null;
  send: (accessToken: string) => Promise<Response>;
  refresh: RefreshFn;
}): Promise<ForwardResult> {
  const { refreshToken, refresh } = opts;
  // 送信失敗（通信断・タイムアウト）でも、ローテーション済みトークンは呼び出し側で保存できるよう例外にしない
  const send = async (token: string): Promise<Response> => {
    try {
      return await opts.send(token);
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return jsonError(timeout ? 504 : 502, timeout ? 'upstream_timeout' : 'upstream_unreachable', UPSTREAM_ERROR_MESSAGE);
    }
  };
  let accessToken = opts.accessToken || null;
  let tokens: TokenSet | undefined;

  if (!accessToken) {
    if (!refreshToken) return { response: jsonError(401, 'unauthenticated', SESSION_EXPIRED_MESSAGE), clearSession: true };
    const r = await refresh(refreshToken);
    if (!r.ok) {
      return r.fatal
        ? { response: jsonError(401, 'session_expired', SESSION_EXPIRED_MESSAGE), clearSession: true }
        : { response: jsonError(503, 'auth_unavailable', REFRESH_UNAVAILABLE_MESSAGE), clearSession: false };
    }
    tokens = r.tokens;
    accessToken = r.tokens.accessToken;
  }

  let response = await send(accessToken);
  if (response.status !== 401) return { response, tokens, clearSession: false };

  // 既にこのリクエストでリフレッシュ済み、またはリフレッシュトークンが無い → 再ログインが必要
  if (tokens || !refreshToken) return { response, clearSession: true };

  const r = await refresh(refreshToken);
  if (!r.ok) {
    return r.fatal
      ? { response, clearSession: true }
      : { response: jsonError(503, 'auth_unavailable', REFRESH_UNAVAILABLE_MESSAGE), clearSession: false };
  }
  tokens = r.tokens;
  response = await send(tokens.accessToken);
  if (response.status === 401) return { response, clearSession: true };
  return { response, tokens, clearSession: false };
}
