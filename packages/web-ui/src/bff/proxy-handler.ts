/**
 * 同一オリジンの API プロキシ（BFF）。`app/api/hd/[...path]/route.ts` から使う。
 * - 許可リスト外のパス・メソッドは 403
 * - 変更系は CSRF 検査
 * - httpOnly Cookie のアクセストークンを Bearer として付与し、401 ならリフレッシュして1回だけ再送
 * - Idempotency-Key を転送（再送でも同じキー）
 * - 上流の Set-Cookie 等は転送しない
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { compileRules, isAllowed, normalizeApiPath, type AllowRule } from './allowlist';
import { isMutatingMethod } from './csrf';
import { applyCookies, errorResponse, UPSTREAM_UNREACHABLE_MESSAGE, verifyCsrf } from './http';
import { createApiRefresh, forwardWithRefresh, RefreshCoordinator } from './refresh';
import { apiBaseUrl, clearedSessionCookies, cookieNames, sessionCookies, type SessionConfig } from './session';

export interface ApiProxyOptions {
  rules: readonly AllowRule[];
  session: SessionConfig;
  apiBase?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_\-:.]{16,128}$/;
const FORWARD_RESPONSE_HEADERS = ['content-type', 'x-request-id', 'retry-after', 'content-disposition'];

type RouteCtx = { params: Promise<{ path?: string[] }> };

export function createApiProxy(options: ApiProxyOptions) {
  const rules = compileRules(options.rules);
  const apiBase = options.apiBase ?? apiBaseUrl();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const coordinator = new RefreshCoordinator(createApiRefresh(apiBase));
  const names = cookieNames(options.session);

  async function handler(req: NextRequest, ctx: RouteCtx): Promise<Response> {
    const { path: segments } = await ctx.params;
    const path = normalizeApiPath(segments);
    const method = req.method.toUpperCase();
    if (!path || !isAllowed(rules, method, path)) {
      return errorResponse(403, 'not_allowed', 'この操作はこの画面からは利用できません。');
    }

    if (isMutatingMethod(method)) {
      const csrfError = verifyCsrf(req, options.session);
      if (csrfError) return csrfError;
    }

    const headers = new Headers({ accept: 'application/json', 'accept-language': 'ja' });
    const idem = req.headers.get('idempotency-key');
    if (idem) {
      if (!IDEMPOTENCY_KEY_RE.test(idem)) return errorResponse(422, 'invalid_idempotency_key', '送信キーが不正です。再読み込みしてください。');
      headers.set('idempotency-key', idem);
    }
    const requestId = req.headers.get('x-request-id');
    if (requestId && /^[A-Za-z0-9_-]{8,64}$/.test(requestId)) headers.set('x-request-id', requestId);
    const forwardedFor = req.headers.get('x-forwarded-for');
    if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);

    let body: ArrayBuffer | undefined;
    if (method !== 'GET' && method !== 'DELETE') {
      const contentType = req.headers.get('content-type') ?? '';
      const buf = await req.arrayBuffer();
      if (buf.byteLength > maxBodyBytes) return errorResponse(413, 'payload_too_large', '送信内容が大きすぎます。');
      if (buf.byteLength > 0) {
        if (!contentType.toLowerCase().startsWith('application/json')) {
          return errorResponse(415, 'unsupported_media_type', '送信形式が正しくありません。');
        }
        headers.set('content-type', 'application/json');
        body = buf;
      }
    }

    const target = `${apiBase}${path}${req.nextUrl.search}`;
    const send = (accessToken: string) => {
      const h = new Headers(headers);
      h.set('authorization', `Bearer ${accessToken}`);
      return fetch(target, {
        method,
        headers: h,
        body,
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    };

    let result;
    try {
      result = await forwardWithRefresh({
        accessToken: req.cookies.get(names.access)?.value,
        refreshToken: req.cookies.get(names.refresh)?.value,
        send,
        refresh: (rt) => coordinator.refresh(rt),
      });
    } catch {
      return errorResponse(502, 'upstream_unreachable', UPSTREAM_UNREACHABLE_MESSAGE);
    }

    const upstream = result.response;
    const outHeaders = new Headers({ 'cache-control': 'no-store' });
    for (const h of FORWARD_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) outHeaders.set(h, v);
    }
    const noBody = upstream.status === 204 || upstream.status === 304;
    const res = new NextResponse(noBody ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: outHeaders });
    if (result.tokens) applyCookies(res, sessionCookies(options.session, result.tokens));
    if (result.clearSession) applyCookies(res, clearedSessionCookies(options.session));
    return res;
  }

  return { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler };
}
