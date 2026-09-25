import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl, 2);
migrate(pool, (m) => console.warn(m))
  .then((a) => console.warn(a.length ? `${a.length} migration(s) applied` : 'up to date'))
  .finally(() => pool.end());
