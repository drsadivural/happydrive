import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {admin,call,loginWorker,uploadEvidence,type Session,type TestEnv} from './helpers.js';
export async function registered(env:TestEnv){const s=await loginWorker(env);expect((await call(env,s,'PUT','/marketplace/customer',{familyName:'担当',givenName:'テスト',address:'東京都千代田区1-1'})).status).toBe(200);return s;}
export async function operationsFixture(env:TestEnv,operator:Session){
 const owner=await registered(env);const company=await call(env,owner,'POST','/marketplace/suppliers',{legalName:'運用試験-'+randomUUID(),supplierType:'company',address:'東京都千代田区1-1'});expect(company.status).toBe(201);const supplierId=company.body.id;
 const doc=await uploadEvidence(env,owner,{purpose:'identity_document'});
 const application={businessCategory:'生活支援',areaCodes:['13101'],openingHours:'平日9〜18時',insuranceSummary:'損害賠償保険加入・安全確認手順',contactEmail:'contact@example.test',description:'買い物・訪問の支援事業です',evidenceIds:[doc.id]};
 expect((await call(env,owner,'GET',`/marketplace/suppliers/${supplierId}/application`)).status).toBe(200);
 expect((await call(env,owner,'PUT',`/marketplace/suppliers/${supplierId}/application`,application)).status).toBe(200);
 expect((await call(env,operator,'GET',`/marketplace/admin/suppliers/${supplierId}`)).status).toBe(200);
 expect((await call(env,operator,'POST',`/marketplace/admin/suppliers/${supplierId}/review`,{decision:'approved',reason:'書類の内容と事業を確認しました'})).status).toBe(200);
 const service=await call(env,owner,'POST',`/marketplace/suppliers/${supplierId}/services`,{name:'運用試験の買い物支援',category:'shopping_assist',description:'お買い物をお手伝いします',areaCodes:['13101'],durationMinutes:60,pricePolicy:'試験用・請求なし'});expect(service.status).toBe(201);expect((await call(env,operator,'POST',`/marketplace/services/${service.body.id}/review`,{decision:'published',reason:'内容確認済み'})).status).toBe(200);
 await env.ctx.db.query(`INSERT INTO marketplace.subscriptions(supplier_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,plan_code,status,trial_ends_at,current_period_end) VALUES ($1,$2,$3,'test_supplier','supplier','trialing',now()+interval '7 days',now()+interval '7 days')`,[supplierId,'cus_'+randomUUID(),'sub_'+randomUUID()]);
 const customer=await registered(env);const sub=(await env.ctx.db.query(`INSERT INTO marketplace.subscriptions(customer_user_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,plan_code,status,trial_ends_at,current_period_start,current_period_end) VALUES ($1,$2,$3,'test_basic','basic','trialing',now()+interval '30 days',now(),now()+interval '30 days') RETURNING id`,[customer.userId,'cus_'+randomUUID(),'sub_'+randomUUID()])).rows[0];await env.ctx.db.query(`INSERT INTO marketplace.quota_periods(subscription_id,starts_at,ends_at,plan_code,period_limit) VALUES ($1,now(),now()+interval '30 days','basic',5)`,[sub.id]);
 const startsAt=new Date(Date.now()+3*3600000).toISOString(),endsAt=new Date(Date.now()+4*3600000).toISOString();
 const avail=await call(env,owner,'POST',`/marketplace/suppliers/${supplierId}/availability`,{staffId:owner.userId,startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+30*86400000).toISOString()});expect(avail.status).toBe(201);
 const posted=await call(env,customer,'POST','/marketplace/requests',{serviceId:service.body.id,title:'運用試験の依頼',details:'玄関で確認してから作業をお願いします',address:'東京都千代田区1-1-101',areaCode:'13101',startsAt,endsAt});expect(posted.status).toBe(201);
 expect((await call(env,owner,'POST',`/marketplace/requests/${posted.body.id}/accept`,{supplierId,staffId:owner.userId})).status).toBe(200);
 return {owner,customer,supplierId,requestId:posted.body.id as string,availabilityId:avail.body.id as string,docId:doc.id,application};
}
export async function exerciseOperationsContract(env:TestEnv,operator:Session){
 const f=await operationsFixture(env,operator);const second=await admin(env);const staff=await registered(env);
 const invite=await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/invitations`,{phone:staff.phone,role:'staff'});expect(invite.status).toBe(201);
 expect((await call(env,f.owner,'GET',`/marketplace/suppliers/${f.supplierId}/invitations`)).status).toBe(200);
 expect((await call(env,staff,'POST','/marketplace/suppliers/join',{token:invite.body.token})).status).toBe(200);
 expect((await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/members/${staff.userId}/deactivate`,{reason:'担当業務がないことを確認して解除'})).status).toBe(200);
 const extra=await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/invitations`,{phone:staff.phone,role:'staff'});expect((await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/invitations/${extra.body.id}/revoke`,{})).status).toBe(200);
 expect((await call(env,f.owner,'GET',`/marketplace/suppliers/${f.supplierId}/availability`)).status).toBe(200);expect((await call(env,f.owner,'POST',`/marketplace/suppliers/${f.supplierId}/availability/${f.availabilityId}/remove`,{})).status).toBe(200);
 expect((await call(env,f.customer,'POST',`/marketplace/requests/${f.requestId}/dispute`,{reason:'完了内容の確認について相談します'})).status).toBe(200);
 expect((await call(env,operator,'GET','/marketplace/admin/overview')).status).toBe(200);expect((await call(env,operator,'GET',`/marketplace/admin/requests/${f.requestId}/dispute`)).status).toBe(200);
 const proposal=await call(env,operator,'POST',`/marketplace/admin/requests/${f.requestId}/resolutions`,{decision:'resolved_completed',reason:'本人と担当者に内容を確認',evidenceSummary:'本人からの連絡と担当者の作業記録を照合して完了内容を確認しました'});expect(proposal.status).toBe(201);expect((await call(env,second,'POST',`/marketplace/admin/requests/${f.requestId}/resolutions/${proposal.body.id}/approve`,{approve:true,reason:'独立して連絡内容と記録を確認しました'})).status).toBe(200);
 expect((await call(env,f.customer,'POST',`/marketplace/requests/${f.requestId}/rating`,{score:5,comment:'丁寧に対応していただきました'})).status).toBe(200);expect((await call(env,f.customer,'GET',`/marketplace/requests/${f.requestId}/rating`)).status).toBe(200);
 return f;
}
