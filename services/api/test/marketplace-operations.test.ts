import {beforeAll,afterAll,describe,expect,it} from 'vitest';
import {setupApp,admin,call,key,uploadEvidence,type TestEnv,type Session} from './helpers.js';
import {operationsFixture,registered} from './marketplace-operations-flow.js';
let env:TestEnv;let operator:Session;let second:Session;
beforeAll(async()=>{env=await setupApp();operator=await admin(env);second=await admin(env);});afterAll(async()=>env.close());
describe('Marketplace operational permissions and ledgers',()=>{
 it('allows signed browser uploads from configured origins without opening arbitrary origins',async()=>{
  const response=await env.app.inject({method:'OPTIONS',url:'/v1/evidence-blobs/test',headers:{origin:'http://localhost:3001','access-control-request-method':'PUT','access-control-request-headers':'content-type'}});expect(response.statusCode).toBe(204);expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3001');expect(response.headers['access-control-allow-methods']).toContain('PUT');
  const blocked=await env.app.inject({method:'OPTIONS',url:'/v1/evidence-blobs/test',headers:{origin:'https://untrusted.example','access-control-request-method':'PUT'}});expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
 });
 it('requires every submitted document to remain valid when approval occurs',async()=>{
  const f=await operationsFixture(env,operator);const p=await call(env,f.owner,'POST','/marketplace/suppliers',{legalName:'期限確認事業者',supplierType:'company',address:'東京都1-1'});const doc=await uploadEvidence(env,f.owner,{purpose:'identity_document'});expect((await call(env,f.owner,'PUT',`/marketplace/suppliers/${p.body.id}/application`,{...f.application,evidenceIds:[f.docId,doc.id]})).status).toBe(200);await env.ctx.db.query("UPDATE evidence SET expires_at=now()-interval '1 second' WHERE id=$1",[doc.id]);expect((await call(env,operator,'POST',`/marketplace/admin/suppliers/${p.body.id}/review`,{decision:'approved',reason:'確認書類を確認'})).body.code).toBe('documents_required');expect((await env.ctx.db.query('SELECT review_status FROM marketplace.suppliers WHERE id=$1',[p.body.id])).rows[0].review_status).toBe('pending');
 });
 it('protects documents and requires a submitted application before supplier approval',async()=>{
  const f=await operationsFixture(env,operator);const outsider=await registered(env);expect((await call(env,outsider,'GET',`/marketplace/suppliers/${f.supplierId}/application`)).status).toBe(403);expect((await call(env,outsider,'GET',`/marketplace/admin/suppliers/${f.supplierId}`)).status).toBe(403);
  const pending=await call(env,outsider,'POST','/marketplace/suppliers',{legalName:'未提出-'+Date.now(),supplierType:'company',address:'横浜市1-1'});expect((await call(env,operator,'POST',`/marketplace/admin/suppliers/${pending.body.id}/review`,{decision:'approved',reason:'確認'})).status).toBe(409);
  expect((await call(env,outsider,'PUT',`/marketplace/suppliers/${pending.body.id}/application`,f.application)).body.code).toBe('invalid_documents');
 });
 it('invites only the verified phone, supports revocation and stores retry secrets encrypted',async()=>{
  const f=await operationsFixture(env,operator);const nominee=await registered(env);const outsider=await registered(env);const idem=key();
  const invite=await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/invitations`,{phone:nominee.phone,role:'staff'},{'idempotency-key':idem});expect(invite.status).toBe(201);const stored=(await env.ctx.db.query('SELECT response_json,response_ciphertext FROM idempotency_keys WHERE actor_id=$1 AND key=$2',[f.owner.userId,idem])).rows[0];expect(stored.response_json).toEqual({});expect(stored.response_ciphertext).toBeTruthy();expect(stored.response_ciphertext.toString()).not.toContain(invite.body.token);
  expect((await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/invitations`,{phone:nominee.phone,role:'staff'},{'idempotency-key':idem})).body).toEqual(invite.body);
  expect((await call(env,outsider,'POST','/marketplace/suppliers/join',{token:invite.body.token})).body.code).toBe('invitation_phone_mismatch');
  expect((await call(env,nominee,'POST','/marketplace/suppliers/join',{token:invite.body.token})).status).toBe(200);expect((await call(env,nominee,'POST','/marketplace/suppliers/join',{token:invite.body.token})).status).toBe(409);
  expect((await call(env,nominee,'POST',`/marketplace/suppliers/${f.supplierId}/invitations`,{phone:outsider.phone,role:'manager'})).status).toBe(403);
  const revoked=await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/invitations`,{phone:outsider.phone,role:'staff'});await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/invitations/${revoked.body.id}/revoke`,{});expect((await call(env,outsider,'POST','/marketplace/suppliers/join',{token:revoked.body.token})).status).toBe(409);
 });
 it('cannot remove the owner or a member assigned to an active request',async()=>{
  const f=await operationsFixture(env,operator);expect((await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/members/${f.owner.userId}/deactivate`,{reason:'解除'})).status).toBe(403);
  const staff=await registered(env);await env.ctx.db.query(`INSERT INTO marketplace.supplier_members(supplier_id,user_id,role) VALUES ($1,$2,'staff')`,[f.supplierId,staff.userId]);await env.ctx.db.query('UPDATE marketplace.requests SET assigned_staff_id=$2 WHERE id=$1',[f.requestId,staff.userId]);expect((await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/members/${staff.userId}/deactivate`,{reason:'解除'})).body.code).toBe('active_assignments');
 });
 it('requires two operators and resolves quota exactly once across concurrent approvals',async()=>{
  const f=await operationsFixture(env,operator);await call(env,f.customer,'POST',`/marketplace/requests/${f.requestId}/dispute`,{reason:'問題を確認してください'});
  const proposal=await call(env,operator,'POST',`/marketplace/admin/requests/${f.requestId}/resolutions`,{decision:'resolved_cancelled',reason:'作業未完了を確認',evidenceSummary:'本人の連絡と担当者の作業記録を照合して作業が未完了であることを確認しました'});expect(proposal.status).toBe(201);
  const url=`/marketplace/admin/requests/${f.requestId}/resolutions/${proposal.body.id}/approve`;expect((await call(env,operator,'POST',url,{approve:true,reason:'同一担当者の確認'})).body.code).toBe('two_person_required');
  const auditor=await admin(env,'admin_auditor');expect((await call(env,auditor,'POST',url,{approve:true,reason:'確認'})).status).toBe(403);
  const responses=await Promise.all(Array.from({length:10},()=>call(env,second,'POST',url,{approve:true,reason:'独立して内容を確認しました'})));expect(responses.filter(r=>r.status===200)).toHaveLength(1);expect(responses.filter(r=>r.status===409)).toHaveLength(9);
  expect((await env.ctx.db.query('SELECT state FROM marketplace.quota_reservations WHERE request_id=$1',[f.requestId])).rows[0].state).toBe('released');expect((await env.ctx.db.query("SELECT count(*)::int AS n FROM domain_events WHERE entity_id=$1 AND event_type='resolved_cancelled'",[f.requestId])).rows[0].n).toBe(1);
 });
 it('a rejected dispute proposal holds quota until a new proposal is independently approved',async()=>{
  const f=await operationsFixture(env,operator);await call(env,f.customer,'POST',`/marketplace/requests/${f.requestId}/dispute`,{reason:'確認をお願いします'});
  const b={decision:'resolved_completed',reason:'完了内容を確認',evidenceSummary:'作業記録と当事者からの連絡を確認して提案を作成しました'};
  const first=await call(env,operator,'POST',`/marketplace/admin/requests/${f.requestId}/resolutions`,b);expect((await call(env,second,'POST',`/marketplace/admin/requests/${f.requestId}/resolutions/${first.body.id}/approve`,{approve:false,reason:'確認内容が不足しています'})).body.status).toBe('disputed');expect((await env.ctx.db.query('SELECT state FROM marketplace.quota_reservations WHERE request_id=$1',[f.requestId])).rows[0].state).toBe('held_dispute');
  const next=await call(env,operator,'POST',`/marketplace/admin/requests/${f.requestId}/resolutions`,b);await call(env,second,'POST',`/marketplace/admin/requests/${f.requestId}/resolutions/${next.body.id}/approve`,{approve:true,reason:'追加の記録と本人への連絡を確認しました'});
  expect((await call(env,f.owner,'POST',`/marketplace/requests/${f.requestId}/rating`,{score:5})).status).toBe(404);expect((await call(env,f.customer,'POST',`/marketplace/requests/${f.requestId}/rating`,{score:5,comment:'丁寧でした'})).status).toBe(200);expect((await call(env,f.customer,'POST',`/marketplace/requests/${f.requestId}/rating`,{score:1})).status).toBe(409);
  const rating=(await env.ctx.db.query('SELECT comment_ciphertext FROM marketplace.ratings WHERE request_id=$1',[f.requestId])).rows[0];expect(env.ctx.cipher.decrypt(rating.comment_ciphertext)).toBe('丁寧でした');
 });
});
