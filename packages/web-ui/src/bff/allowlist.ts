/**
 * BFF プロキシのパス許可リスト。ブラウザから到達できる API を最小限に限定する。
 * パターンは `/organizations/{id}/jobs` のように `{name}` を1セグメントのパラメータとして書く。
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AllowRule {
  methods: readonly HttpMethod[];
  path: string;
}

export interface CompiledRule {
  methods: ReadonlySet<string>;
  regex: RegExp;
  path: string;
}

const PARAM_SEGMENT = '[A-Za-z0-9_\\-.:]{1,128}';
const SAFE_SEGMENT = /^[A-Za-z0-9_\-.:]{1,128}$/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileRules(rules: readonly AllowRule[]): CompiledRule[] {
  return rules.map((rule) => {
    if (!rule.path.startsWith('/')) throw new Error(`allowlist path must start with '/': ${rule.path}`);
    const parts = rule.path
      .split('/')
      .slice(1)
      .map((seg) => (/^\{[A-Za-z0-9_]+\}$/.test(seg) ? PARAM_SEGMENT : escapeRegex(seg)));
    return {
      methods: new Set(rule.methods),
      regex: new RegExp(`^/${parts.join('/')}$`),
      path: rule.path,
    };
  });
}

/**
 * catch-all ルートのセグメント配列を API パスに正規化する。
 * `..`・`.`・空セグメント・許可外文字（エンコード済み `/` や `%` を含む）を含む場合は null。
 */
export function normalizeApiPath(segments: readonly string[] | undefined): string | null {
  if (!segments || segments.length === 0 || segments.length > 12) return null;
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || !SAFE_SEGMENT.test(seg)) return null;
  }
  return `/${segments.join('/')}`;
}

export function isAllowed(rules: readonly CompiledRule[], method: string, path: string): boolean {
  const m = method.toUpperCase();
  return rules.some((r) => r.methods.has(m) && r.regex.test(path));
}
