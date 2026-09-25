import { describe, expect, it } from 'vitest';
import { canRate, canReportNoShow, canReview, formatRating, noShowAvailableAt } from '@/lib/assignment-rules';

const start = '2026-10-01T00:00:00Z';
const t = (iso: string) => Date.parse(iso);

describe('無断欠勤の報告', () => {
  it('開始から30分経過後、未チェックイン（accepted/traveling）のみ', () => {
    expect(canReportNoShow('accepted', start, t('2026-10-01T00:29:59Z'))).toBe(false);
    expect(canReportNoShow('accepted', start, t('2026-10-01T00:30:00Z'))).toBe(true);
    expect(canReportNoShow('traveling', start, t('2026-10-01T01:00:00Z'))).toBe(true);
    expect(canReportNoShow('checked_in', start, t('2026-10-01T01:00:00Z'))).toBe(false);
    expect(canReportNoShow('working', start, t('2026-10-01T01:00:00Z'))).toBe(false);
    expect(canReportNoShow('accepted', undefined, t('2026-10-01T01:00:00Z'))).toBe(false);
    expect(noShowAvailableAt(start)).toBe('2026-10-01T00:30:00.000Z');
  });
});

describe('検収・評価', () => {
  it('検収は submitted のみ', () => {
    expect(canReview('submitted')).toBe(true);
    expect(canReview('working')).toBe(false);
    expect(canReview('needs_revision')).toBe(false);
  });
  it('評価は検収後に1回のみ', () => {
    expect(canRate('approved', false)).toBe(true);
    expect(canRate('paid', undefined)).toBe(true);
    expect(canRate('approved', true)).toBe(false);
    expect(canRate('submitted', false)).toBe(false);
  });
  it('評価の表示', () => {
    expect(formatRating(4.25)).toBe('★ 4.3');
    expect(formatRating(undefined)).toBe('評価なし');
  });
});
