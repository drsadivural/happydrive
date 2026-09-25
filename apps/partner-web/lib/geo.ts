/** 位置入力の補助（有料ジオコーダーは使わない。緯度・経度は手入力または貼り付け）。 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** 全角数字・記号を半角に */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９．－＋，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ー−–—]/g, '-')
    .replace(/　/g, ' ');
}

/**
 * 「35.6812, 139.7671」「35.6812 139.7671」「(35.6812,139.7671)」などを解釈する。
 * 範囲外・不正は null。
 */
export function parseLatLng(text: string): LatLng | null {
  const m = /^\s*\(?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?\s*$/.exec(toHalfWidth(text));
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  return { latitude, longitude };
}

export function isValidLatitude(v: number): boolean {
  return Number.isFinite(v) && v >= -90 && v <= 90;
}
export function isValidLongitude(v: number): boolean {
  return Number.isFinite(v) && v >= -180 && v <= 180;
}

/** 日本の概略範囲外なら警告（入力ミス検出用。エラーにはしない） */
export function isRoughlyInJapan({ latitude, longitude }: LatLng): boolean {
  return latitude >= 20 && latitude <= 46 && longitude >= 122 && longitude <= 154;
}

/** 外部の地図サイトで住所を検索するURL（HappyDrive からは住所以外を送らない） */
export function mapSearchUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export function mapPointUrl({ latitude, longitude }: LatLng): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}
