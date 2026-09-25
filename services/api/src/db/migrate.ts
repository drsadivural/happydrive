import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Applies migrations/NNN_*.sql in order, each in its own transaction, recording them in schema_migrations. */
export async function migrate(pool: pg.Pool, log: (m: string) => void = () => undefined): Promise<string[]> {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727274000)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      applied.push(f);
      log(`applied ${f}`);
    }
    return applied;
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274000)').catch(() => undefined);
    c.release();
  }
}
