import type pg from 'pg';
import type { AppContext, HdRequest } from '../context.js';
import { canonicalJson, sha256Hex } from './crypto.js';
import { AppError, badRequest } from './errors.js';

export interface IdemResult<T> { status: number; body: T }

/**
 * Runs `fn` inside a transaction guarded by (actor, Idempotency-Key).
 * - The key row is inserted first in the same transaction: concurrent duplicates block on the PK
 *   and then replay the committed response.
 * - Domain errors (4xx) are stored too, so a retry gets the same answer.
 * - A different request body under the same key is rejected (422 idempotency_mismatch).
 */
export async function withIdempotency<T = any>(
  ctx: AppContext,
  req: HdRequest,
  operation: string,
  fn: (c: pg.PoolClient) => Promise<IdemResult<unknown>>,
): Promise<IdemResult<T>> {
  const actorId = req.user!.id;
  const key = String(req.headers['idempotency-key'] ?? '');
  if (key.length < 16) throw badRequest('idempotency_key_required', 'Idempotency-Key ヘッダーが必要です');
  const requestHash = sha256Hex(canonicalJson({ operation, params: req.params ?? {}, body: req.body ?? null }));

  const c = await ctx.db.connect();
  try {
    await c.query('BEGIN');
    const ins = await c.query(
      `INSERT INTO idempotency_keys(actor_id, key, operation, request_hash, status_code, response_json)
       VALUES ($1,$2,$3,$4,0,'{}') ON CONFLICT DO NOTHING RETURNING key`,
      [actorId, key, operation, requestHash],
    );
    if (ins.rowCount === 0) {
      await c.query('ROLLBACK');
      return replay<T>(c, actorId, key, requestHash);
    }
    let result: IdemResult<unknown>;
    try {
      result = await fn(c);
    } catch (e) {
      await c.query('ROLLBACK');
      if (e instanceof AppError && e.statusCode < 500) {
        const errBody = { code: e.code, message: e.message, details: e.details };
        await c.query(
          `INSERT INTO idempotency_keys(actor_id, key, operation, request_hash, status_code, response_json)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [actorId, key, operation, requestHash, e.statusCode, errBody],
        );
      }
      throw e;
    }
    await c.query('UPDATE idempotency_keys SET status_code = $3, response_json = $4 WHERE actor_id = $1 AND key = $2', [
      actorId, key, result.status, JSON.stringify(result.body ?? null),
    ]);
    await c.query('COMMIT');
    return result as IdemResult<T>;
  } finally {
    c.release();
  }
}

async function replay<T>(c: pg.PoolClient, actorId: string, key: string, requestHash: string): Promise<IdemResult<T>> {
  const r = await c.query('SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE actor_id = $1 AND key = $2', [actorId, key]);
  const row = r.rows[0];
  if (!row) throw new AppError(409, 'idempotency_in_progress', '同じ操作を処理中です。少し待ってから再度お試しください');
  if (row.request_hash !== requestHash) throw badRequest('idempotency_mismatch', '同じ Idempotency-Key で異なる内容が送信されました');
  if (row.status_code >= 400) {
    const b = row.response_json;
    throw new AppError(row.status_code, b.code, b.message, b.details);
  }
  return { status: row.status_code, body: row.response_json as T };
}
