import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, loginWorker, setupApp, type TestEnv, type Session, key } from './helpers.js';
import { withTx } from '../src/db/pool.js';
import { acceptRequest } from '../src/modules/marketplace/domain.js';

let env: TestEnv;
let customer: Session;
let supplier: Session;
let supplierId: string;
let serviceId: string;
const startsAt = new Date(Date.now()+3*3600_000).toISOString();
const endsAt = new Date(Date.now()+4*3600_000).toISOString();

async function registerCustomer(plan='basic') {
  const s=await loginWorker(env);
  expect((await call(env,s,'PUT','/marketplace/customer',{familyName:'山田',givenName:'花子',address:'東京都千代田区1-1'})).status).toBe(200);
  const sub=(await env.ctx.db.query(`INSERT INTO marketplace.subscriptions(customer_user_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,plan_code,status,trial_ends_at,current_period_start,current_period_end)
    VALUES ($1,$2,$3,'test_price',$4,'trialing',now()+interval '30 days',now()-interval '1 hour',now()+interval '30 days') RETURNING id`,[s.userId,`cus_${randomUUID()}`,`sub_${randomUUID()}`,plan])).rows[0];
  await env.ctx.db.query(`INSERT INTO marketplace.quota_periods(subscription_id,starts_at,ends_at,plan_code,period_limit,daily_limit)
    VALUES ($1,now()-interval '1 hour',now()+interval '30 days',$2,$3,$4)`,[sub.id,plan,plan==='basic'?5:plan==='standard'?12:null,plan==='care'?2:null]);
  return s;
}
async function createSupplier(s: Session) {
  const id=(await env.ctx.db.query(`INSERT INTO marketplace.suppliers(legal_name,supplier_type,review_status) VALUES ($1,'company','approved') RETURNING id`,[`company-${randomUUID()}`])).rows[0].id;
  await env.ctx.db.query(`INSERT INTO marketplace.supplier_members(supplier_id,user_id,role) VALUES ($1,$2,'owner')`,[id,s.userId]);
  await env.ctx.db.query(`INSERT INTO marketplace.subscriptions(supplier_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,plan_code,status,trial_ends_at,current_period_end)
    VALUES ($1,$2,$3,'test_supplier','supplier','trialing',now()+interval '7 days',now()+interval '7 days')`,[id,`cus_${randomUUID()}`,`sub_${randomUUID()}`]);
  await env.ctx.db.query(`INSERT INTO marketplace.supplier_availability(supplier_id,staff_id,starts_at,ends_at) VALUES ($1,$2,now(),now()+interval '60 days')`,[id,s.userId]);
  const service=(await env.ctx.db.query(`INSERT INTO marketplace.supplier_services(supplier_id,name,category,description,area_codes,duration_minutes,price_policy,status,source)
    VALUES ($1,'買い物支援','shopping_assist','買い物のお手伝い',ARRAY['13101'],60,'料金承認待ち','published','manual') RETURNING id`,[id])).rows[0].id;
  return {id,service};
}
const input=()=>({serviceId,title:'買い物を手伝ってください',details:'玄関でお待ちします',address:'東京都千代田区1-1-101',areaCode:'13101',startsAt,endsAt});
async function posted(s: Session) {
  const r=await call(env,s,'POST','/marketplace/requests',input());expect(r.status,JSON.stringify(r.body)).toBe(201);return r.body.id as string;
}
async function awaiting(id: string) {
  expect((await call(env,supplier,'POST',`/marketplace/requests/${id}/accept`,{supplierId,staffId:supplier.userId})).status).toBe(200);
  for (const status of ['en_route','arrived','in_progress','awaiting_customer_confirmation']) expect((await call(env,supplier,'POST',`/marketplace/requests/${id}/status`,{status})).status).toBe(200);
}

beforeAll(async()=>{
  env=await setupApp({rateLimitPerMinute:10000});
  customer=await registerCustomer();supplier=await registerCustomer('care');
  const p=await createSupplier(supplier);supplierId=p.id;serviceId=p.service;
});
afterAll(async()=>{await env?.close();});

describe('v2 marketplace transactional acceptance',()=>{
  it('preserves initial invitations as private unverified records',async()=>{
    const r=await env.ctx.db.query(`SELECT review_status FROM marketplace.suppliers WHERE legal_name=ANY($1)`,[['OTERA','トーカイ','Nurse and Craft']]);
    expect(r.rows).toHaveLength(3);expect(r.rows.every(x=>x.review_status==='invited_unverified')).toBe(true);
    const catalog=await call(env,customer,'GET','/marketplace/catalog');expect(catalog.status).toBe(200);
    expect(catalog.body.items.every((x:{supplierName:string})=>!['OTERA','トーカイ','Nurse and Craft'].includes(x.supplierName))).toBe(true);
  });
  it('100 concurrent Basic posts reserve exactly five slots; cancel returns one',async()=>{
    const s=await registerCustomer();
    const results=await Promise.all(Array.from({length:100},()=>call(env,s,'POST','/marketplace/requests',input())));
    expect(results.filter(r=>r.status===201)).toHaveLength(5);expect(results.filter(r=>r.status===409)).toHaveLength(95);
    const id=results.find(r=>r.status===201)!.body.id;
    expect((await call(env,s,'POST',`/marketplace/requests/${id}/cancel`,{reason:'予定変更'})).status).toBe(200);
    expect((await call(env,s,'POST','/marketplace/requests',input())).status).toBe(201);
    expect((await call(env,s,'POST','/marketplace/requests',input())).status).toBe(409);
  });
  it('Standard allows twelve and refuses thirteen',async()=>{
    const s=await registerCustomer('standard');
    const results=await Promise.all(Array.from({length:13},()=>call(env,s,'POST','/marketplace/requests',input())));
    expect(results.filter(r=>r.status===201)).toHaveLength(12);expect(results.filter(r=>r.status===409)).toHaveLength(1);
  });
  it('Care enforces two per scheduled JST day even under concurrent requests',async()=>{
    const s=await registerCustomer('care');
    const results=await Promise.all(Array.from({length:20},()=>call(env,s,'POST','/marketplace/requests',input())));
    expect(results.filter(r=>r.status===201)).toHaveLength(2);expect(results.filter(r=>r.status===409)).toHaveLength(18);
    const next={...input(),startsAt:new Date(Date.parse(startsAt)+86400_000).toISOString(),endsAt:new Date(Date.parse(endsAt)+86400_000).toISOString()};
    expect((await call(env,s,'POST','/marketplace/requests',next)).status).toBe(201);
  });
  it('posts are idempotent and changed payload under a reused key fails',async()=>{
    const s=await registerCustomer();const idem=key();
    const results=await Promise.all(Array.from({length:10},()=>call(env,s,'POST','/marketplace/requests',input(),{'idempotency-key':idem})));
    expect(results.every(r=>r.status===201)).toBe(true);expect(new Set(results.map(r=>r.body.id)).size).toBe(1);
    expect((await call(env,s,'POST','/marketplace/requests',{...input(),title:'別の依頼'},{'idempotency-key':idem})).status).toBe(422);
  });
  it('100 eligible supplier acceptances produce exactly one winner',async()=>{
    const s=await registerCustomer();const id=await posted(s);
    const candidates=await Promise.all(Array.from({length:100},async()=>{
      const actor=(await env.ctx.db.query(`INSERT INTO app_users(display_name,email,roles) VALUES ('競合試験',$1,ARRAY['worker']) RETURNING id`,[`race-${randomUUID()}@example.test`])).rows[0].id as string;
      await env.ctx.db.query(`INSERT INTO marketplace.users(id,family_name,given_name,phone_hash,phone_ciphertext) VALUES ($1,'競合','試験',gen_random_bytes(32),$2)`,[actor,env.ctx.cipher.encrypt('test-only')]);
      const company=await createSupplier({...supplier,userId:actor});
      return {...company,actor};
    }));
    const results=await Promise.allSettled(candidates.map(p=>withTx(env.ctx.db,c=>acceptRequest(c,p.actor,id,p.id,p.actor))));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected').every(r=>r.status==='rejected' && r.reason.statusCode===409)).toBe(true);
    await env.ctx.db.query(`UPDATE marketplace.requests SET status='cancelled' WHERE id=$1`,[id]);
  });
  it('hides exact addresses before acceptance and rejects unrelated detail readers',async()=>{
    const id=await posted(customer);
    const feed=await call(env,supplier,'GET',`/marketplace/suppliers/${supplierId}/feed`);
    expect(feed.status).toBe(200);expect(JSON.stringify(feed.body)).not.toContain('1-1-101');expect(JSON.stringify(feed.body)).not.toContain('玄関');
    expect((await call(env,supplier,'GET',`/marketplace/requests/${id}`)).status).toBe(404);
    expect((await call(env,customer,'POST',`/marketplace/requests/${id}/cancel`,{reason:'試験終了'})).status).toBe(200);
  });
  it('requires assigned staff and ordered progress, invalidates reissued QR, and completes only once',async()=>{
    const id=await posted(customer);await awaiting(id);
    const stranger=await registerCustomer();
    expect((await call(env,stranger,'POST',`/marketplace/requests/${id}/completion-token`)).status).toBe(404);
    const first=await call(env,customer,'POST',`/marketplace/requests/${id}/completion-token`);
    const second=await call(env,customer,'POST',`/marketplace/requests/${id}/completion-token`);
    expect(first.status).toBe(200);expect(second.status).toBe(200);
    expect(Date.parse(second.body.expiresAt)-Date.now()).toBeGreaterThan(55000);
    expect((await call(env,supplier,'POST',`/marketplace/requests/${id}/confirm`,{token:first.body.token})).status).toBe(409);
    expect((await call(env,stranger,'POST',`/marketplace/requests/${id}/confirm`,{token:second.body.token})).status).toBe(404);
    const scans=await Promise.all(Array.from({length:2},()=>call(env,supplier,'POST',`/marketplace/requests/${id}/confirm`,{token:second.body.token})));
    expect(scans.filter(r=>r.status===200)).toHaveLength(1);expect(scans.filter(r=>r.status===409)).toHaveLength(1);
    const quota=await env.ctx.db.query('SELECT state FROM marketplace.quota_reservations WHERE request_id=$1',[id]);expect(quota.rows[0].state).toBe('consumed');
    const event=await env.ctx.db.query(`SELECT count(*)::int AS n FROM domain_events WHERE entity_id=$1 AND event_type='completed'`,[id]);expect(event.rows[0].n).toBe(1);
    const ledger=await env.ctx.db.query('SELECT * FROM marketplace.payment_ledger WHERE request_id=$1',[id]);expect(ledger.rowCount).toBe(0);
  });
  it('rejects expired QR and preserves request and quota for retry',async()=>{
    const id=await posted(customer);await awaiting(id);
    const qr=await call(env,customer,'POST',`/marketplace/requests/${id}/completion-token`);
    await env.ctx.db.query(`UPDATE marketplace.completion_tokens SET expires_at=now()-interval '1 second' WHERE request_id=$1`,[id]);
    expect((await call(env,supplier,'POST',`/marketplace/requests/${id}/confirm`,{token:qr.body.token})).status).toBe(409);
    expect((await call(env,customer,'GET',`/marketplace/requests/${id}`)).body.status).toBe('awaiting_customer_confirmation');
    expect((await call(env,customer,'POST',`/marketplace/requests/${id}/dispute`,{reason:'作業内容を確認したい'})).status).toBe(200);
  });
  it('refuses checkout until commercial terms are decided',async()=>{
    expect((await call(env,customer,'POST','/marketplace/checkout',{planCode:'basic'})).status).toBe(503);
  });
});
