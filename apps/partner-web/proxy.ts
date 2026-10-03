import type { NextRequest } from 'next/server';
import { createPageGuard } from '@happydrive/web-ui/bff/page-guard';
import { sessionConfig } from '@happydrive/web-ui/bff/session';
import { COOKIE_PREFIX } from './lib/config';

const guard = createPageGuard({
  session: sessionConfig(COOKIE_PREFIX),
  loginPath: '/customer-login',
  publicPaths: ['/login', '/signup', '/customer-login'],
});

export function proxy(request: NextRequest) {
  return guard(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)'],
};
