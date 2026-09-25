import { describe, expect, it } from 'vitest';
import { maskAddress, maskBirthDate, maskPlate, maskPostalCode } from '@/lib/mask';

describe('マスク表示', () => {
  it('住所は先頭のみ', () => {
    expect(maskAddress('神奈川県横浜市中区本町1-1')).toBe('神奈川県横浜＊＊＊（以下非表示）');
    expect(maskAddress('東京都')).toBe('東京＊＊＊');
    expect(maskAddress(undefined)).toBe('—');
  });
  it('生年月日は年のみ、郵便番号は非表示', () => {
    expect(maskBirthDate('1990-04-01')).toBe('1990年＊月＊日');
    expect(maskPostalCode('231-0005')).toBe('＊＊＊-＊＊＊＊');
  });
  it('ナンバーは末尾2文字のみ', () => {
    expect(maskPlate('横浜480あ1234')).toBe('＊＊＊＊＊＊＊＊34');
    expect(maskPlate('12')).toBe('＊＊');
  });
});
