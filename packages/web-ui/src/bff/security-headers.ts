/**
 * next.config の headers() で返すセキュリティヘッダー。
 * 本番の CSP は unsafe-eval を含めない。Next のハイドレーション用インラインスクリプトのため script-src に 'unsafe-inline' が必要
 * （nonce 方式にすると全ページが動的描画になるため採用していない。README 参照）。
 */
export interface SecurityHeaderOptions {
  isDev: boolean;
  /** 証跡画像の署名URLの配信元（例 API のオリジン、S3 互換ストレージのオリジン） */
  imageOrigins?: readonly string[];
  /** HTTPS 運用時のみ upgrade-insecure-requests / HSTS を付ける（既定: !isDev） */
  https?: boolean;
}

export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildCsp({ isDev, imageOrigins = [], https = !isDev }: SecurityHeaderOptions): string {
  const img = ["'self'", 'data:', 'blob:', ...imageOrigins.filter(Boolean)];
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${Array.from(new Set(img)).join(' ')}`,
    "font-src 'self'",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export function securityHeaders(options: SecurityHeaderOptions): { key: string; value: string }[] {
  const headers = [
    { key: 'Content-Security-Policy', value: buildCsp(options) },
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ];
  if (options.https ?? !options.isDev) headers.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' });
  return headers;
}

/** HD_API_BASE_URL と HD_EVIDENCE_IMAGE_ORIGINS（カンマ区切り）から img-src の許可元を作る */
export function imageOriginsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const list = [originOf(env.HD_API_BASE_URL ?? 'http://localhost:8080/v1')];
  for (const o of (env.HD_EVIDENCE_IMAGE_ORIGINS ?? '').split(',')) list.push(originOf(o.trim()));
  return list.filter((o): o is string => !!o);
}
