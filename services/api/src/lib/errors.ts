// Domain errors map to the contract's Error schema. `message` is always user-presentable Japanese.
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(422, code, message, details);
export const unauthorized = (message = 'ログインが必要です', code = 'unauthorized') => new AppError(401, code, message);
export const forbidden = (message = 'この操作を行う権限がありません', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (message = '見つかりません') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(409, code, message, details);
export const gone = (message: string) => new AppError(410, 'gone', message);
export const tooMany = (message: string, details?: Record<string, unknown>) =>
  new AppError(429, 'rate_limited', message, details);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);
