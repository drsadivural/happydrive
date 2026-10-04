import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://happydrive:happydrive@localhost:5433/happydrive_test';
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  await pool.query('DROP SCHEMA IF EXISTS marketplace CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  await pool.end();
}
