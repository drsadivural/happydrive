import { describe, expect, it } from 'vitest';
import { isRoughlyInJapan, mapPointUrl, mapSearchUrl, parseLatLng } from '@/lib/geo';

describe('parseLatLng', () => {
  it('地図サイトからコピーした座標を解釈する', () => {
    expect(parseLatLng('35.6812, 139.7671')).toEqual({ latitude: 35.6812, longitude: 139.7671 });
    expect(parseLatLng('(35.6812,139.7671)')).toEqual({ latitude: 35.6812, longitude: 139.7671 });
    expect(parseLatLng('35.6812 139.7671')).toEqual({ latitude: 35.6812, longitude: 139.7671 });
    expect(parseLatLng('３５．６８１２，１３９．７６７１')).toEqual({ latitude: 35.6812, longitude: 139.7671 });
  });
  it('範囲外・不正は null', () => {
    expect(parseLatLng('95, 139')).toBeNull();
    expect(parseLatLng('35, 200')).toBeNull();
    expect(parseLatLng('東京駅')).toBeNull();
    expect(parseLatLng('')).toBeNull();
  });
  it('日本の概略範囲チェックと地図URL', () => {
    expect(isRoughlyInJapan({ latitude: 35.68, longitude: 139.76 })).toBe(true);
    expect(isRoughlyInJapan({ latitude: 139.76, longitude: 35.68 } as never)).toBe(false);
    expect(mapSearchUrl('横浜市中区 本町1-1')).toBe('https://www.google.com/maps/search/?api=1&query=%E6%A8%AA%E6%B5%9C%E5%B8%82%E4%B8%AD%E5%8C%BA%20%E6%9C%AC%E7%94%BA1-1');
    expect(mapPointUrl({ latitude: 35.1, longitude: 139.2 })).toBe('https://www.google.com/maps/search/?api=1&query=35.1,139.2');
  });
});

import { validateSite } from '@/lib/site-form';

describe('validateSite', () => {
  it('拠点の必須項目と範囲', () => {
    const r = validateSite({ name: '', address: '横浜', latitude: '', longitude: '200', areaLabel: 'x' });
    expect(r.value).toBeUndefined();
    expect(Object.keys(r.errors).sort()).toEqual(['address', 'areaLabel', 'latitude', 'longitude', 'name']);
    const ok = validateSite({ name: '本社', address: '横浜市中区本町1-1', latitude: '35.44', longitude: '139.64', areaLabel: '横浜市中区' });
    expect(ok.value).toEqual({ name: '本社', address: '横浜市中区本町1-1', areaLabel: '横浜市中区', location: { latitude: 35.44, longitude: 139.64 } });
  });
});
