/** Next の Route Handler / Proxy で使う小さな補助。 */
import { NextResponse, type NextRequest } from 'next/server';
import { checkCsrf, CSRF_HEADER } from './csrf';
import { cookieNames, type CookieSpec, type SessionConfig } from './session';

export function jsonResponse(status: number, body: unknown, init: { headers?: Record<string, string> } = {}): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...init.headers },
  });
}

export function errorResponse(status: number, code: string, message: string): NextResponse {
  return jsonResponse(status, { code, message });
}

export function applyCookies(res: NextResponse, cookies: readonly CookieSpec[]): void {
  for (const c of cookies) {
    res.cookies.set({
      name: c.name,
      value: c.value,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      path: c.path,
      maxAge: c.maxAge,
    });
  }
}

/** リバースプロキシ配下では X-Forwarded-Host を優先 */
export function requestHost(req: NextRequest): string | null {
  return req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host');
}

export function verifyCsrf(req: NextRequest, cfg: SessionConfig): NextResponse | null {
  const result = checkCsrf({
    method: req.method,
    headerToken: req.headers.get(CSRF_HEADER),
    cookieToken: req.cookies.get(cookieNames(cfg).csrf)?.value,
    origin: req.headers.get('origin'),
    host: requestHost(req),
    secFetchSite: req.headers.get('sec-fetch-site'),
  });
  if (result.ok) return null;
  return errorResponse(403, 'csrf_failed', '画面の有効期限が切れました。ページを再読み込みしてから操作してください。');
}

export const UPSTREAM_UNREACHABLE_MESSAGE = 'サーバーに接続できませんでした。しばらくしてから再試行してください。';
