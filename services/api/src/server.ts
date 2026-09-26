import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { loadConfig, type Config } from './config.js';
import { createPool } from './db/pool.js';
import { FieldCipher } from './lib/crypto.js';
import { AppError } from './lib/errors.js';
import { createStorage, type StorageAdapter } from './adapters/storage.js';
import { createSms, type SmsAdapter } from './adapters/sms.js';
import { createPayouts, type PayoutProvider } from './adapters/payouts.js';
import { loadOperations } from './openapi/loader.js';
import { authenticate } from './auth/tokens.js';
import type { AppContext, HandlerMap, HdRequest } from './context.js';
import { authHandlers } from './modules/auth.js';
import { identityHandlers } from './modules/identity.js';
import { deliveryHandlers } from './modules/delivery.js';
import { jobHandlers } from './modules/jobs.js';
import { assignmentHandlers } from './modules/assignments.js';
import { evidenceHandlers } from './modules/evidence.js';
import { messagingHandlers } from './modules/messaging.js';
import { notificationHandlers } from './modules/notifications.js';
import { earningsHandlers } from './modules/payouts.js';
import { learningHandlers } from './modules/learning.js';
import { organizationHandlers } from './modules/organizations.js';
import { adminHandlers } from './modules/admin.js';
import { voiceHandlers } from './modules/voice/handlers.js';

export interface BuildOptions {
  cfg?: Config;
  db?: pg.Pool;
  storage?: StorageAdapter;
  sms?: SmsAdapter;
  payouts?: PayoutProvider;
  /** Test hook: capture log output. */
  logStream?: NodeJS.WritableStream;
}

const systemHandlers: HandlerMap = {
  async healthz() {
    return { status: 'ok' };
  },
  async readyz(ctx, _req, reply) {
    const checks: Record<string, string> = {};
    try {
      await ctx.db.query('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }
    checks.sms = ctx.sms.name;
    checks.storage = ctx.storage.name;
    checks.payouts = ctx.payouts.enabled ? ctx.payouts.name : 'disabled';
    const ok = checks.database === 'ok';
    reply.code(ok ? 200 : 503);
    return ok ? { status: 'ok', checks } : { code: 'not_ready', message: '依存サービスに接続できません', details: checks };
  },
};

export const allHandlers: HandlerMap = {
  ...systemHandlers,
  ...authHandlers,
  ...identityHandlers,
  ...deliveryHandlers,
  ...jobHandlers,
  ...assignmentHandlers,
  ...evidenceHandlers,
  ...messagingHandlers,
  ...notificationHandlers,
  ...earningsHandlers,
  ...learningHandlers,
  ...organizationHandlers,
  ...adminHandlers,
  ...voiceHandlers,
};

/** Strips query strings (may carry coordinates) and signed tokens from logged URLs. */
function safeUrl(url: string): string {
  return url.split('?')[0]!.replace(/\/evidence-blobs\/[^/]+/, '/evidence-blobs/[redacted]');
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const cfg = opts.cfg ?? loadConfig();
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-hd-signature"]'], censor: '[redacted]' },
      serializers: {
        req: (r) => ({ method: r.method, url: safeUrl(r.url), requestId: r.id }),
        res: (r) => ({ statusCode: r.statusCode }),
      },
    },
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[\w-]{8,64}$/.test(h) ? h : randomUUID();
    },
    bodyLimit: 1_500_000,
    routerOptions: { maxParamLength: 2048 },
    trustProxy: cfg.trustProxy as boolean | string,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true, allErrors: false } },
  });

  const db = opts.db ?? createPool(cfg.databaseUrl);
  const ctx: AppContext = {
    cfg,
    db,
    cipher: new FieldCipher(cfg.dataEncryptionKey, cfg.dataHmacKey),
    storage: opts.storage ?? createStorage(cfg),
    sms: opts.sms ?? createSms(cfg, app.log),
    payouts: opts.payouts ?? createPayouts(cfg, db),
    log: app.log,
  };

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, { origin: cfg.corsOrigins, credentials: false, allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'] });
  const redis = cfg.redisUrl ? new Redis(cfg.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false }) : undefined;
  await app.register(rateLimit, {
    global: true,
    max: cfg.rateLimitPerMinute,
    timeWindow: '1 minute',
    redis,
    skipOnError: true,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, c) => ({ statusCode: 429, code: 'rate_limited', message: `リクエストが多すぎます。${Math.ceil(c.ttl / 1000)}秒後にお試しください` }),
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, raw, done) => {
    (req as any).rawBody = raw;
    if (!raw || (raw as string).trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(raw as string));
    } catch {
      done(new AppError(400, 'invalid_json', 'JSONの形式が正しくありません'), undefined);
    }
  });
  app.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: 15_000_000 }, (_req, raw, done) => done(null, raw));

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'app error');
      return reply.code(err.statusCode).send({ code: err.code, message: err.message, requestId: req.id, details: err.details });
    }
    if (err.validation) {
      return reply.code(422).send({
        code: 'validation', message: '入力内容に誤りがあります', requestId: req.id,
        details: { errors: err.validation.map((v: any) => ({ path: `${err.validationContext}${v.instancePath}`, message: v.message, params: v.params })) },
      });
    }
    if (err.statusCode === 429) return reply.code(429).send({ code: 'rate_limited', message: err.message, requestId: req.id });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ code: err.code ?? 'bad_request', message: 'リクエストが正しくありません', requestId: req.id });
    }
    // Postgres unique violations that escaped explicit checks are conflicts, not crashes.
    if (err.code === '23505') return reply.code(409).send({ code: 'conflict', message: '同じ内容が既に登録されています', requestId: req.id });
    req.log.error({ err: { message: err.message, code: err.code, stack: err.stack } }, 'unhandled error');
    return reply.code(500).send({ code: 'internal', message: '一時的なエラーが発生しました。時間をおいて再度お試しください', requestId: req.id });
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ code: 'not_found', message: '見つかりません', requestId: req.id }));

  const ops = await loadOperations();
  const missing = ops.filter((o) => !allHandlers[o.operationId]).map((o) => o.operationId);
  if (missing.length) throw new Error(`OpenAPI operations without handlers: ${missing.join(', ')}`);

  for (const op of ops) {
    const handler = allHandlers[op.operationId]!;
    app.route({
      method: op.method as any,
      exposeHeadRoute: false,
      url: `/v1${op.path}`,
      schema: op.schema as any,
      preHandler: op.isPublic
        ? undefined
        : async (req: HdRequest) => {
            req.user = await authenticate(ctx, req.headers.authorization);
          },
      handler: async (req, reply) => {
        const out = await handler(ctx, req as HdRequest, reply);
        if (reply.sent) return reply;
        if (out === undefined) return reply.send();
        return out;
      },
    });
  }

  app.addHook('onClose', async () => {
    redis?.disconnect();
    if (!opts.db) await db.end();
  });

  return { app, ctx };
}
