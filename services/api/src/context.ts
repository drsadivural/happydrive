import type pg from 'pg';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { FieldCipher } from './lib/crypto.js';
import type { StorageAdapter } from './adapters/storage.js';
import type { SmsAdapter } from './adapters/sms.js';
import type { PayoutProvider } from './adapters/payouts.js';

export interface AppContext {
  cfg: Config;
  db: pg.Pool;
  cipher: FieldCipher;
  storage: StorageAdapter;
  sms: SmsAdapter;
  payouts: PayoutProvider;
  log: FastifyBaseLogger;
}

export type Role = 'worker' | 'org_member' | 'admin_operator' | 'admin_support' | 'admin_auditor';

export interface AuthUser {
  id: string;
  displayName: string;
  roles: Role[];
  verificationStatus: 'unsubmitted' | 'pending' | 'verified' | 'rejected';
  suspended: boolean;
  isWebUser: boolean;
}

export interface HdRequest extends FastifyRequest {
  user?: AuthUser;
}

export type Handler = (ctx: AppContext, req: HdRequest, reply: FastifyReply) => Promise<unknown>;
export type HandlerMap = Record<string, Handler>;

export function requireUser(req: HdRequest): AuthUser {
  if (!req.user) throw new Error('auth middleware missing');
  return req.user;
}

export const params = <T = Record<string, string>>(req: HdRequest) => req.params as T;
export const query = <T = Record<string, unknown>>(req: HdRequest) => req.query as T;
export const body = <T = Record<string, unknown>>(req: HdRequest) => (req.body ?? {}) as T;
