'use client';
import { createApiClient } from '@happydrive/web-ui/client/api';
import { COOKIE_PREFIX } from './config';

let redirecting = false;

/** 企業ポータルの API クライアント（BFF 経由）。セッション切れはログイン画面へ。 */
export const api = createApiClient({
  cookiePrefix: COOKIE_PREFIX,
  onUnauthorized: () => {
    if (redirecting || typeof window === 'undefined') return;
    redirecting = true;
    const next = `${window.location.pathname}${window.location.search}`;
    // セッション切れ: 画面の状態を破棄してログインへ（完全な再読み込み）
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/login?reason=expired&next=${encodeURIComponent(next)}`);
  },
});

export { unwrap } from '@happydrive/web-ui/client/api';
