import type { AppContext, HandlerMap, HdRequest } from '../../context.js';
import { body, params, requireUser } from '../../context.js';
import { withIdempotency } from '../../lib/idempotency.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { normalizePhone } from '../../lib/phone.js';
import { recordEvent } from '../../lib/events.js';
import { notify } from '../../lib/notify.js';
import { member } from './domain.js';
import { visibleRequest } from './handlers.js';

function admin(req:HdRequest,write=false) {
 const u=requireUser(req);
 if (write ? !u.roles.includes('admin_operator') : !u.roles.some(r=>r.startsWith('admin_'))) throw forbidden();
 return u.id;
}
async function mutate(ctx:AppContext,req:HdRequest,reply:Parameters<HandlerMap[string]>[2],op:string,fn:Parameters<typeof withIdempotency>[3]) {
 const result=await withIdempotency(ctx,req,op,fn);reply.code(result.status);return result.body;
}
const fields=(req:HdRequest)=>params<{supplierId:string;requestId:string;inviteId:string;memberId:string;reviewId:string}>(req);
interface Application {businessCategory:string;registrationNumber?:string;areaCodes:string[];openingHours:string;insuranceSummary:string;contactEmail:string;description:string;evidenceIds:string[]}
export const marketplaceOperations:HandlerMap={
 async marketplaceSupplierApplication(ctx,req) {
  const {supplierId}=fields(req);await member(ctx.db,requireUser(req).id,supplierId,true);
  const s=(await ctx.db.query('SELECT legal_name,review_status,address_ciphertext FROM marketplace.suppliers WHERE id=$1',[supplierId])).rows[0];
  const a=(await ctx.db.query('SELECT * FROM marketplace.supplier_applications WHERE supplier_id=$1',[supplierId])).rows[0];
  return {supplierId,legalName:s.legal_name,reviewStatus:s.review_status,address:ctx.cipher.decryptNullable(s.address_ciphertext)??'',application:a?ctx.cipher.decryptJson(a.details_ciphertext):null,evidenceIds:a?.evidence_ids??[],reviewReason:a?.review_reason??null};
 },
 async marketplaceSubmitApplication(ctx,req,reply) {
  const actor=requireUser(req).id;const {supplierId}=fields(req);const b=body<Application>(req);
  return mutate(ctx,req,reply,'marketplaceSubmitApplication',async c=>{
   await member(c,actor,supplierId,true);
   const s=(await c.query('SELECT review_status FROM marketplace.suppliers WHERE id=$1 FOR UPDATE',[supplierId])).rows[0];
   if(s.review_status==='approved'||s.review_status==='invited_unverified')throw conflict('application_locked','承認済み・招待候補の事業者はサポートへお問い合わせください');
   const evidence=await c.query(`SELECT id FROM evidence WHERE id=ANY($1) AND uploaded_by=$2 AND status='verified' AND deleted_at IS NULL AND purpose IN ('identity_document','skill_document') AND expires_at>now()`,[b.evidenceIds,actor]);
   if(evidence.rowCount!==new Set(b.evidenceIds).size)throw badRequest('invalid_documents','本人がアップロードした有効な確認書類を選択してください');
   const {evidenceIds,...details}=b;
   await c.query(`INSERT INTO marketplace.supplier_applications(supplier_id,details_ciphertext,evidence_ids) VALUES ($1,$2,$3) ON CONFLICT(supplier_id) DO UPDATE SET details_ciphertext=EXCLUDED.details_ciphertext,evidence_ids=EXCLUDED.evidence_ids,submitted_at=now(),reviewed_at=NULL,reviewed_by=NULL,review_reason=NULL`,[supplierId,ctx.cipher.encryptJson(details),evidenceIds]);
   await c.query(`UPDATE marketplace.suppliers SET review_status='pending' WHERE id=$1`,[supplierId]);
   await recordEvent(c,{entityType:'marketplace_supplier',entityId:supplierId,eventType:'application_submitted',actor:{id:actor,role:'supplier'}});
   return {status:200,body:{id:supplierId,status:'pending'}};
  });
 },
 async marketplaceInvitations(ctx,req) {
  const {supplierId}=fields(req);await member(ctx.db,requireUser(req).id,supplierId,true);
  return {items:(await ctx.db.query(`SELECT id,phone_ciphertext,role,expires_at AS "expiresAt",accepted_at AS "acceptedAt",revoked_at AS "revokedAt" FROM marketplace.staff_invitations WHERE supplier_id=$1 ORDER BY created_at DESC LIMIT 100`,[supplierId])).rows.map(r=>{const {phone_ciphertext,...rest}=r;return {...rest,phone:ctx.cipher.decrypt(phone_ciphertext)};})};
 },
 async marketplaceInviteStaff(ctx,req,reply) {
  const actor=requireUser(req).id;const {supplierId}=fields(req);const b=body<{phone:string;role:'manager'|'staff'}>(req);const phone=normalizePhone(b.phone);const hash=ctx.cipher.blindIndex(phone);
  return mutate(ctx,req,reply,'marketplaceInviteStaff',async c=>{
   const manager=await member(c,actor,supplierId,true);
   if(b.role==='manager'&&manager.role!=='owner')throw forbidden('管理者の招待はオーナーのみ可能です');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[supplierId+hash.toString('hex')]);
   await c.query(`UPDATE marketplace.staff_invitations SET revoked_at=now() WHERE supplier_id=$1 AND phone_hash=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,[supplierId,hash]);
   const token=randomToken();const expiresAt=new Date(Date.now()+7*86400_000);
   const r=(await c.query(`INSERT INTO marketplace.staff_invitations(supplier_id,phone_hash,phone_ciphertext,role,token_hash,invited_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[supplierId,hash,ctx.cipher.encrypt(phone),b.role,sha256(token),actor,expiresAt])).rows[0];
   await recordEvent(c,{entityType:'marketplace_supplier',entityId:supplierId,eventType:'staff_invited',actor:{id:actor,role:manager.role}});
   return {status:201,body:{id:r.id,token,expiresAt:expiresAt.toISOString()}};
  });
 },
 async marketplaceRevokeInvitation(ctx,req,reply) {
  const actor=requireUser(req).id;const {supplierId,inviteId}=fields(req);
  return mutate(ctx,req,reply,'marketplaceRevokeInvitation',async c=>{
   await member(c,actor,supplierId,true);
   const r=await c.query(`UPDATE marketplace.staff_invitations SET revoked_at=now() WHERE id=$1 AND supplier_id=$2 AND accepted_at IS NULL RETURNING id`,[inviteId,supplierId]);if(!r.rowCount)throw notFound();
   await recordEvent(c,{entityType:'marketplace_supplier',entityId:supplierId,eventType:'invitation_revoked',actor:{id:actor,role:'supplier'}});
   return {status:200,body:{id:inviteId,status:'revoked'}};
  });
 },
 async marketplaceJoinSupplier(ctx,req,reply) {
  const actor=requireUser(req).id;const b=body<{token:string}>(req);
  return mutate(ctx,req,reply,'marketplaceJoinSupplier',async c=>{
   const i=(await c.query('SELECT * FROM marketplace.staff_invitations WHERE token_hash=$1 FOR UPDATE',[sha256(b.token)])).rows[0];
   if(!i||i.accepted_at||i.revoked_at||i.expires_at<=new Date())throw conflict('invitation_invalid','招待が無効です。管理者に再発行を依頼してください');
   if(!(await c.query('SELECT 1 FROM marketplace.users WHERE id=$1 AND phone_hash=$2 AND phone_verified_at IS NOT NULL AND deleted_at IS NULL',[actor,i.phone_hash])).rowCount)throw forbidden('招待された電話番号を確認してプロフィールを登録してください','invitation_phone_mismatch');
   const previous=(await c.query('SELECT role FROM marketplace.supplier_members WHERE supplier_id=$1 AND user_id=$2',[i.supplier_id,actor])).rows[0];
   if(previous?.role==='owner')throw conflict('owner_locked','オーナーの権限は変更できません');
   await c.query(`INSERT INTO marketplace.supplier_members(supplier_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT(supplier_id,user_id) DO UPDATE SET active=true,role=EXCLUDED.role`,[i.supplier_id,actor,i.role]);
   await c.query('UPDATE marketplace.staff_invitations SET accepted_by=$2,accepted_at=now() WHERE id=$1',[i.id,actor]);
   await c.query(`INSERT INTO marketplace.user_roles(user_id,role) VALUES ($1,'supplier') ON CONFLICT DO NOTHING`,[actor]);
   await recordEvent(c,{entityType:'marketplace_supplier',entityId:i.supplier_id,eventType:'staff_joined',actor:{id:actor,role:i.role}});
   return {status:200,body:{id:i.supplier_id,status:'joined'}};
  });
 },
 async marketplaceDeactivateMember(ctx,req,reply) {
  const actor=requireUser(req).id;const {supplierId,memberId}=fields(req);
  return mutate(ctx,req,reply,'marketplaceDeactivateMember',async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`staff:${memberId}`]);
   const manager=await member(c,actor,supplierId,true);const target=await member(c,memberId,supplierId);
   if(target.role==='owner'||(target.role==='manager'&&manager.role!=='owner'))throw forbidden();
   if((await c.query(`SELECT 1 FROM marketplace.requests WHERE assigned_staff_id=$1 AND status IN ('accepted','en_route','arrived','in_progress','awaiting_customer_confirmation','disputed')`,[memberId])).rowCount)throw conflict('active_assignments','担当中の依頼があります。運営に引継ぎを相談してください');
   await c.query('UPDATE marketplace.supplier_members SET active=false WHERE supplier_id=$1 AND user_id=$2',[supplierId,memberId]);
   await c.query('UPDATE marketplace.supplier_availability SET active=false WHERE supplier_id=$1 AND staff_id=$2',[supplierId,memberId]);
   await recordEvent(c,{entityType:'marketplace_supplier',entityId:supplierId,eventType:'staff_deactivated',actor:{id:actor,role:manager.role},reason:body<{reason:string}>(req).reason});
   return {status:200,body:{id:memberId,status:'inactive'}};
  });
 },
 async marketplaceSchedule(ctx,req) {
  const actor=requireUser(req).id;const {supplierId}=fields(req);const m=await member(ctx.db,actor,supplierId);
  return {items:(await ctx.db.query(`SELECT a.id,a.staff_id AS "staffId",u.family_name||' '||u.given_name AS "staffName",a.starts_at AS "startsAt",a.ends_at AS "endsAt" FROM marketplace.supplier_availability a JOIN marketplace.users u ON u.id=a.staff_id WHERE a.supplier_id=$1 AND a.active AND ($2 OR a.staff_id=$3) ORDER BY a.starts_at LIMIT 200`,[supplierId,['owner','manager'].includes(m.role),actor])).rows};
 },
 async marketplaceDeleteAvailability(ctx,req,reply) {
  const actor=requireUser(req).id;const {supplierId}=fields(req);const {availabilityId}=params<{availabilityId:string}>(req);
  return mutate(ctx,req,reply,'marketplaceDeleteAvailability',async c=>{
   await member(c,actor,supplierId,true);const r=await c.query('UPDATE marketplace.supplier_availability SET active=false WHERE supplier_id=$1 AND id=$2 RETURNING id',[supplierId,availabilityId]);if(!r.rowCount)throw notFound();
   await recordEvent(c,{entityType:'marketplace_supplier',entityId:supplierId,eventType:'availability_removed',actor:{id:actor,role:'supplier'}});return {status:200,body:{id:availabilityId,status:'removed'}};
  });
 },
 async marketplaceAdminOverview(ctx,req) {
  admin(req);const suppliers=(await ctx.db.query(`SELECT s.id,s.legal_name AS "legalName",s.review_status AS "reviewStatus",s.supplier_type AS "supplierType",a.submitted_at AS "submittedAt",a.evidence_ids AS "evidenceIds" FROM marketplace.suppliers s LEFT JOIN marketplace.supplier_applications a ON a.supplier_id=s.id ORDER BY s.created_at DESC LIMIT 200`)).rows;
  const services=(await ctx.db.query(`SELECT s.id,s.name,s.category,s.status,p.legal_name AS "supplierName",s.supplier_id AS "supplierId",s.description,s.price_policy AS "pricePolicy" FROM marketplace.supplier_services s JOIN marketplace.suppliers p ON p.id=s.supplier_id WHERE s.status IN ('pending_review','paused') ORDER BY s.created_at DESC LIMIT 200`)).rows;
  const disputes=(await ctx.db.query(`SELECT r.id,r.title,r.status,r.starts_at AS "startsAt",r.accepted_supplier_id AS "supplierId",d.id AS "reviewId",d.proposed_by AS "proposedBy",d.proposed_decision AS "proposedDecision",d.reason,d.evidence_summary AS "evidenceSummary" FROM marketplace.requests r LEFT JOIN marketplace.dispute_reviews d ON d.request_id=r.id AND d.approved_by IS NULL AND d.rejected_by IS NULL WHERE r.status='disputed' ORDER BY r.created_at LIMIT 200`)).rows;
  return {suppliers,services,disputes};
 },
 async marketplaceAdminSupplier(ctx,req) {
  admin(req,true);const {supplierId}=fields(req);
  const s=(await ctx.db.query('SELECT * FROM marketplace.suppliers WHERE id=$1',[supplierId])).rows[0];if(!s)throw notFound();
  const a=(await ctx.db.query('SELECT * FROM marketplace.supplier_applications WHERE supplier_id=$1',[supplierId])).rows[0];
  return {id:s.id,legalName:s.legal_name,reviewStatus:s.review_status,address:ctx.cipher.decryptNullable(s.address_ciphertext)??'',application:a?ctx.cipher.decryptJson(a.details_ciphertext):null,evidenceIds:a?.evidence_ids??[]};
 },
 async marketplaceAdminReviewSupplier(ctx,req,reply) {
  const actor=admin(req,true);const {supplierId}=fields(req);const b=body<{decision:'approved'|'rejected';reason:string}>(req);
  return mutate(ctx,req,reply,'marketplaceAdminReviewSupplier',async c=>{
   const s=(await c.query('SELECT * FROM marketplace.suppliers WHERE id=$1 FOR UPDATE',[supplierId])).rows[0];if(!s)throw notFound();
   const a=(await c.query('SELECT * FROM marketplace.supplier_applications WHERE supplier_id=$1',[supplierId])).rows[0];
   if(s.review_status!=='pending'||!a)throw conflict('application_missing','審査待ちの申請が必要です');
   if(b.decision==='approved'&&(!a.evidence_ids.length||(await c.query(`SELECT 1 FROM evidence WHERE id=ANY($1) AND status='verified' AND deleted_at IS NULL AND expires_at>now()`,[a.evidence_ids])).rowCount!==a.evidence_ids.length))throw conflict('documents_required','有効な確認書類を確認してください');
   await c.query('UPDATE marketplace.suppliers SET review_status=$2 WHERE id=$1',[supplierId,b.decision]);await c.query('UPDATE marketplace.supplier_applications SET reviewed_at=now(),reviewed_by=$2,review_reason=$3 WHERE supplier_id=$1',[supplierId,actor,b.reason]);
   if(b.decision==='rejected')await c.query(`UPDATE marketplace.supplier_services SET status='paused' WHERE supplier_id=$1 AND status='published'`,[supplierId]);
   await recordEvent(c,{entityType:'marketplace_supplier',entityId:supplierId,eventType:b.decision,actor:{id:actor,role:'admin_operator'},reason:b.reason});
   if(s.contact_user_id)await notify(c,[s.contact_user_id],{type:'marketplace_supplier',title:'事業者審査が更新されました',body:'申請画面で結果を確認してください',entityType:'marketplace_supplier',entityId:supplierId});
   return {status:200,body:{id:supplierId,status:b.decision}};
  });
 },
 async marketplaceAdminDispute(ctx,req) {
  admin(req,true);const {requestId}=fields(req);const r=(await ctx.db.query('SELECT * FROM marketplace.requests WHERE id=$1 AND status=\'disputed\'',[requestId])).rows[0];if(!r)throw notFound();
  return {id:r.id,title:r.title,status:r.status,details:ctx.cipher.decrypt(r.details_ciphertext),address:ctx.cipher.decrypt(r.address_ciphertext),messages:(await ctx.db.query('SELECT sender_id,body_ciphertext,created_at FROM marketplace.messages WHERE request_id=$1 ORDER BY created_at LIMIT 200',[requestId])).rows.map(m=>({senderId:m.sender_id,body:ctx.cipher.decrypt(m.body_ciphertext),createdAt:m.created_at}))};
 },
 async marketplaceProposeResolution(ctx,req,reply) {
  const actor=admin(req,true);const {requestId}=fields(req);const b=body<{decision:string;reason:string;evidenceSummary:string}>(req);
  return mutate(ctx,req,reply,'marketplaceProposeResolution',async c=>{
   const r=(await c.query('SELECT status FROM marketplace.requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];if(!r)throw notFound();if(r.status!=='disputed')throw conflict('not_disputed','紛争中の依頼のみ裁定できます');
   if((await c.query('SELECT 1 FROM marketplace.dispute_reviews WHERE request_id=$1 AND approved_by IS NULL AND rejected_by IS NULL',[requestId])).rowCount)throw conflict('review_pending','別の裁定案が確認待ちです');
   const review=(await c.query('INSERT INTO marketplace.dispute_reviews(request_id,proposed_decision,proposed_by,reason,evidence_summary) VALUES ($1,$2,$3,$4,$5) RETURNING id',[requestId,b.decision,actor,b.reason,b.evidenceSummary])).rows[0];
   await recordEvent(c,{entityType:'marketplace_request',entityId:requestId,eventType:'resolution_proposed',actor:{id:actor,role:'admin_operator'},reason:b.reason});return {status:201,body:{id:review.id,status:'pending'}};
  });
 },
 async marketplaceApproveResolution(ctx,req,reply) {
  const actor=admin(req,true);const {requestId,reviewId}=fields(req);const b=body<{approve:boolean;reason:string}>(req);
  return mutate(ctx,req,reply,'marketplaceApproveResolution',async c=>{
   const r=(await c.query('SELECT * FROM marketplace.requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
   const d=(await c.query('SELECT * FROM marketplace.dispute_reviews WHERE id=$1 AND request_id=$2 FOR UPDATE',[reviewId,requestId])).rows[0];
   if(!r||!d)throw notFound();if(d.proposed_by===actor)throw forbidden('裁定案を作成した本人は承認できません','two_person_required');
   if(r.status!=='disputed'||d.approved_by||d.rejected_by)throw conflict('review_closed','この裁定案は確認済みです');
   await c.query(`UPDATE marketplace.dispute_reviews SET approved_by=$2,rejected_by=$3,decided_at=now() WHERE id=$1`,[reviewId,b.approve?actor:null,b.approve?null:actor]);
   if(b.approve){
    await c.query('UPDATE marketplace.requests SET status=$2,completed_at=CASE WHEN $2=\'resolved_completed\' THEN now() ELSE NULL END WHERE id=$1',[requestId,d.proposed_decision]);
    const quota=await c.query('UPDATE marketplace.quota_reservations SET state=$2,updated_at=now() WHERE request_id=$1 AND state=\'held_dispute\' RETURNING request_id',[requestId,d.proposed_decision==='resolved_completed'?'consumed':'released']);if(!quota.rowCount)throw conflict('quota_invalid','保留中の依頼枠がありません');
    await notify(c,[r.customer_id,...(r.assigned_staff_id?[r.assigned_staff_id]:[])],{type:'marketplace_request',title:'異議申立ての確認が完了しました',body:'依頼履歴で結果を確認してください',entityType:'marketplace_request',entityId:requestId});
   }
   await recordEvent(c,{entityType:'marketplace_request',entityId:requestId,eventType:b.approve?d.proposed_decision:'resolution_rejected',actor:{id:actor,role:'admin_operator'},reason:b.reason,payload:{reviewId,proposedBy:d.proposed_by}});
   return {status:200,body:{id:requestId,status:b.approve?d.proposed_decision:'disputed'}};
  });
 },
 async marketplaceRate(ctx,req,reply) {
  const actor=requireUser(req).id;const {requestId}=fields(req);const b=body<{score:number;comment?:string}>(req);
  return mutate(ctx,req,reply,'marketplaceRate',async c=>{
   const r=(await c.query('SELECT * FROM marketplace.requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];if(!r||r.customer_id!==actor)throw notFound();if(!['completed','resolved_completed'].includes(r.status))throw conflict('not_completed','完了した依頼のみ評価できます');
   if((await c.query('SELECT 1 FROM marketplace.ratings WHERE request_id=$1',[requestId])).rowCount)throw conflict('already_rated','この依頼は評価済みです');
   await c.query('INSERT INTO marketplace.ratings(request_id,customer_id,supplier_id,score,comment_ciphertext) VALUES ($1,$2,$3,$4,$5)',[requestId,actor,r.accepted_supplier_id,b.score,ctx.cipher.encryptNullable(b.comment)]);
   await recordEvent(c,{entityType:'marketplace_request',entityId:requestId,eventType:'rated',actor:{id:actor,role:'customer'}});return {status:200,body:{id:requestId,status:'rated'}};
  });
 },
 async marketplaceRating(ctx,req) {
  const {requestId}=fields(req);await visibleRequest(ctx,req,requestId);const r=(await ctx.db.query('SELECT score,comment_ciphertext,created_at AS "createdAt" FROM marketplace.ratings WHERE request_id=$1',[requestId])).rows[0];return {rating:r?{score:r.score,comment:ctx.cipher.decryptNullable(r.comment_ciphertext)??null,createdAt:r.createdAt}:null};
 }
};
