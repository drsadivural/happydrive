// "No mocks in production": the production configuration refuses development-only adapters and weak secrets.
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

const prod = (extra: Record<string, string> = {}) => {
  process.env = {
    ...saved, NODE_ENV: 'production', DATABASE_URL: 'postgresql://x@db/x', JWT_SECRET: 'x'.repeat(40),
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), DATA_HMAC_KEY: Buffer.alloc(32, 2).toString('base64'),
    STORAGE_PROVIDER: 's3', OBJECT_STORE_BUCKET: 'b', ...extra,
  };
  return loadConfig();
};

describe('production configuration fails closed', () => {
  it('starts with real adapters and disables SMS/payouts until contracted', () => {
    const c = prod();
    expect(c.sms.provider).toBe('none');
    expect(c.payouts.provider).toBe('none');
    expect(c.storage.provider).toBe('s3');
    expect(c.restrictedCategoriesEnabled).toBe(false);
    expect(c.trustProxy).toBe(false);
  });
  it('rejects console SMS, local storage and sandbox payouts', () => {
    expect(() => prod({ SMS_PROVIDER: 'console' })).toThrow(/SMS_PROVIDER=console/);
    expect(() => prod({ STORAGE_PROVIDER: 'local' })).toThrow(/STORAGE_PROVIDER=local/);
    expect(() => prod({ PAYOUT_PROVIDER: 'sandbox' })).toThrow(/PAYOUT_PROVIDER=sandbox/);
  });
  it('requires strong secrets', () => {
    expect(() => prod({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => prod({ DATA_ENCRYPTION_KEY: '' })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => prod({ DATA_HMAC_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 バイト/);
  });
  it('refuses a spoofable trustProxy=true', () => {
    expect(() => prod({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(prod({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
  });
  it('validates the App Review account code', () => {
    expect(() => prod({ REVIEW_ACCOUNT_PHONE: '09000000000', REVIEW_ACCOUNT_CODE: '12ab' })).toThrow(/REVIEW_ACCOUNT_CODE/);
  });
});
