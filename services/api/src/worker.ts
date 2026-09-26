import pino from 'pino';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { FieldCipher } from './lib/crypto.js';
import { createStorage } from './adapters/storage.js';
import { createSms } from './adapters/sms.js';
import { createPayouts } from './adapters/payouts.js';
import { ApnsClient } from './adapters/apns.js';
import type { AppContext } from './context.js';
import { applyRetention, closeJobs, closeStaleVoiceSessions, deliverOutbox, expireReservations, reconcilePayouts } from './jobs/maintenance.js';

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel });
const db = createPool(cfg.databaseUrl, 5);
const ctx: AppContext = {
  cfg, db, cipher: new FieldCipher(cfg.dataEncryptionKey, cfg.dataHmacKey), storage: createStorage(cfg),
  sms: createSms(cfg, log as any), payouts: createPayouts(cfg, db), log: log as any,
};
const apns = new ApnsClient(cfg.apns);
if (!apns.enabled) log.warn('APNs is not configured: push notifications are skipped (in-app notifications remain)');

let stopping = false;
const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
  const run = async () => {
    if (stopping) return;
    try {
      const r = await fn();
      if (r && (typeof r === 'number' ? r > 0 : true)) log.debug({ task: name, result: r }, 'task done');
    } catch (e) {
      log.error({ task: name, err: (e as Error).message }, 'task failed');
    }
    if (!stopping) setTimeout(run, ms).unref();
  };
  setTimeout(run, 1000).unref();
};

every('outbox', 2_000, () => deliverOutbox(ctx, apns));
every('reservations', 30_000, () => expireReservations(ctx));
every('jobs', 60_000, () => closeJobs(ctx));
every('voice', 60_000, () => closeStaleVoiceSessions(ctx));
every('payouts', 60_000, () => reconcilePayouts(ctx));
every('retention', 60 * 60_000, () => applyRetention(ctx));

const keepAlive = setInterval(() => undefined, 60_000);
const stop = async () => {
  stopping = true;
  clearInterval(keepAlive);
  apns.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
log.info('HappyDrive worker started');
