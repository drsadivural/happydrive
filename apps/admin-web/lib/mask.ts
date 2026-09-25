/** 画面上の既定マスク（のぞき見対策）。必要時のみ「表示」で確認する。 */
export function maskAddress(address: string | undefined | null): string {
  if (!address) return '—';
  const chars = Array.from(address);
  if (chars.length <= 6) return `${chars.slice(0, 2).join('')}＊＊＊`;
  return `${chars.slice(0, 6).join('')}＊＊＊（以下非表示）`;
}

export function maskBirthDate(date: string | undefined | null): string {
  if (!date) return '—';
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(date);
  return m ? `${m[1]}年＊月＊日` : '＊＊＊＊';
}

export function maskPostalCode(code: string | undefined | null): string {
  if (!code) return '—';
  return '＊＊＊-＊＊＊＊';
}

export function maskPlate(plate: string | undefined | null): string {
  if (!plate) return '—';
  const chars = Array.from(plate);
  return chars.length <= 2 ? '＊＊' : `${'＊'.repeat(Math.min(chars.length - 2, 8))}${chars.slice(-2).join('')}`;
}
