/**
 * CSRF 対策（ダブルサブミット Cookie + カスタムヘッダー + Origin 検査）。
 * - ページ表示時に `<prefix>_csrf` Cookie（JS から読める・SameSite=Strict）を発行
 * - 変更系リクエストでは同値を `x-hd-csrf` ヘッダーで送らせ、Cookie と定数時間比較
 * - Origin / Sec-Fetch-Site が別サイトなら拒否
 */
export const CSRF_HEADER = 'x-hd-csrf';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutatingMethod(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}

export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 長さが違っても早期 return しない比較（長さの差も結果に反映） */
export function timingSafeEqualString(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export interface CsrfInput {
  method: string;
  headerToken: string | null | undefined;
  cookieToken: string | null | undefined;
  /** リクエストの Origin ヘッダー */
  origin?: string | null;
  /** リクエストの Host（リバースプロキシ配下では X-Forwarded-Host） */
  host?: string | null;
  secFetchSite?: string | null;
}

export type CsrfResult = { ok: true } | { ok: false; reason: 'cross_site' | 'origin_mismatch' | 'missing_token' | 'token_mismatch' };

export function checkCsrf(input: CsrfInput): CsrfResult {
  if (!isMutatingMethod(input.method)) return { ok: true };
  if (input.secFetchSite && input.secFetchSite !== 'same-origin') return { ok: false, reason: 'cross_site' };
  if (input.origin && input.host) {
    let originHost: string | null = null;
    try {
      originHost = new URL(input.origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== input.host) return { ok: false, reason: 'origin_mismatch' };
  }
  const header = input.headerToken ?? '';
  const cookie = input.cookieToken ?? '';
  if (header.length < 16 || cookie.length < 16) return { ok: false, reason: 'missing_token' };
  return timingSafeEqualString(header, cookie) ? { ok: true } : { ok: false, reason: 'token_mismatch' };
}
