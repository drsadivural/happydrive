/**
 * Next の proxy.ts（旧 middleware）用。
 * - 未ログイン（リフレッシュトークン Cookie なし）で保護ページに来たら /login?next=... へリダイレクト
 * - CSRF 用 Cookie が無ければ発行
 * Cookie の有無だけを見る軽量チェックで、トークンの有効性・ロールは BFF と API が検証する。
 */
import { NextResponse, type NextRequest } from 'next/server';
import { generateCsrfToken } from './csrf';
import { applyCookies } from './http';
import { cookieNames, csrfCookie, type SessionConfig } from './session';
import { safeNextPath } from '../nav';

export { safeNextPath };

export interface PageGuardOptions {
  session: SessionConfig;
  /** 認証不要のページ（完全一致または接頭辞 + '/'） */
  publicPaths: readonly string[];
  loginPath?: string;
}

export function isPublicPath(pathname: string, publicPaths: readonly string[]): boolean {
  return publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function createPageGuard(options: PageGuardOptions) {
  const names = cookieNames(options.session);
  const loginPath = options.loginPath ?? '/login';

  return function proxy(req: NextRequest): NextResponse {
    const { pathname, search } = req.nextUrl;
    const isApi = pathname.startsWith('/api/');
    const hasSession = !!req.cookies.get(names.refresh)?.value;

    let res: NextResponse;
    if (!isApi && !hasSession && !isPublicPath(pathname, options.publicPaths)) {
      const url = req.nextUrl.clone();
      url.pathname = loginPath;
      url.search = '';
      url.searchParams.set('next', safeNextPath(`${pathname}${search}`));
      res = NextResponse.redirect(url);
    } else {
      res = NextResponse.next();
    }
    if (!req.cookies.get(names.csrf)?.value) {
      applyCookies(res, [csrfCookie(options.session, generateCsrfToken())]);
    }
    res.headers.set('cache-control', 'no-store');
    return res;
  };
}
