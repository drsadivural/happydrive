import pg from 'pg';

// Return timestamptz as Date, bigint (JPY sums) as number: amounts stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE columns stay as 'YYYY-MM-DD' strings (no implicit timezone shifts).
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Client = pg.PoolClient | pg.Pool;

export function createPool(url: string, max = 20): pg.Pool {
  return new pg.Pool({ connectionString: url, max, application_name: 'happydrive-api', options: '-c timezone=UTC' });
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
