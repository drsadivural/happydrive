import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { createGoogleVerifier } from '../src/auth/google.js';
export const googleConfig = {webClientId:'happy-web.apps.googleusercontent.com',iosClientId:'happy-ios.apps.googleusercontent.com'};
export async function googleFixture() {
  const keys = await generateKeyPair('RS256');
  const pub = await exportJWK(keys.publicKey); pub.kid = 'test-google';
  const verifier = createGoogleVerifier(createLocalJWKSet({keys:[pub]}));
  const identity = () => ({sub:randomUUID(),email:`${randomUUID()}@gmail.com`,email_verified:true,name:'Google 利用者'});
  const sign = (nonce:string,claims:Record<string,unknown> = identity(),audience = googleConfig.webClientId) => new SignJWT({...claims,nonce})
    .setProtectedHeader({alg:'RS256',kid:'test-google'}).setIssuer('https://accounts.google.com').setAudience(audience)
    .setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  return {verifier,sign,identity,keys};
}
