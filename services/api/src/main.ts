import { buildApp } from './server.js';
import { migrate } from './db/migrate.js';

const { app, ctx } = await buildApp();
if (process.env.MIGRATE_ON_START === 'true') await migrate(ctx.db, (m) => app.log.info(m));

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: ctx.cfg.port, host: '0.0.0.0' });
app.log.info({ env: ctx.cfg.env, sms: ctx.sms.name, storage: ctx.storage.name, payouts: ctx.payouts.name }, 'HappyDrive API started');
