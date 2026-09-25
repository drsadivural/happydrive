import { connect, type ClientHttp2Session } from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import type { Config } from '../config.js';

export interface PushMessage { title: string; body: string; data?: Record<string, string> }
export type PushResult = 'sent' | 'invalid_token' | 'retry' | 'disabled';

/** Token-based APNs HTTP/2 client. Without APNS_* configuration, pushes are skipped and in-app notifications remain. */
export class ApnsClient {
  private jwt?: { token: string; iat: number };
  private sessions = new Map<string, ClientHttp2Session>();
  constructor(private readonly cfg: NonNullable<Config['apns']> | undefined) {}

  get enabled() {
    return !!this.cfg;
  }

  private async bearer(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.jwt && nowSec - this.jwt.iat < 50 * 60) return this.jwt.token;
    const key = await importPKCS8(this.cfg!.privateKeyPem, 'ES256');
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: this.cfg!.keyId }).setIssuer(this.cfg!.teamId).setIssuedAt(nowSec).sign(key);
    this.jwt = { token, iat: nowSec };
    return token;
  }

  private session(env: 'sandbox' | 'production'): ClientHttp2Session {
    const host = env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    let s = this.sessions.get(host);
    if (!s || s.closed || s.destroyed) {
      s = connect(host);
      s.on('error', () => this.sessions.delete(host));
      this.sessions.set(host, s);
    }
    return s;
  }

  async send(deviceToken: string, env: 'sandbox' | 'production', msg: PushMessage): Promise<PushResult> {
    if (!this.cfg) return 'disabled';
    const payload = JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' }, ...(msg.data ?? {}) });
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${await this.bearer()}`,
      'apns-topic': this.cfg.bundleId,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
    };
    return new Promise<PushResult>((resolve) => {
      const req = this.session(env).request(headers);
      req.setTimeout(10_000, () => {
        req.close();
        resolve('retry');
      });
      req.on('response', (h) => {
        const status = Number(h[':status']);
        req.resume();
        req.on('end', () => resolve(status === 200 ? 'sent' : status === 410 || status === 400 ? 'invalid_token' : 'retry'));
      });
      req.on('error', () => resolve('retry'));
      req.end(payload);
    });
  }

  close() {
    for (const s of this.sessions.values()) s.close();
  }
}
