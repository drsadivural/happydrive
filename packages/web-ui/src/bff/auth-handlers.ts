/**
 * ログイン系の Route Handler（BFF）。トークンはレスポンスボディに含めず httpOnly Cookie にのみ保存する。
 * - POST /api/auth/login   {email,password}           → MFA チャレンジ（mfaToken は httpOnly Cookie、5分）
 * - POST /api/auth/signup  {email,password,displayName}（企業ポータルのみ）
 * - POST /api/auth/mfa     {code}                      → セッション Cookie 発行
 * - POST /api/auth/logout                              → API でリフレッシュトークン失効 + Cookie 削除
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { components } from '@happydrive/contracts';
import { applyCookies, errorResponse, jsonResponse, UPSTREAM_UNREACHABLE_MESSAGE, verifyCsrf } from './http';
import { apiBaseUrl, clearedSessionCookies, cookieNames, mfaCookie, sessionCookies, type SessionConfig } from './session';

type Role = components['schemas']['Role'];
type WebLoginChallenge = components['schemas']['WebLoginChallenge'];
type AuthResult = components['schemas']['AuthResult'];

export interface AuthHandlerOptions {
  session: SessionConfig;
  apiBase?: string;
  /** 指定時はこのいずれかのロールを持つ利用者のみセッションを発行（運営Web） */
  requiredRoles?: readonly Role[];
  requiredRolesMessage?: string;
}

async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function callApi(apiBase: string, path: string, body: unknown, bearer?: string): Promise<Response | null> {
  try {
    return await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-language': 'ja',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
}

async function passThroughError(res: Response): Promise<Response> {
  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === 'object' && 'message' in body) return jsonResponse(res.status, body);
  return errorResponse(res.status, `http_${res.status}`, res.status === 401 ? 'メールアドレスまたはパスワードが正しくありません。' : 'ログインできませんでした。');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function hasAnyRole(roles: readonly string[] | undefined, required: readonly string[]): boolean {
  return !!roles && roles.some((r) => required.includes(r));
}

export function createAuthHandlers(options: AuthHandlerOptions) {
  const apiBase = options.apiBase ?? apiBaseUrl();
  const cfg = options.session;
  const names = cookieNames(cfg);

  async function challengeResponse(upstream: Response | null, successStatus: number): Promise<Response> {
    if (!upstream) return errorResponse(502, 'upstream_unreachable', UPSTREAM_UNREACHABLE_MESSAGE);
    if (!upstream.ok) return passThroughError(upstream);
    const challenge = (await upstream.json().catch(() => null)) as WebLoginChallenge | null;
    if (!challenge || typeof challenge.mfaToken !== 'string') {
      return errorResponse(502, 'invalid_upstream_response', 'サーバーの応答が不正です。');
    }
    const res = jsonResponse(successStatus, {
      mfaEnrollmentRequired: !!challenge.mfaEnrollmentRequired,
      totpUri: challenge.mfaEnrollmentRequired ? challenge.totpUri ?? null : null,
    });
    applyCookies(res, [mfaCookie(cfg, challenge.mfaToken)]);
    return res;
  }

  async function login(req: NextRequest): Promise<Response> {
    const csrf = verifyCsrf(req, cfg);
    if (csrf) return csrf;
    const body = await readJson(req);
    const email = str(body?.email).trim();
    const password = str(body?.password);
    if (!email || !password || email.length > 254 || password.length > 200) {
      return errorResponse(422, 'validation_error', 'メールアドレスとパスワードを入力してください。');
    }
    return challengeResponse(await callApi(apiBase, '/auth/web/login', { email, password }), 200);
  }

  async function signup(req: NextRequest): Promise<Response> {
    const csrf = verifyCsrf(req, cfg);
    if (csrf) return csrf;
    const body = await readJson(req);
    const email = str(body?.email).trim();
    const password = str(body?.password);
    const displayName = str(body?.displayName).trim();
    if (!email || email.length > 254 || password.length < 12 || password.length > 200 || !displayName || displayName.length > 60) {
      return errorResponse(422, 'validation_error', '入力内容を確認してください（パスワードは12文字以上）。');
    }
    return challengeResponse(await callApi(apiBase, '/auth/web/signup', { email, password, displayName }), 201);
  }

  async function mfa(req: NextRequest): Promise<Response> {
    const csrf = verifyCsrf(req, cfg);
    if (csrf) return csrf;
    const mfaToken = req.cookies.get(names.mfa)?.value;
    if (!mfaToken) return errorResponse(401, 'mfa_expired', '確認の有効期限が切れました。もう一度ログインしてください。');
    const body = await readJson(req);
    const code = str(body?.code).trim();
    if (!/^[0-9]{6}$/.test(code)) return errorResponse(422, 'validation_error', '6桁の確認コードを入力してください。');

    const upstream = await callApi(apiBase, '/auth/web/mfa/verify', { mfaToken, code });
    if (!upstream) return errorResponse(502, 'upstream_unreachable', UPSTREAM_UNREACHABLE_MESSAGE);
    if (!upstream.ok) {
      if (upstream.status === 401) return errorResponse(401, 'invalid_code', '確認コードが正しくないか、有効期限が切れています。');
      return passThroughError(upstream);
    }
    const result = (await upstream.json().catch(() => null)) as AuthResult | null;
    if (!result?.tokens?.accessToken || !result.tokens.refreshToken) {
      return errorResponse(502, 'invalid_upstream_response', 'サーバーの応答が不正です。');
    }
    if (options.requiredRoles && !hasAnyRole(result.user?.roles, options.requiredRoles)) {
      // 権限の無い利用者にはセッションを発行せず、発行済みトークンは失効させる
      await callApi(apiBase, '/auth/logout', { refreshToken: result.tokens.refreshToken }, result.tokens.accessToken);
      const res = errorResponse(403, 'role_required', options.requiredRolesMessage ?? 'この画面を利用する権限がありません。');
      applyCookies(res, clearedSessionCookies(cfg));
      return res;
    }
    const res = jsonResponse(200, {
      user: { displayName: result.user.displayName, roles: result.user.roles ?? [] },
    });
    applyCookies(res, [...clearedSessionCookies(cfg).filter((c) => c.name === names.mfa), ...sessionCookies(cfg, result.tokens)]);
    return res;
  }

  async function logout(req: NextRequest): Promise<Response> {
    const csrf = verifyCsrf(req, cfg);
    if (csrf) return csrf;
    const refreshToken = req.cookies.get(names.refresh)?.value;
    const accessToken = req.cookies.get(names.access)?.value;
    if (refreshToken) {
      // 失効に失敗しても Cookie は削除する（リフレッシュトークンは期限で失効）
      await callApi(apiBase, '/auth/logout', { refreshToken }, accessToken);
    }
    const out = new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    applyCookies(out, [...clearedSessionCookies(cfg), googleCookie('',0)]);
    return out;
  }

  async function otpRequest(req: NextRequest): Promise<Response> {
    const csrf = verifyCsrf(req, cfg);
    if (csrf) return csrf;
    const body = await readJson(req);
    const phone = str(body?.phone).trim();
    if (!/^(\+81|0)[0-9]{9,10}$/.test(phone)) return errorResponse(422, 'validation_error', '日本の電話番号を入力してください。');
    const upstream = await callApi(apiBase, '/auth/otp/request', { phone });
    if (!upstream) return errorResponse(502, 'upstream_unreachable', UPSTREAM_UNREACHABLE_MESSAGE);
    if (!upstream.ok) return passThroughError(upstream);
    return jsonResponse(202, await upstream.json());
  }

  async function otpVerify(req: NextRequest, link = false): Promise<Response> {
    const csrf = verifyCsrf(req, cfg);
    if (csrf) return csrf;
    // OTP login must never bypass an admin application's required MFA and roles.
    if (options.requiredRoles) return errorResponse(403, 'role_required', '管理者は多要素認証でログインしてください。');
    const body = await readJson(req);
    const phone = str(body?.phone).trim();
    const code = str(body?.code).trim();
    if (!/^(\+81|0)[0-9]{9,10}$/.test(phone) || !/^[0-9]{6}$/.test(code)) return errorResponse(422, 'validation_error', '電話番号と6桁の確認コードを入力してください。');
    const access = link ? req.cookies.get(names.access)?.value : undefined;
    if (link && !access) return errorResponse(401, 'session_expired', 'もう一度ログインしてください。');
    const upstream = await callApi(apiBase, link ? '/auth/phone/link' : '/auth/otp/verify', { phone, code, deviceName: 'HappyDrive Web' }, access);
    if (!upstream) return errorResponse(502, 'upstream_unreachable', UPSTREAM_UNREACHABLE_MESSAGE);
    if (!upstream.ok) return passThroughError(upstream);
    const result = await upstream.json() as AuthResult;
    if (!result?.tokens?.accessToken || !result.tokens.refreshToken) return errorResponse(502, 'invalid_upstream_response', 'サーバーの応答が不正です。');
    const response = jsonResponse(200, { user: { displayName: result.user.displayName } });
    applyCookies(response, [...sessionCookies(cfg, result.tokens), {...mfaCookie(cfg,''),maxAge:0}]);
    return response;
  }

  const googleCookieName = `${names.mfa}_google`;
  const googleCookie = (value: string, maxAge = 300) => ({name: googleCookieName, value, maxAge, httpOnly: true, secure: cfg.secure, sameSite: 'strict' as const, path: '/' as const});

  async function googleChallenge(req: NextRequest): Promise<Response> {
    const csrf = verifyCsrf(req, cfg); if (csrf) return csrf;
    if (options.requiredRoles) return errorResponse(403, 'role_required', '管理者は多要素認証でログインしてください。');
    const body = await readJson(req);
    const link = body?.link === true;
    const access = link ? req.cookies.get(names.access)?.value : undefined;
    if (link && !access) return errorResponse(401, 'session_expired', 'もう一度ログインしてください。');
    const upstream = await callApi(apiBase, link ? '/auth/google/link/challenge' : '/auth/google/challenge', {platform:'web'}, access);
    if (!upstream) return errorResponse(502, 'upstream_unreachable', UPSTREAM_UNREACHABLE_MESSAGE);
    if (!upstream.ok) return passThroughError(upstream);
    const data = await upstream.json() as {challengeId:string;nonce:string;clientId:string;expiresAt:string};
    if (!data?.challengeId || !data.nonce || !data.clientId) return errorResponse(502, 'invalid_upstream_response', 'サーバーの応答が不正です。');
    const out = jsonResponse(200, {nonce:data.nonce,clientId:data.clientId,expiresAt:data.expiresAt});
    applyCookies(out,[googleCookie(`${link ? 'link' : 'login'}:${data.challengeId}`)]);
    return out;
  }

  async function googleVerify(req: NextRequest): Promise<Response> {
    const csrf = verifyCsrf(req, cfg); if (csrf) return csrf;
    if (options.requiredRoles) return errorResponse(403, 'role_required', '管理者は多要素認証でログインしてください。');
    const saved = req.cookies.get(googleCookieName)?.value;
    if (!saved || !/^(login|link):[a-f0-9-]{36}$/.test(saved)) return errorResponse(401, 'google_challenge_invalid', 'Googleログインをもう一度お試しください。');
    const [intent,challengeId] = saved.split(':');
    const body = await readJson(req); const idToken = str(body?.idToken);
    if (idToken.length < 20 || idToken.length > 16000) return errorResponse(422, 'validation_error', 'Googleアカウントを確認してください。');
    const access = intent === 'link' ? req.cookies.get(names.access)?.value : undefined;
    if (intent === 'link' && !access) return errorResponse(401, 'session_expired', 'もう一度ログインしてください。');
    const upstream = await callApi(apiBase, intent === 'link' ? '/auth/google/link' : '/auth/google/verify', {challengeId,idToken,deviceName:'HappyDrive Web'}, access);
    if (!upstream) return errorResponse(502, 'upstream_unreachable', UPSTREAM_UNREACHABLE_MESSAGE);
    if (!upstream.ok) return passThroughError(upstream);
    if (upstream.status === 202) {
      const challenge = await upstream.json() as WebLoginChallenge;
      if (!challenge?.mfaToken || challenge.mfaEnrollmentRequired) return errorResponse(502, 'invalid_upstream_response', 'サーバーの応答が不正です。');
      const out = jsonResponse(202,{mfaRequired:true});
      applyCookies(out,[mfaCookie(cfg,challenge.mfaToken),googleCookie('',0)]);
      return out;
    }
    const result = await upstream.json() as AuthResult;
    if (!result?.tokens?.accessToken || !result.tokens.refreshToken) return errorResponse(502, 'invalid_upstream_response', 'サーバーの応答が不正です。');
    const out = jsonResponse(200,{user:{displayName:result.user.displayName}});
    applyCookies(out,[...sessionCookies(cfg,result.tokens),{...mfaCookie(cfg,''),maxAge:0},googleCookie('',0)]);
    return out;
  }

  return { login, signup, mfa, logout, otpRequest, otpVerify:(req:NextRequest)=>otpVerify(req,false), phoneLink:(req:NextRequest)=>otpVerify(req,true), googleChallenge, googleVerify };
}
