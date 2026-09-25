'use client';
import { api, unwrap } from './api';

/** 証跡の署名URL（有効期限付き）を必要時に取得 */
export async function evidenceUrl(id: string): Promise<string> {
  const r = await unwrap(api.GET('/evidence/{evidenceId}/url', { params: { path: { evidenceId: id } } }));
  return r.url;
}
