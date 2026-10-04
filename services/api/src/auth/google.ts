import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { unauthorized } from '../lib/errors.js';

const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 10_000 });
export type GoogleVerifier = (token: string, audience: string) => Promise<JWTPayload>;
export const createGoogleVerifier = (keySet: JWTVerifyGetKey): GoogleVerifier => async (token, audience) => {
  try {
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'], audience,
      requiredClaims: ['sub', 'iat', 'exp', 'nonce', 'email', 'email_verified'], maxTokenAge: '10m', clockTolerance: 5,
    });
    if (payload.azp && payload.azp !== audience) throw new Error('unexpected authorized party');
    return payload;
  } catch {
    throw unauthorized('Googleの確認ができませんでした。もう一度ログインしてください', 'google_token_invalid');
  }
};

export const verifyGoogleToken = createGoogleVerifier(keys);
