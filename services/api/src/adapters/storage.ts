import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';

export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
}

export interface StorageAdapter {
  readonly name: string;
  presignPut(key: string, contentType: string, byteSize: number, ttlSec: number): Promise<PresignedUpload>;
  presignGet(key: string, ttlSec: number): Promise<string>;
  get(key: string): Promise<Buffer | null>;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface LocalToken { k: string; op: 'put' | 'get'; ct?: string; n?: number; exp: number }

/** Filesystem store with HMAC-signed, expiring URLs served by the API itself (development / CI only). */
export class LocalStorage implements StorageAdapter {
  readonly name = 'local';
  private readonly root: string;
  constructor(dir: string, private readonly key: Buffer, private readonly publicBaseUrl: string) {
    this.root = resolve(dir);
  }

  sign(t: LocalToken): string {
    const body = Buffer.from(JSON.stringify(t)).toString('base64url');
    const mac = createHmac('sha256', this.key).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verify(token: string, op: 'put' | 'get'): LocalToken | null {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', this.key).update(body).digest('base64url');
    if (!safeEqual(mac, expected)) return null;
    const t = JSON.parse(Buffer.from(body, 'base64url').toString()) as LocalToken;
    if (t.op !== op || t.exp < Date.now()) return null;
    return t;
  }

  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error('invalid key');
    return p;
  }

  async presignPut(key: string, contentType: string, byteSize: number, ttlSec: number) {
    const token = this.sign({ k: key, op: 'put', ct: contentType, n: byteSize, exp: Date.now() + ttlSec * 1000 });
    return { url: `${this.publicBaseUrl}/v1/evidence-blobs/${token}`, headers: { 'Content-Type': contentType } };
  }
  async presignGet(key: string, ttlSec: number) {
    return `${this.publicBaseUrl}/v1/evidence-blobs/${this.sign({ k: key, op: 'get', exp: Date.now() + ttlSec * 1000 })}`;
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async delete(key: string) {
    await unlink(this.path(key)).catch(() => undefined);
  }
}

/** Any S3-compatible object store (server-side encryption requested on every write). */
export class S3Storage implements StorageAdapter {
  readonly name = 's3';
  private readonly s3: S3Client;
  constructor(private readonly bucket: string, region: string, endpoint: string | undefined, forcePathStyle: boolean) {
    this.s3 = new S3Client({ region, endpoint, forcePathStyle });
  }
  async presignPut(key: string, contentType: string, byteSize: number, ttlSec: number) {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: byteSize, ServerSideEncryption: 'AES256' });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: ttlSec });
    return { url, headers: { 'Content-Type': contentType, 'x-amz-server-side-encryption': 'AES256' } };
  }
  async presignGet(key: string, ttlSec: number) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSec });
  }
  async get(key: string) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
  async put(key: string, data: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createStorage(cfg: Config): StorageAdapter {
  const s = cfg.storage;
  return s.provider === 's3'
    ? new S3Storage(s.bucket, s.region, s.endpoint, s.forcePathStyle)
    : new LocalStorage(s.dir, s.signingKey, cfg.publicBaseUrl);
}
