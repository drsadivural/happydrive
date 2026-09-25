// Explainable, deterministic matching. Hard eligibility filters first; the remaining jobs are ranked
// by a weighted score whose components are shown to the worker as reasons. Ratings are never used to exclude.
import type { Client } from '../db/pool.js';
import { haversineKm, type Point } from '../lib/geo.js';
import { jstDate } from '../lib/time.js';

export interface MatchingWeights { distance: number; timeFit: number; skillFit: number; reliability: number; preference: number; fairness: number }
export interface MatchingConfig { weights: MatchingWeights; maxDistanceKm: number }

export interface WorkerContext {
  id: string;
  verified: boolean;
  suspended: boolean;
  termsAccepted: boolean;
  profileComplete: boolean;
  hasVehicle: boolean;
  skills: Map<string, string | null>; // verified skill code -> valid_until (YYYY-MM-DD) or null
  busy: { startsAt: Date; endsAt: Date }[];
  blockedOrgIds: Set<string>;
  preferences: { useLocationForMatching?: boolean; useHistoryForMatching?: boolean; preferredCategories?: string[]; maxDistanceKm?: number };
  completed: number;
  noShowOrLate: number;
  recentAssignments: number;
}

export interface JobForMatch {
  id: string;
  orgId: string;
  category: string;
  startsAt: Date;
  endsAt: Date;
  requiredSkills: string[];
  remaining: number;
  point: Point;
}

export type Exclusion = 'not_verified' | 'onboarding_incomplete' | 'suspended' | 'skill_missing' | 'skill_expired' | 'time_conflict' | 'too_far' | 'blocked' | 'full' | 'vehicle_required';

export const EXCLUSION_LABEL: Record<Exclusion, string> = {
  not_verified: '本人確認が完了していません',
  onboarding_incomplete: '登録情報（規約同意・本人情報）が未完了です',
  suspended: 'アカウントが利用停止中です',
  skill_missing: '必要な資格・講習がありません',
  skill_expired: '必要な資格の有効期限が切れています',
  time_conflict: '同じ時間帯に別の業務が入っています',
  too_far: '希望する距離の範囲外です',
  blocked: 'ブロックした発注者です',
  full: '募集枠が埋まっています',
  vehicle_required: '車両情報の登録が必要です',
};

export async function loadMatchingConfig(c: Client): Promise<MatchingConfig & { reason?: string; updatedAt?: Date; updatedBy?: string }> {
  const r = await c.query('SELECT weights, max_distance_km, reason, created_at, updated_by FROM matching_config ORDER BY id DESC LIMIT 1');
  const row = r.rows[0];
  return { weights: row.weights, maxDistanceKm: Number(row.max_distance_km), reason: row.reason ?? undefined, updatedAt: row.created_at, updatedBy: row.updated_by ?? undefined };
}

export async function loadWorkerContext(c: Client, workerId: string, termsVersion: string): Promise<WorkerContext> {
  const u = await c.query('SELECT verification_status, suspended_at, terms_version, profile_ciphertext IS NOT NULL AS profile, vehicle IS NOT NULL AS vehicle, preferences FROM app_users WHERE id = $1', [workerId]);
  const skills = await c.query(`SELECT skill_code, valid_until::text FROM worker_skills WHERE worker_id = $1 AND status = 'verified'`, [workerId]);
  const busy = await c.query(
      `SELECT j.starts_at, j.ends_at FROM assignments a JOIN jobs j ON j.id = a.job_id
       WHERE a.worker_id = $1 AND a.state IN ('reserved','accepted','traveling','checked_in','working') AND j.ends_at > now()`,
      [workerId],
    );
  const blocks = await c.query('SELECT org_id FROM org_blocks WHERE worker_id = $1', [workerId]);
  const stats = await c.query(
      `SELECT count(*) FILTER (WHERE state IN ('approved','payable','paid'))::int AS completed,
              count(*) FILTER (WHERE state = 'no_show' OR late_cancellation)::int AS bad,
              count(*) FILTER (WHERE accepted_at > now() - interval '30 days')::int AS recent
       FROM assignments WHERE worker_id = $1`,
      [workerId],
    );
  const row = u.rows[0];
  return {
    id: workerId,
    verified: row.verification_status === 'verified',
    suspended: !!row.suspended_at,
    termsAccepted: row.terms_version === termsVersion,
    profileComplete: row.profile,
    hasVehicle: row.vehicle,
    skills: new Map(skills.rows.map((s) => [s.skill_code, s.valid_until])),
    busy: busy.rows.map((b) => ({ startsAt: b.starts_at, endsAt: b.ends_at })),
    blockedOrgIds: new Set(blocks.rows.map((b) => b.org_id)),
    preferences: row.preferences ?? {},
    completed: stats.rows[0].completed,
    noShowOrLate: stats.rows[0].bad,
    recentAssignments: stats.rows[0].recent,
  };
}

/** Hard filters. Returned in a stable order; the first one is the primary reason. */
export function exclusions(w: WorkerContext, j: JobForMatch, distanceKm: number | undefined, maxKm: number | undefined): Exclusion[] {
  const out: Exclusion[] = [];
  if (w.suspended) out.push('suspended');
  if (!w.termsAccepted || !w.profileComplete) out.push('onboarding_incomplete');
  if (!w.verified) out.push('not_verified');
  if (w.blockedOrgIds.has(j.orgId)) out.push('blocked');
  const jobDay = jstDate(j.startsAt);
  for (const s of j.requiredSkills) {
    if (!w.skills.has(s)) { out.push('skill_missing'); break; }
    const until = w.skills.get(s);
    if (until && until < jobDay) { out.push('skill_expired'); break; }
  }
  if (j.category === 'delivery_related' && !w.hasVehicle) out.push('vehicle_required');
  if (w.busy.some((b) => b.startsAt < j.endsAt && j.startsAt < b.endsAt)) out.push('time_conflict');
  if (distanceKm !== undefined && maxKm !== undefined && distanceKm > maxKm) out.push('too_far');
  if (j.remaining <= 0) out.push('full');
  return out;
}

export interface Scored { score: number; reasons: string[] }

export function score(w: WorkerContext, j: JobForMatch, distanceKm: number | undefined, cfg: MatchingConfig, now = new Date()): Scored {
  const wt = cfg.weights;
  const reasons: string[] = [];
  const useLoc = w.preferences.useLocationForMatching !== false;
  const useHistory = w.preferences.useHistoryForMatching !== false;
  const maxKm = w.preferences.maxDistanceKm ?? cfg.maxDistanceKm;

  let dist = 0.5;
  if (useLoc && distanceKm !== undefined) {
    dist = Math.max(0, 1 - distanceKm / maxKm);
    if (distanceKm <= Math.min(3, maxKm / 2)) reasons.push(`近い（約${distanceKm < 1 ? distanceKm.toFixed(1) : Math.round(distanceKm)}km）`);
  }

  // Time fit: soon-but-reachable jobs and jobs that fit next to existing work rank higher.
  const hoursUntil = (j.startsAt.getTime() - now.getTime()) / 3_600_000;
  let time = hoursUntil < 0.5 ? 0.2 : hoursUntil <= 6 ? 1 : Math.max(0.2, 1 - (hoursUntil - 6) / (24 * 7));
  const adjacent = w.busy.some((b) => Math.abs(b.endsAt.getTime() - j.startsAt.getTime()) <= 90 * 60_000 || Math.abs(j.endsAt.getTime() - b.startsAt.getTime()) <= 90 * 60_000);
  if (adjacent) { time = Math.min(1, time + 0.3); reasons.push('予定の前後に入れやすい'); }
  else if (hoursUntil >= 0.5 && hoursUntil <= 6) reasons.push('時間に合う');

  let skill = 0.5;
  if (j.requiredSkills.length) { skill = 1; reasons.push('資格適合'); }
  else if ([...w.skills.keys()].some((k) => k.startsWith(j.category.split('_')[0]!))) skill = 0.8;

  let reliability = 0.5;
  if (useHistory) {
    // Bayesian average with a neutral prior so new workers are not penalised.
    reliability = (w.completed + 2) / (w.completed + w.noShowOrLate + 4);
    if (w.completed >= 3 && reliability >= 0.8) reasons.push('完了実績あり');
  }

  const preferred = w.preferences.preferredCategories ?? [];
  const pref = preferred.length === 0 ? 0.5 : preferred.includes(j.category) ? 1 : 0.3;
  if (preferred.includes(j.category)) reasons.push('希望カテゴリ');

  // Fairness: spread opportunities to workers with fewer recent assignments.
  const fairness = 1 / (1 + w.recentAssignments / 5);

  const total = wt.distance * dist + wt.timeFit * time + wt.skillFit * skill + wt.reliability * reliability + wt.preference * pref + wt.fairness * fairness;
  const sum = wt.distance + wt.timeFit + wt.skillFit + wt.reliability + wt.preference + wt.fairness || 1;
  return { score: Math.round((total / sum) * 1000) / 1000, reasons };
}

export function distanceKm(a: Point | undefined, b: Point): number | undefined {
  return a ? Math.round(haversineKm(a, b) * 10) / 10 : undefined;
}
