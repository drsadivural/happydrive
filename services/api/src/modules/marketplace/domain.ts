import type pg from 'pg';
import type { AppContext } from '../../context.js';
import { badRequest, conflict, forbidden, notFound, unavailable } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { recordEvent } from '../../lib/events.js';
import { notify } from '../../lib/notify.js';

export const PLANS = [
  { code: 'basic', name: 'ベーシック', monthlyYen: 1900, periodLimit: 5, dailyLimit: null, trialDays: 30 },
  { code: 'standard', name: 'スタンダード', monthlyYen: 4900, periodLimit: 12, dailyLimit: null, trialDays: 30 },
  { code: 'care', name: 'ケア', monthlyYen: 9900, periodLimit: null, dailyLimit: 2, trialDays: 30 },
] as const;
const ACTIVE = ['accepted', 'en_route', 'arrived', 'in_progress', 'awaiting_customer_confirmation'];
export type RequestInput = {
  serviceId: string; title: string; details: string; address: string; areaCode: string;
  startsAt: string; endsAt: string;
};

export async function member(c: pg.PoolClient | pg.Pool, actorId: string, supplierId: string, manage = false) {
  const r = await c.query(`SELECT role FROM marketplace.supplier_members WHERE supplier_id=$1 AND user_id=$2 AND active FOR SHARE`, [supplierId, actorId]);
  if (!r.rows[0] || (manage && !['owner', 'manager'].includes(r.rows[0].role))) throw forbidden();
  return r.rows[0];
}

async function event(c: pg.PoolClient, actorId: string, id: string, eventType: string) {
  await recordEvent(c, { entityType: 'marketplace_request', entityId: id, eventType, actor: { id: actorId, role: 'marketplace' } });
}

export async function reserveRequest(ctx: AppContext, c: pg.PoolClient, actorId: string, b: RequestInput) {
  if (ctx.cfg.publicPreview || (ctx.cfg.env !== 'test' && ctx.cfg.env !== 'development')) throw unavailable('commercial_decision_pending', '料金・契約条件の承認後に依頼受付を開始します');
  if (Date.parse(b.startsAt) <= Date.now() || Date.parse(b.endsAt) <= Date.parse(b.startsAt)) throw badRequest('invalid_schedule', '希望日時を確認してください');
  const profile = await c.query(`SELECT 1 FROM marketplace.user_roles WHERE user_id=$1 AND role='customer'`, [actorId]);
  if (!profile.rowCount) throw forbidden('顧客登録を完了してください');
  const s = (await c.query(`SELECT s.*,p.review_status FROM marketplace.supplier_services s JOIN marketplace.suppliers p ON p.id=s.supplier_id WHERE s.id=$1`, [b.serviceId])).rows[0];
  if (!s || s.status !== 'published' || s.review_status !== 'approved' || !s.area_codes.includes(b.areaCode)) throw conflict('service_unavailable', 'この地域ではサービスを利用できません');
  // Serializes all quota decisions for a customer across billing periods, including concurrent posts.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`customer:${actorId}`]);
  const p = (await c.query(`SELECT q.* FROM marketplace.quota_periods q JOIN marketplace.subscriptions s ON s.id=q.subscription_id
    WHERE s.customer_user_id=$1 AND s.status IN ('active','trialing') AND q.starts_at<=now() AND q.ends_at>now()
    AND (s.status<>'trialing' OR s.trial_ends_at>now()) AND s.current_period_end>now() FOR UPDATE OF q`, [actorId])).rows[0];
  if (!p) throw forbidden('有効な会員プランが必要です', 'subscription_required');
  const day = new Date(Date.parse(b.startsAt) + 9 * 3600_000).toISOString().slice(0, 10);
  const counts = (await c.query(`SELECT count(*)::int AS period_count, count(*) FILTER (WHERE scheduled_jst_date=$2)::int AS daily_count
    FROM marketplace.quota_reservations WHERE quota_period_id=$1 AND state IN ('reserved','consumed','held_dispute')`, [p.id, day])).rows[0];
  // Daily Care limits span period rollover; otherwise renewing a subscription doubles a day's limit.
  const daily = (await c.query(`SELECT count(*)::int AS n FROM marketplace.quota_reservations r JOIN marketplace.requests j ON j.id=r.request_id
    WHERE j.customer_id=$1 AND r.scheduled_jst_date=$2 AND r.state IN ('reserved','consumed','held_dispute')`, [actorId, day])).rows[0].n;
  if ((p.period_limit !== null && counts.period_count >= p.period_limit) || (p.daily_limit !== null && daily >= p.daily_limit)) throw conflict('quota_exceeded', '依頼枠の上限に達しています');
  // Prices have not been commercially approved. No service charge or transfer is guessed here.
  const r = (await c.query(`INSERT INTO marketplace.requests(customer_id,service_id,title,details_ciphertext,address_ciphertext,public_area_code,starts_at,ends_at,status,total_charge_yen)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',0) RETURNING id`, [actorId,b.serviceId,b.title,ctx.cipher.encrypt(b.details),ctx.cipher.encrypt(b.address),b.areaCode,b.startsAt,b.endsAt])).rows[0];
  await c.query(`INSERT INTO marketplace.quota_reservations(request_id,quota_period_id,scheduled_jst_date,state) VALUES ($1,$2,$3,'reserved')`, [r.id,p.id,day]);
  await event(c, actorId, r.id, 'posted');
  const recipients = (await c.query(`SELECT DISTINCT m.user_id FROM marketplace.supplier_members m
    JOIN marketplace.suppliers p ON p.id=m.supplier_id JOIN marketplace.supplier_services offer ON offer.supplier_id=p.id
    WHERE m.active AND p.review_status='approved' AND offer.status='published' AND offer.category=$1
    AND $2=ANY(offer.area_codes) AND m.user_id<>$3`,[s.category,b.areaCode,actorId])).rows.map(x=>x.user_id);
  await notify(c,recipients,{type:'marketplace_request',title:'新しい依頼があります',body:'対応可能な依頼を確認してください',entityType:'marketplace_request',entityId:r.id});
  return { id: r.id, status: 'open', pricingStatus: 'commercial_decision_pending' };
}

export async function acceptRequest(c: pg.PoolClient, actorId: string, requestId: string, supplierId: string, staffId: string) {
  // Staff changes and assignments share this lock before checking current membership.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`staff:${staffId}`]);
  await member(c, actorId, supplierId, true);
  await member(c, staffId, supplierId);
  const r = (await c.query(`SELECT r.*,s.category,s.required_qualifications,s.duration_minutes,s.area_codes FROM marketplace.requests r
    JOIN marketplace.supplier_services s ON s.id=r.service_id WHERE r.id=$1 FOR UPDATE OF r`, [requestId])).rows[0];
  if (!r) throw notFound();
  if (r.status !== 'open') throw conflict('already_accepted', 'この依頼は受付を終了しました');
  if (r.customer_id === staffId || r.customer_id === actorId) throw forbidden('自分の依頼は受諾できません');
  const supplier = (await c.query(`SELECT 1 FROM marketplace.suppliers p JOIN marketplace.subscriptions s ON s.supplier_id=p.id
    WHERE p.id=$1 AND p.review_status='approved' AND s.status IN ('active','trialing') AND s.current_period_end>now()
    AND (s.status<>'trialing' OR s.trial_ends_at>now())`, [supplierId])).rowCount;
  if (!supplier) throw forbidden('審査済みの有効な供給者契約が必要です', 'supplier_ineligible');
  const own = await c.query(`SELECT 1 FROM marketplace.supplier_services WHERE category=$1 AND supplier_id=$2 AND status='published' AND $3=ANY(area_codes)`, [r.category,supplierId,r.public_area_code]);
  if (!own.rowCount) throw forbidden('このサービスを提供する権限がありません');
  const skills = (await c.query(`SELECT qualification_code FROM marketplace.supplier_qualifications WHERE supplier_id=$1 AND (staff_id=$2 OR staff_id IS NULL)
    AND verified_at IS NOT NULL AND (valid_until IS NULL OR valid_until>=(($3::timestamptz AT TIME ZONE 'Asia/Tokyo')::date))`, [supplierId,staffId,r.starts_at])).rows.map(x=>x.qualification_code);
  if (r.required_qualifications.some((q: string)=>!skills.includes(q))) throw forbidden('担当者の資格を確認してください','qualification_required');
  const availability = await c.query(`SELECT 1 FROM marketplace.supplier_availability WHERE supplier_id=$1 AND (staff_id=$2 OR staff_id IS NULL)
    AND active AND starts_at<=$3 AND ends_at>=$4`, [supplierId,staffId,r.starts_at,r.ends_at]);
  if (!availability.rowCount) throw conflict('outside_availability', '対応可能な時間帯ではありません');
  const collision = await c.query(`SELECT 1 FROM marketplace.requests WHERE assigned_staff_id=$1 AND status=ANY($2) AND starts_at<$4 AND ends_at>$3
    UNION ALL SELECT 1 FROM marketplace.delivery_stops WHERE staff_id=$1 AND status IN ('ready','en_route','arrived') AND
    (time_start IS NULL OR time_end IS NULL OR (time_start<$4 AND time_end>$3)) LIMIT 1`, [staffId,ACTIVE,r.starts_at,r.ends_at]);
  if (collision.rowCount) throw conflict('schedule_conflict', '担当者の予定が重複しています');
  await c.query(`UPDATE marketplace.requests SET status='accepted',accepted_supplier_id=$2,assigned_staff_id=$3,accepted_at=now(),
    accepted_terms_json=$4 WHERE id=$1`, [requestId,supplierId,staffId,{ serviceId:r.service_id, totalChargeYen:r.total_charge_yen, startsAt:r.starts_at, endsAt:r.ends_at }]);
  await event(c,actorId,requestId,'accepted');
  await notify(c,[r.customer_id],{type:'marketplace_request',title:'依頼が受諾されました',body:'供給者と進行状況を確認してください',entityType:'marketplace_request',entityId:requestId});
  return { id:requestId,status:'accepted' };
}

export async function advanceRequest(c: pg.PoolClient, actorId: string, id: string, next: string) {
  const r = (await c.query('SELECT * FROM marketplace.requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!r) throw notFound();
  if (r.assigned_staff_id !== actorId) throw forbidden();
  await member(c,actorId,r.accepted_supplier_id);
  const transitions: Record<string,string> = { accepted:'en_route', en_route:'arrived', arrived:'in_progress', in_progress:'awaiting_customer_confirmation' };
  if (transitions[r.status] !== next) throw conflict('invalid_transition', '進行状況を更新できません');
  await c.query('UPDATE marketplace.requests SET status=$2 WHERE id=$1',[id,next]);
  await event(c,actorId,id,next);
  await notify(c,[r.customer_id],{type:'marketplace_request',title:'依頼の進行状況が更新されました',body:'アプリで現在の状況を確認してください',entityType:'marketplace_request',entityId:id});
  return { id,status:next };
}

export async function issueCompletion(c: pg.PoolClient, actorId: string, id: string) {
  const r = (await c.query('SELECT * FROM marketplace.requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if (!r || r.customer_id!==actorId) throw notFound();
  if (r.status!=='awaiting_customer_confirmation' || !r.assigned_staff_id) throw conflict('not_awaiting_confirmation','完了内容を確認できる状態ではありません');
  await c.query('UPDATE marketplace.completion_tokens SET revoked_at=now() WHERE request_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',[id]);
  const token=randomToken(32);
  const expiresAt=new Date(Date.now()+60_000);
  await c.query(`INSERT INTO marketplace.completion_tokens(request_id,token_hash,customer_id,supplier_id,staff_id,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6)`,[id,sha256(token),actorId,r.accepted_supplier_id,r.assigned_staff_id,expiresAt]);
  await event(c,actorId,id,'confirmation_issued');
  return { requestId:id,token,expiresAt:expiresAt.toISOString() };
}

export async function confirmCompletion(c: pg.PoolClient, actorId: string, id: string, token: string) {
  const r=(await c.query('SELECT * FROM marketplace.requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if (!r || r.assigned_staff_id!==actorId) throw notFound();
  await member(c,actorId,r.accepted_supplier_id);
  const t=(await c.query('SELECT * FROM marketplace.completion_tokens WHERE request_id=$1 AND token_hash=$2 FOR UPDATE',[id,sha256(token)])).rows[0];
  if (!t || t.staff_id!==actorId || t.supplier_id!==r.accepted_supplier_id || t.customer_id!==r.customer_id || t.consumed_at || t.revoked_at || t.expires_at<=new Date()) throw conflict('invalid_confirmation','確認コードが無効です。顧客に再発行を依頼してください');
  if (r.status!=='awaiting_customer_confirmation') throw conflict('invalid_transition','この依頼は完了確認できません');
  await c.query('UPDATE marketplace.completion_tokens SET consumed_at=now() WHERE id=$1',[t.id]);
  await c.query(`UPDATE marketplace.requests SET status='completed',completed_at=now() WHERE id=$1`,[id]);
  const quota=await c.query(`UPDATE marketplace.quota_reservations SET state='consumed',updated_at=now() WHERE request_id=$1 AND state='reserved' RETURNING request_id`,[id]);
  if (!quota.rowCount) throw conflict('quota_invalid','依頼枠を確認できません。サポートへお問い合わせください');
  await event(c,actorId,id,'completed');
  await notify(c,[r.customer_id,actorId],{type:'marketplace_request',title:'依頼の完了を確認しました',body:'依頼履歴で確認できます',entityType:'marketplace_request',entityId:id});
  return { id,status:'completed' };
}

export async function cancelRequest(c: pg.PoolClient,actorId:string,id:string,reason:string) {
  const r=(await c.query('SELECT * FROM marketplace.requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if (!r || r.customer_id!==actorId) throw notFound();
  if (r.status!=='open') throw conflict('cancellation_review_required','受諾後のキャンセルはサポートへご相談ください');
  await c.query(`UPDATE marketplace.requests SET status='cancelled' WHERE id=$1`,[id]);
  await c.query(`UPDATE marketplace.quota_reservations SET state='released',updated_at=now() WHERE request_id=$1 AND state='reserved'`,[id]);
  await recordEvent(c,{entityType:'marketplace_request',entityId:id,eventType:'cancelled',actor:{id:actorId,role:'customer'},reason});
  return {id,status:'cancelled'};
}
