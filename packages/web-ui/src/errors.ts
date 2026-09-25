/** API（および BFF）が返す Error スキーマを表す例外。message は利用者に表示できる日本語。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, requestId?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }

  /** 結果が不明（通信断・タイムアウト・5xx）で、同じ Idempotency-Key で再送すべき失敗か */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

const FALLBACK_BY_STATUS: Record<number, string> = {
  0: 'サーバーに接続できませんでした。通信環境を確認して再試行してください。',
  400: 'リクエストが正しくありません。',
  401: 'ログインの有効期限が切れました。再度ログインしてください。',
  403: 'この操作を行う権限がありません。',
  404: '対象が見つかりません。削除されたか、閲覧権限がありません。',
  409: '状態が変更されたため操作できませんでした。画面を再読み込みしてください。',
  410: '保管期限を過ぎたため表示できません。',
  422: '入力内容に誤りがあります。',
  429: '操作が集中しています。しばらく待ってから再試行してください。',
  502: 'サーバーに接続できませんでした。しばらくしてから再試行してください。',
  503: '現在この機能は利用できません。',
};

export function fallbackMessage(status: number): string {
  return FALLBACK_BY_STATUS[status] ?? (status >= 500 ? 'サーバーでエラーが発生しました。しばらくしてから再試行してください。' : 'エラーが発生しました。');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 任意の応答ボディから ApiError を組み立てる（Error スキーマでなければ状態コード別の既定文言）。 */
export function toApiError(status: number, body: unknown): ApiError {
  if (isRecord(body)) {
    const code = typeof body.code === 'string' ? body.code : `http_${status}`;
    const message = typeof body.message === 'string' && body.message.trim() ? body.message : fallbackMessage(status);
    const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
    const details = isRecord(body.details) ? body.details : undefined;
    return new ApiError(status, code, message, requestId, details);
  }
  return new ApiError(status, `http_${status}`, fallbackMessage(status));
}

/** 画面表示用のメッセージ。409/422 などは API の message をそのまま表示する。 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.requestId ? `${err.message}（問い合わせ番号: ${err.requestId}）` : err.message;
  }
  if (err instanceof Error && err.name === 'AbortError') return '処理がタイムアウトしました。再試行してください。';
  return fallbackMessage(0);
}
