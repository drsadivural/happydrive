import { randomUUID } from 'node:crypto';
import type { AppContext, AuthUser, HandlerMap } from '../context.js';
import { body, params, requireUser } from '../context.js';
import type { Client } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { LocalStorage } from '../adapters/storage.js';
import { sha256Hex } from '../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { recordEvent } from '../lib/events.js';
import { withIdempotency } from '../lib/idempotency.js';
import { sniffImage, stripMetadata, type ImageType } from '../lib/images.js';
import { isAdmin } from '../auth/rbac.js';

const UPLOAD_TTL_SEC = 600;
const DOWNLOAD_TTL_SEC = 300;
/** Retention per purpose (days). Documented in docs/DATA_RETENTION.md. */
export const RETENTION_DAYS: Record<string, number> = {
  work_photo: 365,
  delivery_photo: 90,
  signature: 90,
  message_attachment: 365,
  identity_document: 365 * 3,
  skill_document: 365 * 3,
};
const WORKER_ACTIVE_STATES = ['accepted', 'traveling', 'checked_in', 'working', 'submitted', 'needs_revision'];

export function evidenceView(e: any) {
  return { id: e.id, purpose: e.purpose, status: e.status, contentType: e.mime_type, byteSize: e.byte_size, createdAt: e.created_at, expiresAt: e.expires_at };
}

/** Who may view an evidence object: uploader, the assignment's organisation, the stop owner, and operators (support for non-identity). */
export async function canViewEvidence(c: Client, u: AuthUser, e: any): Promise<boolean> {
  if (e.uploaded_by === u.id) return true;
  if (u.roles.includes('admin_operator')) return true;
  if (isAdmin(u) && !['identity_document'].includes(e.purpose)) return true;
  if (e.assignment_id) {
    const r = await c.query(
      `SELECT 1 FROM assignments a JOIN jobs j ON j.id = a.job_id JOIN organization_members m ON m.org_id = j.org_id AND m.user_id = $2
       WHERE a.id = $1`,
      [e.assignment_id, u.id],
    );
    if (r.rowCount) return true;
    const w = await c.query('SELECT 1 FROM assignments WHERE id = $1 AND worker_id = $2', [e.assignment_id, u.id]);
    return !!w.rowCount;
  }
  return false;
}

export const evidenceHandlers: HandlerMap = {
  async createEvidenceUpload(ctx, req, reply) {
    const u = requireUser(req);
    const b = body<{ assignmentId?: string; deliveryStopId?: string; purpose?: string; contentType: ImageType; byteSize: number; sha256: string }>(req);
    if (b.assignmentId && b.deliveryStopId) throw badRequest('validation', '業務と配送先の両方は指定できません');
    const res = await withIdempotency(ctx, req, 'createEvidenceUpload', async (c) => {
      let purpose = b.purpose;
      if (b.assignmentId) {
        purpose ??= 'work_photo';
        if (!['work_photo', 'message_attachment'].includes(purpose)) throw badRequest('validation', '用途が正しくありません');
        const a = (await c.query(
          `SELECT a.worker_id, a.state, j.org_id FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.id = $1`, [b.assignmentId],
        )).rows[0];
        if (!a) throw notFound();
        const isWorker = a.worker_id === u.id;
        const isOrg = !isWorker && !!(await c.query('SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2', [a.org_id, u.id])).rowCount;
        if (!isWorker && !isOrg) throw notFound();
        if (purpose === 'work_photo' && (!isWorker || !WORKER_ACTIVE_STATES.includes(a.state))) throw forbidden('この業務には写真を追加できません');
      } else if (b.deliveryStopId) {
        purpose ??= 'delivery_photo';
        if (!['delivery_photo', 'signature'].includes(purpose)) throw badRequest('validation', '用途が正しくありません');
        const s = await c.query('SELECT 1 FROM delivery_stops WHERE id = $1 AND worker_id = $2 AND deleted_at IS NULL', [b.deliveryStopId, u.id]);
        if (!s.rowCount) throw notFound();
      } else {
        if (!purpose || !['identity_document', 'skill_document'].includes(purpose)) throw badRequest('validation', '用途を指定してください');
      }
      const id = randomUUID();
      const now = new Date();
      const key = `evidence/${purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
      const expiresAt = new Date(Date.now() + RETENTION_DAYS[purpose]! * 86_400_000);
      await c.query(
        `INSERT INTO evidence(id, assignment_id, delivery_stop_id, purpose, object_key, sha256, mime_type, byte_size, uploaded_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, b.assignmentId ?? null, b.deliveryStopId ?? null, purpose, key, b.sha256, b.contentType, b.byteSize, u.id, expiresAt],
      );
      const up = await ctx.storage.presignPut(key, b.contentType, b.byteSize, UPLOAD_TTL_SEC);
      return {
        status: 201,
        body: { evidenceId: id, uploadUrl: up.url, uploadMethod: 'PUT', uploadHeaders: up.headers, expiresAt: new Date(Date.now() + UPLOAD_TTL_SEC * 1000).toISOString() },
      };
    });
    reply.code(res.status);
    return res.body;
  },

  async completeEvidenceUpload(ctx, req) {
    const u = requireUser(req);
    const id = params(req).evidenceId!;
    const e = (await ctx.db.query('SELECT * FROM evidence WHERE id = $1 AND uploaded_by = $2 AND deleted_at IS NULL', [id, u.id])).rows[0];
    if (!e) throw notFound();
    if (e.status === 'verified') return evidenceView(e);
    if (e.status === 'rejected') throw badRequest('evidence_rejected', 'この画像は受け付けられませんでした。撮り直してください');
    const data = await ctx.storage.get(e.object_key);
    if (!data) throw badRequest('upload_missing', 'アップロードが完了していません');
    const reject = async (msg: string) => {
      await ctx.db.query(`UPDATE evidence SET status = 'rejected' WHERE id = $1`, [id]);
      await ctx.storage.delete(e.object_key);
      throw badRequest('evidence_rejected', msg);
    };
    if (data.length !== e.byte_size) return reject('ファイルサイズが一致しません');
    if (sha256Hex(data) !== e.sha256) return reject('ファイルが破損しています（ハッシュ不一致）');
    const sniffed = sniffImage(data);
    if (!sniffed || sniffed !== e.mime_type) return reject('JPEGまたはPNG画像のみアップロードできます');
    let clean: Buffer;
    try {
      clean = stripMetadata(data, sniffed);
    } catch {
      return reject('画像を読み取れませんでした');
    }
    if (!clean.equals(data)) await ctx.storage.put(e.object_key, clean, sniffed);
    const r = await withTx(ctx.db, async (c) => {
      const upd = await c.query(`UPDATE evidence SET status = 'verified', stored_sha256 = $2 WHERE id = $1 RETURNING *`, [id, sha256Hex(clean)]);
      await recordEvent(c, { entityType: 'evidence', entityId: id, eventType: 'evidence_verified', actor: { id: u.id, role: 'self' }, payload: { purpose: e.purpose, metadataStripped: !clean.equals(data) } });
      return upd.rows[0];
    });
    return evidenceView(r);
  },

  async getEvidenceDownloadUrl(ctx, req) {
    const u = requireUser(req);
    const id = params(req).evidenceId!;
    const e = (await ctx.db.query(`SELECT * FROM evidence WHERE id = $1 AND deleted_at IS NULL AND status = 'verified' AND expires_at > now()`, [id])).rows[0];
    if (!e || !(await canViewEvidence(ctx.db, u, e))) throw notFound();
    const url = await ctx.storage.presignGet(e.object_key, DOWNLOAD_TTL_SEC);
    await withTx(ctx.db, (c) => recordEvent(c, { entityType: 'evidence', entityId: id, eventType: 'evidence_accessed', actor: { id: u.id, role: u.roles.join(',') } }));
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SEC * 1000).toISOString() };
  },

  async uploadEvidenceBlobLocal(ctx, req, reply) {
    const store = localStore(ctx);
    const t = store.verify(params(req).token!, 'put');
    if (!t) throw forbidden('アップロードURLが無効または期限切れです');
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data)) throw badRequest('validation', '画像データが必要です');
    if (req.headers['content-type'] !== t.ct) throw badRequest('validation', 'Content-Type が一致しません');
    if (data.length !== t.n) throw badRequest('validation', 'サイズが一致しません');
    await store.put(t.k, data);
    reply.code(204);
  },

  async downloadEvidenceBlobLocal(ctx, req, reply) {
    const store = localStore(ctx);
    const t = store.verify(params(req).token!, 'get');
    if (!t) throw forbidden('URLが無効または期限切れです');
    const e = (await ctx.db.query('SELECT mime_type FROM evidence WHERE object_key = $1 AND deleted_at IS NULL', [t.k])).rows[0];
    const data = await store.get(t.k);
    if (!e || !data) throw notFound();
    reply.header('content-type', e.mime_type).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff');
    return data;
  },
};

function localStore(ctx: AppContext): LocalStorage {
  if (!(ctx.storage instanceof LocalStorage)) throw notFound();
  return ctx.storage;
}
