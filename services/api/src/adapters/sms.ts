import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { unavailable } from '../lib/errors.js';

export interface SmsAdapter {
  readonly name: string;
  sendOtp(phoneE164: string, code: string): Promise<void>;
}

/**
 * Development-only: writes the OTP to the server log instead of sending an SMS.
 * config.ts refuses this provider in staging/production.
 */
class ConsoleSms implements SmsAdapter {
  readonly name = 'console';
  constructor(private readonly log: FastifyBaseLogger) {}
  async sendOtp(phoneE164: string, code: string) {
    this.log.warn({ devOtp: code, phoneSuffix: phoneE164.slice(-4) }, '[DEV ONLY] OTP code (SMS not sent)');
  }
}

/** No contracted SMS provider: OTP login is unavailable (except the configured App Review account). */
class DisabledSms implements SmsAdapter {
  readonly name = 'none';
  async sendOtp(): Promise<void> {
    throw unavailable('sms_unavailable', '現在SMSを送信できません。しばらくしてから再度お試しください');
  }
}

export function createSms(cfg: Config, log: FastifyBaseLogger): SmsAdapter {
  return cfg.sms.provider === 'console' ? new ConsoleSms(log) : new DisabledSms();
}
