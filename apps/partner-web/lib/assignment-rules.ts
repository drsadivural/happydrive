/** 実施・検収画面の操作可否（API も検査するが、押せない操作はボタンを出さない） */
export const NO_SHOW_GRACE_MINUTES = 30;

export function canReportNoShow(state: string, startsAt: string | undefined, now: number): boolean {
  if (state !== 'accepted' && state !== 'traveling') return false;
  const start = startsAt ? Date.parse(startsAt) : Number.NaN;
  if (Number.isNaN(start)) return false;
  return now >= start + NO_SHOW_GRACE_MINUTES * 60_000;
}

/** 無断欠勤を報告できるようになる時刻（ISO） */
export function noShowAvailableAt(startsAt: string | undefined): string | null {
  const start = startsAt ? Date.parse(startsAt) : Number.NaN;
  return Number.isNaN(start) ? null : new Date(start + NO_SHOW_GRACE_MINUTES * 60_000).toISOString();
}

export function canReview(state: string): boolean {
  return state === 'submitted';
}

export function canRate(state: string, alreadyRated: boolean | undefined): boolean {
  return !alreadyRated && (state === 'approved' || state === 'payable' || state === 'paid');
}

export function formatRating(avg: number | undefined | null): string {
  return typeof avg === 'number' && Number.isFinite(avg) ? `★ ${avg.toFixed(1)}` : '評価なし';
}
