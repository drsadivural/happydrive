import { createHmac, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';

export interface TransferRequest {
  idempotencyKey: string;
  amountYen: number;
  bank: { bankCode: string; branchCode: string; accountType: string; accountNumber: string; holderNameKana: string };
}
export type TransferStatus = 'processing' | 'paid' | 'failed';
export interface TransferResult { reference: string; status: TransferStatus; failureReason?: string }
export interface WebhookEvent { id: string; type: 'transfer.paid' | 'transfer.failed'; reference: string; occurredAt: string }

export interface PayoutProvider {
  readonly name: string;
  readonly enabled: boolean;
  createTransfer(req: TransferRequest): Promise<TransferResult>;
  /** Source of truth for settlement; webhooks are only a trigger to re-check. */
  getTransfer(reference: string): Promise<TransferResult | null>;
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): WebhookEvent | null;
}

export function signWebhook(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifySignature(secret: string, header: string | undefined, rawBody: string, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const mac = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return safeEqual(mac, parts.v1);
}

/**
 * Sandbox provider for development/staging: simulates a bank-transfer API (persisted in sandbox_transfers)
 * with the same idempotency semantics as a real provider. Accounts ending in 0000 fail (failure-path tests).
 * Settlement is signalled by a signed webhook and confirmed via getTransfer().
 */
export class SandboxPayouts implements PayoutProvider {
  readonly name = 'sandbox';
  readonly enabled = true;
  constructor(private readonly db: pg.Pool, private readonly secret: string) {}

  async createTransfer(req: TransferRequest): Promise<TransferResult> {
    const failed = req.bank.accountNumber.endsWith('0000');
    const reference = `sbx_${randomUUID()}`;
    const r = await this.db.query<{ reference: string; status: TransferStatus; failure_reason: string | null }>(
      `INSERT INTO sandbox_transfers(reference, idempotency_key, amount_yen, status, failure_reason)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING reference, status, failure_reason`,
      [reference, req.idempotencyKey, req.amountYen, failed ? 'failed' : 'processing', failed ? '口座情報が無効です（サンドボックス）' : null],
    );
    const row = r.rows[0]!;
    return { reference: row.reference, status: row.status, failureReason: row.failure_reason ?? undefined };
  }

  /** Dev/test hook: settle a sandbox transfer as the bank would. */
  async settle(reference: string, status: 'paid' | 'failed') {
    await this.db.query('UPDATE sandbox_transfers SET status = $2 WHERE reference = $1', [reference, status]);
  }

  async getTransfer(reference: string) {
    const r = await this.db.query('SELECT reference, status, failure_reason FROM sandbox_transfers WHERE reference = $1', [reference]);
    const t = r.rows[0];
    return t ? { reference: t.reference, status: t.status as TransferStatus, failureReason: t.failure_reason ?? undefined } : null;
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): WebhookEvent | null {
    const sig = headers['x-hd-signature'];
    if (!verifySignature(this.secret, Array.isArray(sig) ? sig[0] : sig, rawBody)) return null;
    let ev: WebhookEvent;
    try {
      ev = JSON.parse(rawBody) as WebhookEvent;
    } catch {
      return null;
    }
    if (!ev.id || !ev.reference || !['transfer.paid', 'transfer.failed'].includes(ev.type)) return null;
    return ev;
  }
}

/** No contracted payout provider: payouts are not offered (API returns 503). */
export class DisabledPayouts implements PayoutProvider {
  readonly name = 'none';
  readonly enabled = false;
  async createTransfer(): Promise<TransferResult> {
    throw new Error('payout provider not configured');
  }
  async getTransfer() {
    return null;
  }
  verifyWebhook() {
    return null;
  }
}

export function createPayouts(cfg: Config, db: pg.Pool): PayoutProvider {
  if (cfg.payouts.provider === 'sandbox') return new SandboxPayouts(db, cfg.payouts.webhookSecret ?? 'dev-payout-webhook-secret');
  return new DisabledPayouts();
}
