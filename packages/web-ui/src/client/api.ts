/**
 * ブラウザ側 API クライアント。全リクエストは同一オリジンの BFF（/api/hd/...）経由で、
 * トークンはブラウザに渡らない。変更系には CSRF ヘッダーを付与する。
 */
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths } from '@happydrive/contracts';
import { ApiError, fallbackMessage, toApiError } from '../errors';

export const API_PROXY_BASE = '/api/hd';
export const CSRF_HEADER = 'x-hd-csrf';

export type HdClient = Client<paths>;

export function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** 本番は `__Host-` 付き、開発は接頭辞なし */
export function readCsrfToken(cookiePrefix: string): string | undefined {
  return readCookie(`__Host-${cookiePrefix}_csrf`) ?? readCookie(`${cookiePrefix}_csrf`);
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ApiClientOptions {
  cookiePrefix: string;
  /** BFF が 401（セッション切れ）を返したとき */
  onUnauthorized?: () => void;
}

export function createApiClient(options: ApiClientOptions): HdClient {
  const client = createClient<paths>({ baseUrl: API_PROXY_BASE, credentials: 'same-origin' });
  const mw: Middleware = {
    onRequest({ request }) {
      if (MUTATING.has(request.method.toUpperCase())) {
        const token = readCsrfToken(options.cookiePrefix);
        if (token) request.headers.set(CSRF_HEADER, token);
      }
      return request;
    },
    onResponse({ response }) {
      if (response.status === 401) options.onUnauthorized?.();
      return response;
    },
  };
  client.use(mw);
  return client;
}

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * openapi-fetch の結果を「成功なら data、失敗なら ApiError を throw」に変換する。
 * 通信断は status=0 の ApiError。
 */
export async function unwrap<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await promise;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, 'network_error', fallbackMessage(0));
  }
  if (result.response.ok) return result.data as T;
  throw toApiError(result.response.status, result.error);
}

/** 認証系 BFF（/api/auth/*）への JSON POST */
export async function postAuth<T>(cookiePrefix: string, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        [CSRF_HEADER]: readCsrfToken(cookiePrefix) ?? '',
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, 'network_error', fallbackMessage(0));
  }
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, json);
  return json as T;
}
