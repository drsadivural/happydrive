import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const VERSION = 1;

/** AES-256-GCM field encryption: [version(1) | iv(12) | tag(16) | ciphertext]. */
export class FieldCipher {
  constructor(private readonly key: Buffer, private readonly hmacKey: Buffer) {}

  encrypt(plain: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
  }

  encryptNullable(plain: string | null | undefined): Buffer | null {
    return plain === null || plain === undefined || plain === '' ? null : this.encrypt(plain);
  }

  decrypt(buf: Buffer): string {
    if (buf[0] !== VERSION) throw new Error('unsupported ciphertext version');
    const iv = buf.subarray(1, 13);
    const tag = buf.subarray(13, 29);
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(buf.subarray(29)), d.final()]).toString('utf8');
  }

  decryptNullable(buf: Buffer | null | undefined): string | undefined {
    return buf ? this.decrypt(buf) : undefined;
  }

  encryptJson(v: unknown): Buffer {
    return this.encrypt(JSON.stringify(v));
  }

  decryptJson<T>(buf: Buffer | null | undefined): T | undefined {
    return buf ? (JSON.parse(this.decrypt(buf)) as T) : undefined;
  }

  /** Deterministic blind index for equality lookups (phone numbers, normalised addresses). */
  blindIndex(value: string): Buffer {
    return createHmac('sha256', this.hmacKey).update(value).digest();
  }
}

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest();
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(pw, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$15$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, logN, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !logN || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const dk = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length, {
    N: 1 << Number(logN), r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  return safeEqual(dk, expected);
}

/** Stable JSON for hashing: keys sorted recursively. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
