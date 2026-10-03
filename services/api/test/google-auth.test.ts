import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { setupApp, call, asSession, loginWorker, randomIp, webUser, type TestEnv } from './helpers.js';
import { googleConfig, googleFixture } from './google-fixture.js';
let env:TestEnv;let google:Awaited<ReturnType<typeof googleFixture>>;
beforeAll(async()=>{google=await googleFixture();env=await setupApp({google:googleConfig},google.verifier);});
afterAll(async()=>env.close());
async function login(claims=google.identity(),platform:'web'|'ios'='web') {
  const ch=await call(env,null,'POST','/auth/google/challenge',{platform},{},randomIp());
  const idToken=await google.sign(ch.body.nonce,claims,platform==='ios'?googleConfig.iosClientId:googleConfig.webClientId);
  return {ch,idToken,res:await call(env,null,'POST','/auth/google/verify',{challengeId:ch.body.challengeId,idToken})};
}
describe('Google authentication',()=>{
  it('web and iOS identify the same Google subject; cannot replay; keeps only blinded subject',async()=>{
    const claims=google.identity();const first=await login(claims);expect(first.res.status).toBe(200);expect(first.res.body.isNewUser).toBe(true);
    const second=await login(claims,'ios');expect(second.res.status).toBe(200);expect(second.res.body.user.id).toBe(first.res.body.user.id);expect(second.res.body.isNewUser).toBe(false);
    expect((await call(env,null,'POST','/auth/google/verify',{challengeId:first.ch.body.challengeId,idToken:first.idToken})).status).toBe(401);
    const session=asSession(second.res.body.tokens,second.res.body.user.id);expect((await call(env,session,'GET','/me')).status).toBe(200);
    const stored=(await env.ctx.db.query('SELECT subject_hash FROM google_identities WHERE user_id=$1',[session.userId])).rows[0];expect(stored.subject_hash.length).toBe(32);
  });
  it('rejects wrong audience, signature, issuer, expiry, authorized party and missing claims',async()=>{
    const ch=await call(env,null,'POST','/auth/google/challenge',{platform:'web'},{},randomIp());
    const claims={...google.identity(),nonce:ch.body.nonce};
    const token=(overrides:Record<string,unknown>)=>new SignJWT({...claims,iss:'https://accounts.google.com',aud:googleConfig.webClientId,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,...overrides}).setProtectedHeader({alg:'RS256',kid:'test-google'}).sign(google.keys.privateKey);
    for(const overrides of [{aud:'wrong.apps.googleusercontent.com'},{iss:'https://evil.example'},{exp:1},{iat:1},{azp:'other.apps.googleusercontent.com'},{nonce:undefined},{sub:undefined},{email_verified:false}]){
      const r=await call(env,null,'POST','/auth/google/verify',{challengeId:ch.body.challengeId,idToken:await token(overrides)});expect(r.status).toBe(401);
    }
    const forged=await new SignJWT(claims).setProtectedHeader({alg:'HS256'}).setIssuer('https://accounts.google.com').setAudience(googleConfig.webClientId).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode('attacker-key-attacker-key-attacker-key'));
    expect((await call(env,null,'POST','/auth/google/verify',{challengeId:ch.body.challengeId,idToken:forged})).status).toBe(401);
  });
  it('rejects mismatched/expired nonce and simultaneous replay',async()=>{
    const first=await login();const ch=await call(env,null,'POST','/auth/google/challenge',{platform:'web'},{},randomIp());
    expect((await call(env,null,'POST','/auth/google/verify',{challengeId:ch.body.challengeId,idToken:first.idToken})).status).toBe(401);
    const idToken=await google.sign(ch.body.nonce);await env.ctx.db.query("UPDATE google_auth_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[ch.body.challengeId]);
    expect((await call(env,null,'POST','/auth/google/verify',{challengeId:ch.body.challengeId,idToken})).status).toBe(401);
    const next=await call(env,null,'POST','/auth/google/challenge',{platform:'web'},{},randomIp());const valid=await google.sign(next.body.nonce);
    const results=await Promise.all(Array.from({length:10},()=>call(env,null,'POST','/auth/google/verify',{challengeId:next.body.challengeId,idToken:valid})));expect(results.filter(r=>r.status===200)).toHaveLength(1);expect(results.filter(r=>r.status===401)).toHaveLength(9);
  });
  it('never automatically links by email; explicit linking is bound to the authenticated user',async()=>{
    const owner=await loginWorker(env);const claims={...google.identity(),email:`${randomUUID()}@gmail.com`};await env.ctx.db.query('UPDATE app_users SET email=$2 WHERE id=$1',[owner.userId,claims.email]);
    const first=await login(claims);expect(first.res.status).toBe(409);expect(first.res.body.code).toBe('google_link_required');
    const ch=await call(env,owner,'POST','/auth/google/link/challenge',{platform:'web'},{},randomIp());const idToken=await google.sign(ch.body.nonce,claims);
    expect((await call(env,null,'POST','/auth/google/verify',{challengeId:ch.body.challengeId,idToken})).status).toBe(401);
    const outsider=await loginWorker(env);expect((await call(env,outsider,'POST','/auth/google/link',{challengeId:ch.body.challengeId,idToken})).status).toBe(401);
    const linked=await call(env,owner,'POST','/auth/google/link',{challengeId:ch.body.challengeId,idToken});expect(linked.status).toBe(200);expect(linked.body.user.id).toBe(owner.userId);
    expect((await login(claims)).res.body.user.id).toBe(owner.userId);
    const taken=await call(env,outsider,'POST','/auth/google/link/challenge',{platform:'web'},{},randomIp());expect((await call(env,outsider,'POST','/auth/google/link',{challengeId:taken.body.challengeId,idToken:await google.sign(taken.body.nonce,claims)})).body.code).toBe('google_already_linked');
  });
  it('preserves MFA, suspension and deletion gates',async()=>{
    const claims=google.identity();const result=await login(claims);const id=result.res.body.user.id;
    await env.ctx.db.query('UPDATE app_users SET mfa_enabled=true WHERE id=$1',[id]);const mfa=await login(claims);expect(mfa.res.status).toBe(202);expect(mfa.res.body.mfaToken).toBeTruthy();expect(mfa.res.body.tokens).toBeUndefined();
    await env.ctx.db.query('UPDATE app_users SET mfa_enabled=false,suspended_at=now() WHERE id=$1',[id]);expect((await login(claims)).res.body.code).toBe('account_suspended');
    await env.ctx.db.query('UPDATE app_users SET suspended_at=NULL,deleted_at=now(),email=NULL WHERE id=$1',[id]);expect((await login(claims)).res.body.code).toBe('account_deleted');
    const admin=await webUser(env,['admin_operator']);expect((await call(env,admin,'POST','/auth/google/link/challenge',{platform:'web'},{},randomIp())).status).toBe(403);
  });
  it('Google login still requires an enrolled second factor before issuing sessions',async()=>{
    const owner=await webUser(env);const claims={...google.identity(),email:owner.email};
    const ch=await call(env,owner,'POST','/auth/google/link/challenge',{platform:'web'},{},randomIp());
    expect((await call(env,owner,'POST','/auth/google/link',{challengeId:ch.body.challengeId,idToken:await google.sign(ch.body.nonce,claims)})).status).toBe(200);
    const res=(await login(claims)).res;expect(res.status).toBe(202);expect(res.body.tokens).toBeUndefined();
    expect((await call(env,null,'POST','/auth/web/mfa/verify',{mfaToken:res.body.mfaToken,code:'000000'})).status).toBe(401);
    // The fixture's initial login already consumed this TOTP step; move its record back for a distinct verification.
    await env.ctx.db.query('UPDATE app_users SET last_totp_step=NULL WHERE id=$1',[owner.userId]);
    const verified=await call(env,null,'POST','/auth/web/mfa/verify',{mfaToken:res.body.mfaToken,code:owner.totp.generate()});expect(verified.status).toBe(200);expect(verified.body.user.id).toBe(owner.userId);
  });
  it('persists invalid MFA attempts and locks repeated failures',async()=>{
    const owner=await webUser(env);const token=await import('../src/auth/tokens.js').then(m=>m.signMfaToken(env.ctx,owner.userId));
    const invalid=owner.totp.generate()==='000000'?'111111':'000000';
    const attempts=await Promise.all(Array.from({length:20},()=>call(env,null,'POST','/auth/web/mfa/verify',{mfaToken:token,code:invalid})));
    expect(attempts.filter(r=>r.status===401)).toHaveLength(10);expect(attempts.filter(r=>r.status===429)).toHaveLength(10);
    expect((await call(env,null,'POST','/auth/web/mfa/verify',{mfaToken:token,code:invalid})).status).toBe(429);
  });
  it('verified phone attaches to Google session, cannot take another account’s phone',async()=>{
    const result=await login();const user=asSession(result.res.body.tokens,result.res.body.user.id);const phone='090'+String(Math.floor(Math.random()*1e8)).padStart(8,'0');
    await call(env,null,'POST','/auth/otp/request',{phone},{},randomIp());const code=env.sms.codes.get('+81'+phone.slice(1));
    expect((await call(env,user,'POST','/auth/phone/link',{phone,code})).body.user.id).toBe(user.userId);
    expect((await call(env,user,'PUT','/marketplace/customer',{familyName:'山田',givenName:'花子',address:'横浜市中区1-1'})).status).toBe(200);
    const other=await login();const outsider=asSession(other.res.body.tokens,other.res.body.user.id);
    await env.ctx.db.query("UPDATE otp_challenges SET created_at=now()-interval '2 minutes' WHERE phone_hash=$1",[env.ctx.cipher.blindIndex('+81'+phone.slice(1))]);
    await call(env,null,'POST','/auth/otp/request',{phone},{},randomIp());const r=await call(env,outsider,'POST','/auth/phone/link',{phone,code:env.sms.codes.get('+81'+phone.slice(1))});expect(r.status).toBe(409);expect(r.body.code).toBe('phone_already_linked');
  });
  it('fails closed without configured client and limits login challenges',async()=>{
    const original=env.ctx.cfg.google;env.ctx.cfg.google=undefined;expect((await call(env,null,'POST','/auth/google/challenge',{platform:'web'})).status).toBe(503);env.ctx.cfg.google=original;
    const ip=randomIp();for(let i=0;i<20;i++)expect((await call(env,null,'POST','/auth/google/challenge',{platform:'web'},{},ip)).status).toBe(200);
    expect((await call(env,null,'POST','/auth/google/challenge',{platform:'web'},{},ip)).status).toBe(429);
  });
});
