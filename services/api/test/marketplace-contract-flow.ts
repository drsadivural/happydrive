import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { loginWorker,call,type TestEnv,type Session } from './helpers.js';

export async function exerciseMarketplaceContract(env:TestEnv,operator:Session) {
  const customer=await loginWorker(env);const supplier=await loginWorker(env);
  for (const s of [customer,supplier]) expect((await call(env,s,'PUT','/marketplace/customer',{familyName:'試験',givenName:'担当',address:'東京都千代田区1-1'})).status).toBe(200);
  expect((await call(env,customer,'GET','/marketplace/plans')).status).toBe(200);
  expect((await call(env,customer,'GET','/marketplace/me')).status).toBe(200);
  const p=await call(env,supplier,'POST','/marketplace/suppliers',{legalName:'契約試験-'+randomUUID(),supplierType:'company',address:'東京都千代田区1-1'});expect(p.status).toBe(201);
  const supplierId=p.body.id;
  await env.ctx.db.query(`UPDATE marketplace.suppliers SET review_status='approved' WHERE id=$1`,[supplierId]);
  const start=new Date(Date.now()+3*3600000).toISOString(),end=new Date(Date.now()+4*3600000).toISOString();
  expect((await call(env,supplier,'GET',`/marketplace/suppliers/${supplierId}/members`)).status).toBe(200);
  expect((await call(env,supplier,'POST',`/marketplace/suppliers/${supplierId}/availability`,{staffId:supplier.userId,startsAt:start,endsAt:end})).status).toBe(201);
  const service=await call(env,supplier,'POST',`/marketplace/suppliers/${supplierId}/services`,{name:'買い物支援',category:'shopping_assist',description:'日常の買い物を支援',areaCodes:['13101'],durationMinutes:60,pricePolicy:'試験のみ・請求なし'});expect(service.status).toBe(201);
  expect((await call(env,operator,'POST',`/marketplace/services/${service.body.id}/review`,{decision:'published',reason:'試験用の確認'})).status).toBe(200);
  expect((await call(env,customer,'GET','/marketplace/catalog')).status).toBe(200);
  expect((await call(env,supplier,'GET',`/marketplace/suppliers/${supplierId}/services`)).status).toBe(200);
  const sub=(await env.ctx.db.query(`INSERT INTO marketplace.subscriptions(customer_user_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,plan_code,status,trial_ends_at,current_period_start,current_period_end)
    VALUES ($1,$2,$3,'test_price','basic','trialing',now()+interval '30 days',now(),now()+interval '30 days') RETURNING id`,[customer.userId,randomUUID(),randomUUID()])).rows[0];
  await env.ctx.db.query(`INSERT INTO marketplace.quota_periods(subscription_id,starts_at,ends_at,plan_code,period_limit) VALUES ($1,now(),now()+interval '30 days','basic',5)`,[sub.id]);
  await env.ctx.db.query(`INSERT INTO marketplace.subscriptions(supplier_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,plan_code,status,trial_ends_at,current_period_end)
    VALUES ($1,$2,$3,'test_supplier','supplier','trialing',now()+interval '7 days',now()+interval '7 days')`,[supplierId,randomUUID(),randomUUID()]);
  const input={serviceId:service.body.id,title:'買い物支援の依頼',details:'近所での買い物',address:'東京都千代田区1-1',areaCode:'13101',startsAt:start,endsAt:end};
  const post=async()=>{const r=await call(env,customer,'POST','/marketplace/requests',input);expect(r.status).toBe(201);return r.body.id as string;};
  const id=await post();
  expect((await call(env,supplier,'GET',`/marketplace/suppliers/${supplierId}/feed`)).status).toBe(200);
  expect((await call(env,customer,'GET','/marketplace/requests')).status).toBe(200);
  expect((await call(env,customer,'GET',`/marketplace/requests/${id}`)).status).toBe(200);
  const accept=async(requestId:string)=>{expect((await call(env,supplier,'POST',`/marketplace/requests/${requestId}/accept`,{supplierId,staffId:supplier.userId})).status).toBe(200);};
  await accept(id);
  expect((await call(env,customer,'POST',`/marketplace/requests/${id}/messages`,{body:'よろしくお願いします'})).status).toBe(201);
  expect((await call(env,supplier,'GET',`/marketplace/requests/${id}/messages`)).status).toBe(200);
  for (const status of ['en_route','arrived','in_progress','awaiting_customer_confirmation']) expect((await call(env,supplier,'POST',`/marketplace/requests/${id}/status`,{status})).status).toBe(200);
  const qr=await call(env,customer,'POST',`/marketplace/requests/${id}/completion-token`);expect(qr.status).toBe(200);
  expect((await call(env,supplier,'POST',`/marketplace/requests/${id}/confirm`,{token:qr.body.token})).status).toBe(200);
  const cancelId=await post();expect((await call(env,customer,'POST',`/marketplace/requests/${cancelId}/cancel`,{reason:'予定の変更'})).status).toBe(200);
  const disputeId=await post();await accept(disputeId);expect((await call(env,customer,'POST',`/marketplace/requests/${disputeId}/dispute`,{reason:'内容の確認'})).status).toBe(200);
  expect((await call(env,customer,'POST','/marketplace/checkout',{planCode:'basic'})).status).toBe(503);
}
