import { describe, expect, it } from 'vitest';
import { validateDispute, validateMatchingConfig, validateMonth, validateReverse, validateWorkerId, type WeightForm } from '@/lib/admin-forms';

describe('紛争の裁定', () => {
  it('満額・支払なしは金額不要', () => {
    expect(validateDispute('pay_worker', '', 5000)).toEqual({});
    expect(validateDispute('no_pay', '', 5000)).toEqual({});
    expect(validateDispute('', '', 5000).error).toMatch(/選択/);
  });
  it('一部支払は 1円以上・受諾額未満の整数', () => {
    expect(validateDispute('partial', '2,500', 5000)).toEqual({ amountYen: 2500 });
    expect(validateDispute('partial', '0', 5000).error).toBeDefined();
    expect(validateDispute('partial', '5000', 5000).error).toMatch(/未満/);
    expect(validateDispute('partial', '12.5', 5000).error).toBeDefined();
  });
});

describe('報酬の取消・再割当', () => {
  it('取消額は1円以上・確定額以下', () => {
    expect(validateReverse('1000', 5000)).toEqual({ amountYen: 1000 });
    expect(validateReverse('6000', 5000).error).toMatch(/以下/);
    expect(validateReverse('', 5000).error).toBeDefined();
  });
  it('再割当先は UUID', () => {
    expect(validateWorkerId(' 5A5A5A5A-1111-4222-8333-944444444444 ')).toEqual({ workerId: '5a5a5a5a-1111-4222-8333-944444444444' });
    expect(validateWorkerId('worker-1').error).toMatch(/UUID/);
  });
});

describe('マッチング重み', () => {
  const base: WeightForm = {
    weights: { distance: '0.3', timeFit: '0.2', skillFit: '0.2', reliability: '0.1', preference: '0.1', fairness: '0.1' },
    maxDistanceKm: '20',
    reason: '偏りの是正',
  };
  it('0〜1 の重みと 1〜100km、理由必須', () => {
    const r = validateMatchingConfig(base);
    expect(r.errors).toEqual({});
    expect(r.value).toEqual({ weights: { distance: 0.3, timeFit: 0.2, skillFit: 0.2, reliability: 0.1, preference: 0.1, fairness: 0.1 }, maxDistanceKm: 20, reason: '偏りの是正' });
    expect(validateMatchingConfig({ ...base, weights: { ...base.weights, distance: '1.5' } }).errors.distance).toBeDefined();
    expect(validateMatchingConfig({ ...base, weights: { ...base.weights, fairness: '-0.1' } }).errors.fairness).toBeDefined();
    expect(validateMatchingConfig({ ...base, maxDistanceKm: '0' }).errors.maxDistanceKm).toBeDefined();
    expect(validateMatchingConfig({ ...base, reason: ' ' }).errors.reason).toMatch(/監査記録/);
  });
  it('すべて0は不可', () => {
    const zero = { distance: '0', timeFit: '0', skillFit: '0', reliability: '0', preference: '0', fairness: '0' };
    expect(validateMatchingConfig({ ...base, weights: zero }).errors.weights).toBeDefined();
  });
});

describe('月', () => {
  it('YYYY-MM', () => {
    expect(validateMonth('2026-09')).toBe(true);
    expect(validateMonth('2026-13')).toBe(false);
    expect(validateMonth('2026-9')).toBe(false);
  });
});

import { isAppeal } from '@/lib/tickets';

describe('異議申立ての判定', () => {
  it('category=matching_appeal で判定', () => {
    expect(isAppeal({ category: 'matching_appeal' })).toBe(true);
    expect(isAppeal({ category: 'job' })).toBe(false);
  });
});
