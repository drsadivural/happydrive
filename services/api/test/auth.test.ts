// ID-01: OTP registration/login, rate limiting, refresh rotation, web MFA; unverified users cannot accept (see jobs.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, loginWorker, randomPhone, setupApp, webUser, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => { env = await setupApp(); });
afterAll(async () => env.close());

describe('ID-01 phone OTP', () => {
  it('registers a new worker with a valid OTP', async () => {
    const w = await loginWorker(env);
    const me = await call(env, w, 'GET', '/me');
    expect(me.status).toBe(200);
    expect(me.body.roles).toContain('worker');
    expect(me.body.verificationStatus).toBe('unsubmitted');
    expect(me.body.phoneMasked).toMatch(/^090-\*\*\*\*-\d{4}$/);
  });

  it('rejects a wrong code and locks after 5 attempts', async () => {
    const phone = randomPhone();
    await call(env, null, 'POST', '/auth/otp/request', { phone });
    for (let i = 0; i < 5; i++) {
      const r = await call(env, null, 'POST', '/auth/otp/verify', { phone, code: '000000' === env.sms.codes.get(`+81${phone.slice(1)}`) ? '111111' : '000000' });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('otp_invalid');
    }
    const locked = await call(env, null, 'POST', '/auth/otp/verify', { phone, code: env.sms.codes.get(`+81${phone.slice(1)}`) });
    expect(locked.status).toBe(429);
  });

  it('rejects an expired code', async () => {
    const phone = randomPhone();
    await call(env, null, 'POST', '/auth/otp/request', { phone });
    await env.ctx.db.query(`UPDATE otp_challenges SET expires_at = now() - interval '1 second' WHERE phone_hash = $1`, [env.ctx.cipher.blindIndex(`+81${phone.slice(1)}`)]);
    const r = await call(env, null, 'POST', '/auth/otp/verify', { phone, code: env.sms.codes.get(`+81${phone.slice(1)}`) });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('otp_expired');
  });

  it('enforces resend interval and hourly limit per phone', async () => {
    const phone = randomPhone();
    expect((await call(env, null, 'POST', '/auth/otp/request', { phone })).status).toBe(202);
    const again = await call(env, null, 'POST', '/auth/otp/request', { phone });
    expect(again.status).toBe(429);
    const hash = env.ctx.cipher.blindIndex(`+81${phone.slice(1)}`);
    await env.ctx.db.query(`UPDATE otp_challenges SET created_at = now() - interval '2 minutes' WHERE phone_hash = $1`, [hash]);
    for (let i = 0; i < 4; i++) {
      expect((await call(env, null, 'POST', '/auth/otp/request', { phone })).status).toBe(202);
      await env.ctx.db.query(`UPDATE otp_challenges SET created_at = created_at - interval '2 minutes' WHERE phone_hash = $1`, [hash]);
    }
    const sixth = await call(env, null, 'POST', '/auth/otp/request', { phone });
    expect(sixth.status).toBe(429);
  });

  it('validates phone format', async () => {
    const r = await call(env, null, 'POST', '/auth/otp/request', { phone: '12345' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('validation');
  });
});

describe('refresh token rotation', () => {
  it('rotates and revokes the family on reuse', async () => {
    const w = await loginWorker(env);
    const r1 = await call(env, null, 'POST', '/auth/refresh', { refreshToken: w.refresh });
    expect(r1.status).toBe(200);
    const reuse = await call(env, null, 'POST', '/auth/refresh', { refreshToken: w.refresh });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('session_revoked');
    const r2 = await call(env, null, 'POST', '/auth/refresh', { refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });

  it('rejects requests without a token', async () => {
    const r = await call(env, null, 'GET', '/me');
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/ログイン/);
  });
});

describe('web login with TOTP MFA', () => {
  it('requires enrollment for new accounts and completes with a valid code', async () => {
    const email = `new-${Date.now()}@example.test`;
    const s = await call(env, null, 'POST', '/auth/web/signup', { email, password: 'long-enough-password', displayName: '担当者' });
    expect(s.status).toBe(201);
    expect(s.body.mfaEnrollmentRequired).toBe(true);
    expect(s.body.totpUri).toMatch(/^otpauth:\/\/totp\//);
    const bad = await call(env, null, 'POST', '/auth/web/mfa/verify', { mfaToken: s.body.mfaToken, code: '000000' });
    expect(bad.status).toBe(401);
    const OTPAuth = await import('otpauth');
    const totp = OTPAuth.URI.parse(s.body.totpUri) as InstanceType<typeof OTPAuth.TOTP>;
    const ok = await call(env, null, 'POST', '/auth/web/mfa/verify', { mfaToken: s.body.mfaToken, code: totp.generate() });
    expect(ok.status).toBe(200);
    // Replaying the same TOTP code is rejected.
    const l = await call(env, null, 'POST', '/auth/web/login', { email, password: 'long-enough-password' });
    expect(l.body.mfaEnrollmentRequired).toBe(false);
    const replay = await call(env, null, 'POST', '/auth/web/mfa/verify', { mfaToken: l.body.mfaToken, code: totp.generate() });
    expect(replay.status).toBe(401);
  });

  it('rejects wrong passwords with a generic message and locks out', async () => {
    const u = await webUser(env);
    for (let i = 0; i < 10; i++) {
      const r = await call(env, null, 'POST', '/auth/web/login', { email: u.email, password: 'wrong-password-xx' });
      expect(r.status).toBe(401);
      expect(r.body.message).toBe('メールアドレスまたはパスワードが正しくありません');
    }
    const locked = await call(env, null, 'POST', '/auth/web/login', { email: u.email, password: 'correct horse battery staple' });
    expect(locked.status).toBe(429);
  });

  it('rejects duplicate signup', async () => {
    const u = await webUser(env);
    const r = await call(env, null, 'POST', '/auth/web/signup', { email: u.email, password: 'long-enough-password', displayName: 'x' });
    expect(r.status).toBe(409);
  });
});

describe('per-IP OTP limit', () => {
  it('limits OTP requests from one IP across phone numbers', async () => {
    const ip = '192.0.2.77';
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await call(env, null, 'POST', '/auth/otp/request', { phone: randomPhone() }, {}, ip)).status;
    expect(last).toBe(429);
  });
});

describe('App Review account', () => {
  it('logs in only the configured number with the fixed code, without sending SMS', async () => {
    const review = await setupApp({ reviewAccount: { phone: '09000000999', code: '246810' } });
    try {
      expect((await call(review, null, 'POST', '/auth/otp/request', { phone: '09000000999' })).status).toBe(202);
      expect(review.sms.codes.size).toBe(0);
      expect((await call(review, null, 'POST', '/auth/otp/verify', { phone: '09000000999', code: '000000' })).status).toBe(401);
      const ok = await call(review, null, 'POST', '/auth/otp/verify', { phone: '09000000999', code: '246810' });
      expect(ok.status).toBe(200);
      // The fixed code does not work for any other number.
      await call(review, null, 'POST', '/auth/otp/request', { phone: '09000000998' });
      expect((await call(review, null, 'POST', '/auth/otp/verify', { phone: '09000000998', code: '246810' })).status).toBe(401);
    } finally {
      await review.close();
    }
  });
});
