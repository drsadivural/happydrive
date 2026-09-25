/**
 * Idempotency-Key の生成と再利用。
 * - 利用者が意図した1回の送信ごとに新しいキー（prefix + UUID、16文字以上）
 * - 結果が不明な失敗（通信断・5xx・429）後に同じ内容で再送する場合は同じキーを使う
 * - 内容が変わった場合・成功後・確定的なエラー（4xx）後は新しいキー
 */
export function newIdempotencyKey(prefix = 'web'): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'web';
  return `${safePrefix}-${globalThis.crypto.randomUUID()}`;
}

/** キー順序に依存しない JSON 文字列化（同一内容判定用） */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export class IdempotencyKeeper {
  private current: { fingerprint: string; key: string } | null = null;

  constructor(
    private readonly prefix: string,
    private readonly generate: (prefix: string) => string = newIdempotencyKey,
  ) {}

  /** この送信内容に使うキー。直前の未確定送信と同じ内容なら同じキーを返す。 */
  keyFor(payload: unknown): string {
    const fingerprint = stableStringify(payload);
    if (this.current && this.current.fingerprint === fingerprint) return this.current.key;
    const key = this.generate(this.prefix);
    this.current = { fingerprint, key };
    return key;
  }

  /** 成功した（結果が確定した）ので次の送信は新しいキー */
  succeeded(): void {
    this.current = null;
  }

  /** 失敗。retryable=true（結果不明）ならキーを保持し、同じ内容の再送で再利用する。 */
  failed(retryable: boolean): void {
    if (!retryable) this.current = null;
  }
}
