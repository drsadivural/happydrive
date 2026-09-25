// Environment configuration. Production refuses to start with development-only adapters
// (console SMS, local object storage, sandbox payouts) so that mocks can never ship.

export type Env = 'development' | 'test' | 'production' | 'staging';

export interface Config {
  env: Env;
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  redisUrl?: string;
  logLevel: string;
  jwtSecret: Uint8Array;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  dataEncryptionKey: Buffer;
  dataHmacKey: Buffer;
  corsOrigins: string[];
  /** Fastify trustProxy: false (default), hop count, or comma-separated CIDRs of the load balancer. Never `true` (spoofable X-Forwarded-For). */
  trustProxy: boolean | number | string;
  rateLimitPerMinute: number;
  sms: { provider: 'console' | 'none' };
  reviewAccount?: { phone: string; code: string };
  storage:
    | { provider: 'local'; dir: string; signingKey: Buffer }
    | { provider: 's3'; bucket: string; region: string; endpoint?: string; forcePathStyle: boolean };
  payouts: { provider: 'sandbox' | 'none'; webhookSecret?: string };
  apns?: { teamId: string; keyId: string; privateKeyPem: string; bundleId: string };
  termsVersion: string;
  privacyVersion: string;
  workerFeePercent: number;
  platformFeePercent: number;
  minHourlyWageYen: number;
  restrictedCategoriesEnabled: boolean;
  locationRetentionDays: number;
  recipientContactRetentionDays: number;
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`環境変数 ${name} が未設定です`);
  return v;
}

function key32(name: string, devFallback: string, env: Env): Buffer {
  const raw = process.env[name];
  if (!raw) {
    if (env === 'production' || env === 'staging') throw new Error(`環境変数 ${name} が未設定です`);
    return Buffer.from(devFallback.padEnd(32, '!').slice(0, 32));
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`${name} は base64 で 32 バイトである必要があります`);
  return buf;
}

function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (!v || v === 'false') return false;
  if (v === 'true') throw new Error('TRUST_PROXY=true は X-Forwarded-For の偽装を許すため使用できません。ホップ数かCIDRを指定してください');
  return /^\d+$/.test(v) ? Number(v) : v;
}

export function loadConfig(): Config {
  const env = (process.env.NODE_ENV ?? 'development') as Env;
  const hardened = env === 'production' || env === 'staging';

  const jwtRaw = process.env.JWT_SECRET ?? (hardened ? undefined : 'dev-only-jwt-secret-please-change-0123456789');
  if (!jwtRaw || jwtRaw.length < 32) throw new Error('JWT_SECRET は32文字以上が必要です');

  const smsProvider = (process.env.SMS_PROVIDER ?? (hardened ? 'none' : 'console')) as Config['sms']['provider'];
  const storageProvider = process.env.STORAGE_PROVIDER ?? (hardened ? 's3' : 'local');
  const payoutProvider = (process.env.PAYOUT_PROVIDER ?? (hardened ? 'none' : 'sandbox')) as Config['payouts']['provider'];

  if (hardened) {
    if (smsProvider === 'console') throw new Error('本番/ステージングで SMS_PROVIDER=console は使用できません');
    if (storageProvider === 'local') throw new Error('本番/ステージングで STORAGE_PROVIDER=local は使用できません');
    if (env === 'production' && payoutProvider === 'sandbox') throw new Error('本番で PAYOUT_PROVIDER=sandbox は使用できません');
  }

  const storage: Config['storage'] =
    storageProvider === 's3'
      ? {
          provider: 's3',
          bucket: req('OBJECT_STORE_BUCKET'),
          region: req('OBJECT_STORE_REGION', 'ap-northeast-1'),
          endpoint: process.env.OBJECT_STORE_ENDPOINT || undefined,
          forcePathStyle: process.env.OBJECT_STORE_FORCE_PATH_STYLE === 'true',
        }
      : {
          provider: 'local',
          dir: process.env.LOCAL_STORAGE_DIR ?? '.data/objects',
          signingKey: key32('LOCAL_STORAGE_SIGNING_KEY', 'dev-local-storage-signing-key', env),
        };

  const apns =
    process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_PRIVATE_KEY && process.env.APNS_BUNDLE_ID
      ? {
          keyId: process.env.APNS_KEY_ID,
          teamId: process.env.APNS_TEAM_ID,
          privateKeyPem: process.env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n'),
          bundleId: process.env.APNS_BUNDLE_ID,
        }
      : undefined;

  const reviewAccount =
    process.env.REVIEW_ACCOUNT_PHONE && process.env.REVIEW_ACCOUNT_CODE
      ? { phone: process.env.REVIEW_ACCOUNT_PHONE, code: process.env.REVIEW_ACCOUNT_CODE }
      : undefined;
  if (reviewAccount && !/^[0-9]{6}$/.test(reviewAccount.code)) throw new Error('REVIEW_ACCOUNT_CODE は6桁の数字です');

  return {
    env,
    port: Number(process.env.PORT ?? 8080),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`,
    databaseUrl: req('DATABASE_URL', hardened ? undefined : 'postgresql://happydrive:happydrive@localhost:5433/happydrive'),
    redisUrl: process.env.REDIS_URL || undefined,
    logLevel: process.env.LOG_LEVEL ?? (env === 'test' ? 'silent' : 'info'),
    jwtSecret: new TextEncoder().encode(jwtRaw),
    accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL_SEC ?? 900),
    refreshTokenTtlSec: Number(process.env.REFRESH_TOKEN_TTL_SEC ?? 60 * 60 * 24 * 30),
    dataEncryptionKey: key32('DATA_ENCRYPTION_KEY', 'dev-data-encryption-key', env),
    dataHmacKey: key32('DATA_HMAC_KEY', 'dev-data-hmac-key', env),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? (env === 'test' ? 100_000 : 300)),
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3001,http://localhost:3002').split(',').filter(Boolean),
    sms: { provider: smsProvider },
    reviewAccount,
    storage,
    payouts: {
      provider: payoutProvider,
      webhookSecret: process.env.PAYOUT_WEBHOOK_SECRET ?? (hardened ? undefined : 'dev-payout-webhook-secret'),
    },
    apns,
    termsVersion: process.env.TERMS_VERSION ?? '2026-09-26',
    privacyVersion: process.env.PRIVACY_VERSION ?? '2026-09-26',
    workerFeePercent: Number(process.env.WORKER_FEE_PERCENT ?? 0),
    platformFeePercent: Number(process.env.PLATFORM_FEE_PERCENT ?? 0),
    minHourlyWageYen: Number(process.env.MIN_HOURLY_WAGE_YEN ?? 1300),
    restrictedCategoriesEnabled: false,
    locationRetentionDays: Number(process.env.LOCATION_RETENTION_DAYS ?? 30),
    recipientContactRetentionDays: Number(process.env.RECIPIENT_CONTACT_RETENTION_DAYS ?? 7),
  };
}
