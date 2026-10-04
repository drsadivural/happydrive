import {afterEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {createAuthHandlers} from '../src/bff/auth-handlers';
import {cookieNames} from '../src/bff/session';
import {buildCsp,securityHeaders} from '../src/bff/security-headers';
const cfg={cookiePrefix:'test',secure:true};const names=cookieNames(cfg);const csrf='a'.repeat(43);const challengeId='a1111111-1111-4111-8111-111111111111';
function request(path:string,body:unknown,cookies:Record<string,string>={},withCsrf=true){return new NextRequest(`https://happy.example${path}`,{method:'POST',headers:{'content-type':'application/json','host':'happy.example','origin':'https://happy.example',...(withCsrf?{'x-hd-csrf':csrf}:{}),cookie:Object.entries({[names.csrf]:csrf,...cookies}).map(([k,v])=>`${k}=${v}`).join('; ')},body:JSON.stringify(body)});}
const result={tokens:{accessToken:'access-secret',refreshToken:'refresh-secret',accessTokenExpiresAt:new Date(Date.now()+900000).toISOString(),refreshTokenExpiresAt:new Date(Date.now()+86400000).toISOString()},user:{displayName:'Google User'},isNewUser:false};
afterEach(()=>vi.unstubAllGlobals());
describe('Google BFF security',()=>{
 it('binds challenge to httpOnly browser cookie and verifies only its saved ID',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({challengeId,nonce:'nonce',clientId:'client',expiresAt:new Date().toISOString()})).mockResolvedValueOnce(Response.json(result));vi.stubGlobal('fetch',fetcher);
  const auth=createAuthHandlers({session:cfg,apiBase:'https://api.example/v1'});
  const start=await auth.googleChallenge(request('/start',{}));expect(start.status).toBe(200);expect(await start.json()).not.toHaveProperty('challengeId');const saved=start.headers.get('set-cookie')!;expect(saved).toContain('HttpOnly');expect(saved).toContain('Secure');expect(saved).toContain('SameSite=strict');
  const verify=await auth.googleVerify(request('/verify',{idToken:'token'.repeat(10),challengeId:'attacker-controlled'},{[names.mfa+'_google']:`login:${challengeId}`}));expect(verify.status).toBe(200);expect(await verify.text()).not.toMatch(/access-secret|refresh-secret/);expect(verify.headers.get('set-cookie')).toContain('access-secret');
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({challengeId});
 });
 it('requires CSRF, saved challenge and authentication for linking; never issues admin Google sessions',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const auth=createAuthHandlers({session:cfg});
  expect((await auth.googleChallenge(request('/start',{}, {},false))).status).toBe(403);
  expect((await auth.googleVerify(request('/verify',{idToken:'x'.repeat(30)}))).status).toBe(401);
  expect((await auth.googleChallenge(request('/start',{link:true}))).status).toBe(401);
  const admin=createAuthHandlers({session:cfg,requiredRoles:['admin_operator']});expect((await admin.googleChallenge(request('/start',{}))).status).toBe(403);expect((await admin.googleVerify(request('/verify',{}))).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();
 });
 it('stores only a pending MFA cookie when Google requires a second factor',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({mfaToken:'pending-mfa-secret',mfaEnrollmentRequired:false},{status:202})));const auth=createAuthHandlers({session:cfg});
  const res=await auth.googleVerify(request('/verify',{idToken:'x'.repeat(30)},{[names.mfa+'_google']:`login:${challengeId}`}));expect(res.status).toBe(202);expect(await res.json()).toEqual({mfaRequired:true});expect(res.headers.get('set-cookie')).toContain('pending-mfa-secret');expect(res.headers.get('set-cookie')).not.toContain(names.access+'=');
 });
 it('forwards linking bearer only to authenticated link endpoints',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({challengeId,nonce:'nonce',clientId:'client'})).mockResolvedValueOnce(Response.json(result));vi.stubGlobal('fetch',fetcher);const auth=createAuthHandlers({session:cfg,apiBase:'https://api.example/v1'});
  await auth.googleChallenge(request('/start',{link:true},{[names.access]:'owner-token'}));expect(fetcher.mock.calls[0]![0]).toBe('https://api.example/v1/auth/google/link/challenge');expect(fetcher.mock.calls[0]![1].headers.authorization).toBe('Bearer owner-token');
  await auth.googleVerify(request('/verify',{idToken:'x'.repeat(30)},{[names.access]:'owner-token',[names.mfa+'_google']:`link:${challengeId}`}));expect(fetcher.mock.calls[1]![0]).toBe('https://api.example/v1/auth/google/link');
 });
 it('returns a recoverable provider-configuration error without creating cookies',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({code:'google_unconfigured',message:'準備中'},{status:503})));const auth=createAuthHandlers({session:cfg});const res=await auth.googleChallenge(request('/start',{}));expect(res.status).toBe(503);expect(res.headers.has('set-cookie')).toBe(false);
 });
 it('permits only Google GIS resources and popup communication when explicitly enabled',()=>{
  const ordinary=buildCsp({isDev:false});expect(ordinary).not.toContain('accounts.google.com');expect(ordinary).toContain("frame-src 'none'");
  const google=buildCsp({isDev:false,googleSignIn:true});expect(google).toContain('https://accounts.google.com/gsi/client');expect(google).toContain('frame-src https://accounts.google.com/gsi/');expect(google).not.toContain("'unsafe-eval'");expect(securityHeaders({isDev:false,googleSignIn:true}).find(h=>h.key==='Cross-Origin-Opener-Policy')?.value).toBe('same-origin-allow-popups');expect(securityHeaders({isDev:false,googleSignIn:true}).find(h=>h.key==='Referrer-Policy')?.value).toBe('strict-origin-when-cross-origin');
 });
});
