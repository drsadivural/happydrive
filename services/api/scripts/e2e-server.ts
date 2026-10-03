// Test-only HTTP harness; refuses any database whose name does not end in _e2e.
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { testConfig, CapturingSms, loginWorker, call } from '../test/helpers.js';
import { buildApp } from '../src/server.js';

const databaseUrl=process.env.HD_E2E_DATABASE_URL;
if (process.env.NODE_ENV!=='test' || !databaseUrl || !new URL(databaseUrl).pathname.endsWith('_e2e')) throw new Error('NODE_ENV=test and an explicit *_e2e database are required');
const db=createPool(databaseUrl);
await db.query('DROP SCHEMA IF EXISTS marketplace CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate(db);await db.end();
const sms=new CapturingSms();
const built=await buildApp({cfg:testConfig({databaseUrl,rateLimitPerMinute:10000}),sms});
const env={...built,sms,close:()=>built.app.close()};
const fixtures:Record<string,unknown>={};
env.app.get('/__test/fixtures',async()=>fixtures);
env.app.get('/__test/otp/:phone',async(req)=>({code:env.sms.codes.get((req.params as {phone:string}).phone)}));
await env.app.ready();
for (const [role,phone] of [['customer','09011112222'],['supplier','09033334444'],['customer_mobile','09055556666'],['supplier_mobile','09077778888']] as const) {
  const s=await loginWorker(env,phone);
  await call(env,s,'PUT','/marketplace/customer',{familyName:role.startsWith('customer')?'顧客':'供給者',givenName:'テスト',address:'東京都千代田区1-1'});
  fixtures[role]={phone,userId:s.userId};
  if (role.startsWith('customer')) {
    const sub=(await env.ctx.db.query(`INSERT INTO marketplace.subscriptions(customer_user_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,plan_code,status,trial_ends_at,current_period_start,current_period_end)
      VALUES ($1,'e2e_customer_'||$2,'e2e_subscription_'||$2,'e2e_price','basic','trialing',now()+interval '30 days',now(),now()+interval '30 days') RETURNING id`,[s.userId,phone])).rows[0];
    await env.ctx.db.query(`INSERT INTO marketplace.quota_periods(subscription_id,starts_at,ends_at,plan_code,period_limit) VALUES ($1,now(),now()+interval '30 days','basic',5)`,[sub.id]);
  } else {
    const p=(await env.ctx.db.query(`INSERT INTO marketplace.suppliers(legal_name,supplier_type,review_status) VALUES ($1,'company','approved') RETURNING id`,['試験用生活サポート'+phone])).rows[0];
    await env.ctx.db.query(`INSERT INTO marketplace.supplier_members(supplier_id,user_id,role) VALUES ($1,$2,'owner')`,[p.id,s.userId]);
    await env.ctx.db.query(`INSERT INTO marketplace.subscriptions(supplier_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,plan_code,status,trial_ends_at,current_period_end)
      VALUES ($1,'e2e_supplier_'||$2,'e2e_supplier_sub_'||$2,'e2e_supplier_price','supplier','trialing',now()+interval '7 days',now()+interval '7 days')`,[p.id,phone]);
    await env.ctx.db.query(`INSERT INTO marketplace.supplier_availability(supplier_id,staff_id,starts_at,ends_at) VALUES ($1,$2,now(),now()+interval '60 days')`,[p.id,s.userId]);
    await env.ctx.db.query(`INSERT INTO marketplace.supplier_services(supplier_id,name,category,description,area_codes,duration_minutes,price_policy,status,source)
      VALUES ($1,'買い物支援','shopping_assist','近所での買い物をお手伝いします',ARRAY['13101'],60,'試験用・請求なし','published','manual')`,[p.id]);
    fixtures.supplier={phone,userId:s.userId,supplierId:p.id};
  }
}
await env.ctx.db.query('DELETE FROM otp_challenges');

await env.app.listen({host:'127.0.0.1',port:8095});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{void env.close().then(()=>process.exit(0));});
