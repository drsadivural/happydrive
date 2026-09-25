/** open redirect を防ぐため、同一オリジンの相対パスのみ許可する */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\r\n\t]/.test(value) || value.includes('\\')) return fallback;
  return value;
}
