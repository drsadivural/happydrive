import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  formatDateJst,
  formatDateTimeJst,
  formatMonth,
  formatPlainDate,
  formatRangeJst,
  formatTimeJst,
  formatYen,
  jstInputToUtcIso,
  jstMonth,
  jstToday,
  utcIsoToJstInput,
} from '../src/format';

describe('formatYen', () => {
  it('整数円を円記号と桁区切りで表示する', () => {
    expect(formatYen(12345)).toBe('￥12,345');
    expect(formatYen(0)).toBe('￥0');
    expect(formatYen(1000000)).toBe('￥1,000,000');
  });
  it('負の金額（逆仕訳）も表示できる', () => {
    expect(formatYen(-500)).toBe('-￥500');
  });
  it('null/undefined/NaN は — ', () => {
    expect(formatYen(null)).toBe('—');
    expect(formatYen(undefined)).toBe('—');
    expect(formatYen(Number.NaN)).toBe('—');
  });
});

describe('JST ↔ UTC 変換', () => {
  it('datetime-local の値を JST として UTC ISO に変換する', () => {
    expect(jstInputToUtcIso('2026-10-01T09:00')).toBe('2026-10-01T00:00:00.000Z');
    expect(jstInputToUtcIso('2026-10-01T08:59')).toBe('2026-09-30T23:59:00.000Z');
    expect(jstInputToUtcIso('2027-01-01T00:30')).toBe('2026-12-31T15:30:00.000Z');
    expect(jstInputToUtcIso('2026-10-01T09:00:30')).toBe('2026-10-01T00:00:30.000Z');
  });
  it('不正・存在しない日時は null', () => {
    expect(jstInputToUtcIso('')).toBeNull();
    expect(jstInputToUtcIso(undefined)).toBeNull();
    expect(jstInputToUtcIso('2026-02-30T10:00')).toBeNull();
    expect(jstInputToUtcIso('2026-13-01T10:00')).toBeNull();
    expect(jstInputToUtcIso('2026-10-01 10:00')).toBeNull();
    expect(jstInputToUtcIso('2026-10-01T24:00')).toBeNull();
  });
  it('UTC ISO を datetime-local 用の JST 文字列にする', () => {
    expect(utcIsoToJstInput('2026-10-01T00:00:00Z')).toBe('2026-10-01T09:00');
    expect(utcIsoToJstInput('2026-12-31T15:30:00.000Z')).toBe('2027-01-01T00:30');
    expect(utcIsoToJstInput(null)).toBe('');
    expect(utcIsoToJstInput('invalid')).toBe('');
  });
  it('往復変換で値が保たれる', () => {
    for (const v of ['2026-01-01T00:00', '2026-06-15T23:59', '2028-02-29T12:34']) {
      expect(utcIsoToJstInput(jstInputToUtcIso(v))).toBe(v);
    }
  });
  it('実行環境のタイムゾーンに依存しない', () => {
    // Date#getHours などのローカル時刻 API を使っていないことの確認
    const iso = jstInputToUtcIso('2026-03-10T02:00');
    expect(iso).toBe('2026-03-09T17:00:00.000Z');
  });
});

describe('JST 表示', () => {
  it('日時を JST で表示する', () => {
    expect(formatDateTimeJst('2026-10-01T00:00:00Z')).toBe('2026/10/01 09:00');
    expect(formatDateTimeJst('2026-09-30T15:00:00Z')).toBe('2026/10/01 00:00');
    expect(formatDateTimeJst(undefined)).toBe('—');
    expect(formatDateTimeJst('not a date')).toBe('—');
  });
  it('日付と時刻', () => {
    expect(formatDateJst('2026-10-01T00:00:00Z')).toBe('2026/10/01(木)');
    expect(formatTimeJst('2026-10-01T03:05:00Z')).toBe('12:05');
  });
  it('期間表示（同日は終了時刻のみ）', () => {
    expect(formatRangeJst('2026-10-01T00:00:00Z', '2026-10-01T03:00:00Z')).toBe('2026/10/01(木) 09:00〜12:00');
    expect(formatRangeJst('2026-10-01T14:00:00Z', '2026-10-01T16:00:00Z')).toBe('2026/10/01(木) 23:00〜2026/10/02(金) 01:00');
  });
  it('JST の今日・今月（UTC では前日でも JST の日付）', () => {
    const now = new Date('2026-09-30T16:00:00Z'); // JST 2026-10-01 01:00
    expect(jstToday(now)).toBe('2026-10-01');
    expect(jstMonth(now)).toBe('2026-10');
  });
  it('月・日の加算と表示', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(formatMonth('2026-09')).toBe('2026年9月');
    expect(formatPlainDate('2026-09-01')).toBe('2026/09/01');
  });
});
