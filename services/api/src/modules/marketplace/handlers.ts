import type { HandlerMap, AppContext, HdRequest } from '../../context.js';
import { body, params, requireUser } from '../../context.js';
import { withIdempotency } from '../../lib/idempotency.js';
import { forbidden, notFound, unavailable, badRequest } from '../../lib/errors.js';
import { recordEvent } from '../../lib/events.js';
import { PLANS, reserveRequest, acceptRequest, advanceRequest, issueCompletion, confirmCompletion, cancelRequest, member, type RequestInput } from './domain.js';

async function mutation(ctx: AppContext, req: HdRequest, op: string, fn: Parameters<typeof withIdempotency>[3]) {
  return withIdempotency(ctx,req,op,fn);
}
const admin = (req: HdRequest) => { if (!requireUser(req).roles.includes('admin_operator')) throw forbidden(); };

export async function visibleRequest(ctx: AppContext,req: HdRequest,id: string) {
  const actor=requireUser(req).id;
  const r=(await ctx.db.query(`SELECT r.*,s.name AS service_name,p.legal_name AS supplier_name FROM marketplace.requests r
    JOIN marketplace.supplier_services s ON s.id=r.service_id LEFT JOIN marketplace.suppliers p ON p.id=r.accepted_supplier_id WHERE r.id=$1`,[id])).rows[0];
  if (!r) throw notFound();
  const own=r.customer_id===actor;
  const m=r.accepted_supplier_id ? (await ctx.db.query('SELECT role FROM marketplace.supplier_members WHERE user_id=$1 AND supplier_id=$2 AND active',[actor,r.accepted_supplier_id])).rows[0] : undefined;
  const assigned=r.assigned_staff_id===actor;
  const management=m && ['owner','manager'].includes(m.role);
  if (!own && !assigned && !management) throw notFound();
  return { id:r.id,title:r.title,status:r.status,serviceName:r.service_name,supplierName:r.supplier_name ?? null,areaCode:r.public_area_code,
    startsAt:r.starts_at,endsAt:r.ends_at,totalChargeYen:r.total_charge_yen,customerId:r.customer_id,supplierId:r.accepted_supplier_id,
    staffId:r.assigned_staff_id,details:ctx.cipher.decrypt(r.details_ciphertext),address:ctx.cipher.decrypt(r.address_ciphertext) };
}

export const marketplaceHandlers: HandlerMap = {
  async marketplacePlans() { return { items:PLANS, supplierTrialDays:7, pricingStatus:'commercial_decision_pending', checkoutAvailable:false }; },
  async marketplaceMe(ctx,req) {
    const actor=requireUser(req).id;
    const profile=(await ctx.db.query('SELECT family_name,given_name,email,phone_verified_at FROM marketplace.users WHERE id=$1',[actor])).rows[0];
    const roles=(await ctx.db.query('SELECT role FROM marketplace.user_roles WHERE user_id=$1',[actor])).rows.map(x=>x.role);
    const suppliers=(await ctx.db.query(`SELECT s.id,s.legal_name AS "legalName",s.review_status AS "reviewStatus",m.role FROM marketplace.suppliers s
      JOIN marketplace.supplier_members m ON m.supplier_id=s.id WHERE m.user_id=$1 AND m.active`,[actor])).rows;
    const subscription=(await ctx.db.query(`SELECT plan_code AS "planCode",status,trial_ends_at AS "trialEndsAt",current_period_end AS "currentPeriodEnd",cancel_at_period_end AS "cancelAtPeriodEnd"
      FROM marketplace.subscriptions WHERE customer_user_id=$1 ORDER BY last_stripe_sync_at DESC LIMIT 1`,[actor])).rows[0] ?? null;
    return {userId:actor,profile:profile ? {familyName:profile.family_name,givenName:profile.given_name,email:profile.email,phoneVerified:!!profile.phone_verified_at}:null,roles,suppliers,subscription};
  },
  async marketplaceRegisterCustomer(ctx,req,reply) {
    const actor=requireUser(req).id;
    const b=body<{familyName:string;givenName:string;email?:string;address:string}>(req);
    const result=await mutation(ctx,req,'marketplaceRegisterCustomer',async c=>{
      const u=(await c.query('SELECT phone_hash,phone_ciphertext FROM app_users WHERE id=$1',[actor])).rows[0];
      if (!u.phone_hash || !(await c.query('SELECT 1 FROM otp_challenges WHERE phone_hash=$1 AND consumed_at IS NOT NULL',[u.phone_hash])).rowCount) throw forbidden('電話番号をSMSで確認してください','phone_verification_required');
      await c.query(`INSERT INTO marketplace.users(id,family_name,given_name,phone_hash,phone_ciphertext,email,address_ciphertext,phone_verified_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(id) DO UPDATE SET family_name=EXCLUDED.family_name,given_name=EXCLUDED.given_name,
        email=EXCLUDED.email,address_ciphertext=EXCLUDED.address_ciphertext`,[actor,b.familyName,b.givenName,u.phone_hash,u.phone_ciphertext,b.email ?? null,ctx.cipher.encrypt(b.address)]);
      await c.query(`INSERT INTO marketplace.user_roles(user_id,role) VALUES ($1,'customer') ON CONFLICT DO NOTHING`,[actor]);
      await recordEvent(c,{entityType:'marketplace_user',entityId:actor,eventType:'customer_registered',actor:{id:actor,role:'customer'}});
      return {status:200,body:{id:actor,role:'customer'}};
    });reply.code(result.status);return result.body;
  },
  async marketplaceCatalog(ctx) {
    const items=(await ctx.db.query(`SELECT s.id,s.supplier_id AS "supplierId",s.name,s.category,s.description,s.area_codes AS "areaCodes",
      s.duration_minutes AS "durationMinutes",s.price_policy AS "pricePolicy",p.legal_name AS "supplierName" FROM marketplace.supplier_services s
      JOIN marketplace.suppliers p ON p.id=s.supplier_id WHERE s.status='published' AND p.review_status='approved' ORDER BY s.name LIMIT 200`)).rows;
    return {items};
  },
  async marketplaceRegisterSupplier(ctx,req,reply) {
    const actor=requireUser(req).id;
    const b=body<{legalName:string;supplierType:string;address:string}>(req);
    const result=await mutation(ctx,req,'marketplaceRegisterSupplier',async c=>{
      if (!(await c.query('SELECT 1 FROM marketplace.users WHERE id=$1 AND deleted_at IS NULL',[actor])).rowCount) throw forbidden('電話番号とプロフィールを登録してください');
      const r=(await c.query(`INSERT INTO marketplace.suppliers(legal_name,supplier_type,review_status,address_ciphertext,contact_user_id)
        VALUES ($1,$2,'pending',$3,$4) RETURNING id`,[b.legalName,b.supplierType,ctx.cipher.encrypt(b.address),actor])).rows[0];
      await c.query(`INSERT INTO marketplace.supplier_members(supplier_id,user_id,role) VALUES ($1,$2,'owner')`,[r.id,actor]);
      await c.query(`INSERT INTO marketplace.user_roles(user_id,role) VALUES ($1,'supplier') ON CONFLICT DO NOTHING`,[actor]);
      await recordEvent(c,{entityType:'marketplace_supplier',entityId:r.id,eventType:'registration_submitted',actor:{id:actor,role:'supplier'}});
      return {status:201,body:{id:r.id,status:'pending'}};
    });reply.code(result.status);return result.body;
  },
  async marketplaceSupplierMembers(ctx,req) {
    const {supplierId}=params<{supplierId:string}>(req);await member(ctx.db,requireUser(req).id,supplierId,true);
    return {items:(await ctx.db.query(`SELECT m.user_id AS id,u.family_name AS "familyName",u.given_name AS "givenName",m.role
      FROM marketplace.supplier_members m JOIN marketplace.users u ON u.id=m.user_id WHERE m.supplier_id=$1 AND m.active AND u.deleted_at IS NULL ORDER BY m.role`,[supplierId])).rows};
  },
  async marketplaceAvailability(ctx,req,reply) {
    const actor=requireUser(req).id;const {supplierId}=params<{supplierId:string}>(req);
    const b=body<{staffId:string;startsAt:string;endsAt:string}>(req);
    if (Date.parse(b.endsAt)<=Date.parse(b.startsAt)) throw badRequest('invalid_schedule','開始と終了を確認してください');
    const result=await mutation(ctx,req,'marketplaceAvailability',async c=>{
      await member(c,actor,supplierId,true);await member(c,b.staffId,supplierId);
      const r=(await c.query(`INSERT INTO marketplace.supplier_availability(supplier_id,staff_id,starts_at,ends_at) VALUES ($1,$2,$3,$4) RETURNING id`,[supplierId,b.staffId,b.startsAt,b.endsAt])).rows[0];
      await recordEvent(c,{entityType:'marketplace_supplier',entityId:supplierId,eventType:'availability_added',actor:{id:actor,role:'supplier'}});
      return {status:201,body:{id:r.id}};
    });reply.code(result.status);return result.body;
  },
  async marketplaceRequests(ctx,req) {
    const items=(await ctx.db.query(`SELECT r.id,r.title,r.status,r.public_area_code AS "areaCode",r.starts_at AS "startsAt",r.ends_at AS "endsAt",s.name AS "serviceName"
      FROM marketplace.requests r JOIN marketplace.supplier_services s ON s.id=r.service_id WHERE r.customer_id=$1
      OR r.assigned_staff_id=$1 OR EXISTS(SELECT 1 FROM marketplace.supplier_members m WHERE m.user_id=$1 AND m.active AND m.role IN ('owner','manager') AND m.supplier_id=r.accepted_supplier_id)
      ORDER BY r.created_at DESC LIMIT 200`,[requireUser(req).id])).rows;
    return {items};
  },
  async marketplaceRequest(ctx,req) { return visibleRequest(ctx,req,params<{requestId:string}>(req).requestId); },
  async marketplacePostRequest(ctx,req,reply) {
    const result=await mutation(ctx,req,'marketplacePostRequest',async c=>({status:201,body:await reserveRequest(ctx,c,requireUser(req).id,body<RequestInput>(req))}));
    reply.code(result.status);return result.body;
  },
  async marketplaceFeed(ctx,req) {
    const {supplierId}=params<{supplierId:string}>(req);await member(ctx.db,requireUser(req).id,supplierId);
    const items=(await ctx.db.query(`SELECT r.id,r.title,r.public_area_code AS "areaCode",r.starts_at AS "startsAt",r.ends_at AS "endsAt",s.category,s.name AS "serviceName"
      FROM marketplace.requests r JOIN marketplace.supplier_services s ON s.id=r.service_id WHERE r.status='open' AND r.customer_id<>$2
      AND EXISTS(SELECT 1 FROM marketplace.supplier_services own WHERE own.supplier_id=$1 AND own.status='published' AND own.category=s.category AND r.public_area_code=ANY(own.area_codes))
      ORDER BY r.starts_at LIMIT 200`,[supplierId,requireUser(req).id])).rows;
    return {items};
  },
  async marketplaceAccept(ctx,req,reply) {
    const b=body<{supplierId:string;staffId:string}>(req);
    const result=await mutation(ctx,req,'marketplaceAccept',async c=>({status:200,body:await acceptRequest(c,requireUser(req).id,params<{requestId:string}>(req).requestId,b.supplierId,b.staffId)}));
    reply.code(result.status);return result.body;
  },
  async marketplaceAdvance(ctx,req,reply) {
    const result=await mutation(ctx,req,'marketplaceAdvance',async c=>({status:200,body:await advanceRequest(c,requireUser(req).id,params<{requestId:string}>(req).requestId,body<{status:string}>(req).status)}));
    reply.code(result.status);return result.body;
  },
  async marketplaceIssueQr(ctx,req,reply) {
    const result=await mutation(ctx,req,'marketplaceIssueQr',async c=>({status:200,body:await issueCompletion(c,requireUser(req).id,params<{requestId:string}>(req).requestId)}));
    reply.code(result.status);return result.body;
  },
  async marketplaceConfirmQr(ctx,req,reply) {
    const result=await mutation(ctx,req,'marketplaceConfirmQr',async c=>({status:200,body:await confirmCompletion(c,requireUser(req).id,params<{requestId:string}>(req).requestId,body<{token:string}>(req).token)}));
    reply.code(result.status);return result.body;
  },
  async marketplaceCancel(ctx,req,reply) {
    const result=await mutation(ctx,req,'marketplaceCancel',async c=>({status:200,body:await cancelRequest(c,requireUser(req).id,params<{requestId:string}>(req).requestId,body<{reason:string}>(req).reason)}));
    reply.code(result.status);return result.body;
  },
  async marketplaceServices(ctx,req) {
    const {supplierId}=params<{supplierId:string}>(req);await member(ctx.db,requireUser(req).id,supplierId);
    return {items:(await ctx.db.query(`SELECT id,name,category,description,area_codes AS "areaCodes",duration_minutes AS "durationMinutes",price_policy AS "pricePolicy",status,source
      FROM marketplace.supplier_services WHERE supplier_id=$1 ORDER BY created_at DESC LIMIT 200`,[supplierId])).rows};
  },
  async marketplaceCreateService(ctx,req,reply) {
    const actor=requireUser(req).id;const {supplierId}=params<{supplierId:string}>(req);
    const b=body<{name:string;category:string;description:string;areaCodes:string[];durationMinutes:number;pricePolicy:string}>(req);
    if (['healthcare','personal_care'].includes(b.category)) throw forbidden('資格・許認可の確認後に提供できます','restricted_category');
    const result=await mutation(ctx,req,'marketplaceCreateService',async c=>{
      await member(c,actor,supplierId,true);
      const r=(await c.query(`INSERT INTO marketplace.supplier_services(supplier_id,name,category,description,area_codes,duration_minutes,price_policy,status,source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_review','manual') RETURNING id`,[supplierId,b.name,b.category,b.description,b.areaCodes,b.durationMinutes,b.pricePolicy])).rows[0];
      await recordEvent(c,{entityType:'marketplace_service',entityId:r.id,eventType:'submitted',actor:{id:actor,role:'supplier'}});
      return {status:201,body:{id:r.id,status:'pending_review'}};
    });reply.code(result.status);return result.body;
  },
  async marketplaceReviewService(ctx,req,reply) {
    admin(req);const actor=requireUser(req).id;const {serviceId}=params<{serviceId:string}>(req);
    const b=body<{decision:string;reason:string}>(req);
    const result=await mutation(ctx,req,'marketplaceReviewService',async c=>{
      const s=(await c.query('SELECT s.*,p.review_status FROM marketplace.supplier_services s JOIN marketplace.suppliers p ON p.id=s.supplier_id WHERE s.id=$1 FOR UPDATE OF s',[serviceId])).rows[0];
      if (!s) throw notFound();
      if (b.decision==='published' && (s.review_status!=='approved' || ['healthcare','personal_care'].includes(s.category))) throw forbidden('公開条件を満たしていません');
      await c.query('UPDATE marketplace.supplier_services SET status=$2,reviewed_by=$3 WHERE id=$1',[serviceId,b.decision,actor]);
      await recordEvent(c,{entityType:'marketplace_service',entityId:serviceId,eventType:b.decision,actor:{id:actor,role:'admin_operator'},reason:b.reason});
      return {status:200,body:{id:serviceId,status:b.decision}};
    });reply.code(result.status);return result.body;
  },
  async marketplaceCheckout() { throw unavailable('commercial_decision_pending','供給者価格・個別料金・契約条件が承認されるまで決済は開始できません'); },
  async marketplaceMessages(ctx,req) {
    const {requestId}=params<{requestId:string}>(req);await visibleRequest(ctx,req,requestId);
    return {items:(await ctx.db.query('SELECT id,sender_id,body_ciphertext,created_at FROM marketplace.messages WHERE request_id=$1 ORDER BY created_at LIMIT 200',[requestId])).rows.map(r=>({id:r.id,senderId:r.sender_id,body:ctx.cipher.decrypt(r.body_ciphertext),createdAt:r.created_at}))};
  },
  async marketplaceSendMessage(ctx,req,reply) {
    const actor=requireUser(req).id;const {requestId}=params<{requestId:string}>(req);await visibleRequest(ctx,req,requestId);
    const result=await mutation(ctx,req,'marketplaceSendMessage',async c=>{
      const r=(await c.query(`INSERT INTO marketplace.messages(request_id,sender_id,body_ciphertext) VALUES ($1,$2,$3) RETURNING id`,[requestId,actor,ctx.cipher.encrypt(body<{body:string}>(req).body)])).rows[0];
      return {status:201,body:{id:r.id}};
    });reply.code(result.status);return result.body;
  },
  async marketplaceDispute(ctx,req,reply) {
    const actor=requireUser(req).id;const {requestId}=params<{requestId:string}>(req);await visibleRequest(ctx,req,requestId);
    const result=await mutation(ctx,req,'marketplaceDispute',async c=>{
      const r=(await c.query('SELECT status FROM marketplace.requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
      if (!['accepted','en_route','arrived','in_progress','awaiting_customer_confirmation'].includes(r.status)) throw badRequest('invalid_transition','この依頼は異議申立てできません');
      await c.query(`UPDATE marketplace.requests SET status='disputed' WHERE id=$1`,[requestId]);
      await c.query(`UPDATE marketplace.quota_reservations SET state='held_dispute',updated_at=now() WHERE request_id=$1`,[requestId]);
      await c.query('UPDATE marketplace.completion_tokens SET revoked_at=now() WHERE request_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',[requestId]);
      await recordEvent(c,{entityType:'marketplace_request',entityId:requestId,eventType:'disputed',actor:{id:actor,role:'marketplace'},reason:body<{reason:string}>(req).reason});
      return {status:200,body:{id:requestId,status:'disputed'}};
    });reply.code(result.status);return result.body;
  },
};
