import type { components } from '@happydrive/contracts';
import { isValidLatitude, isValidLongitude } from './geo';
import { parseDecimal } from './job-form';

type SiteInput = components['schemas']['SiteInput'];

export interface SiteFormState {
  name: string;
  address: string;
  latitude: string;
  longitude: string;
  areaLabel: string;
}

export const EMPTY_SITE_FORM: SiteFormState = { name: '', address: '', latitude: '', longitude: '', areaLabel: '' };

/** SiteInput の制約（name 1〜80、address 4〜200、areaLabel 2〜40、location 必須） */
export function validateSite(f: SiteFormState): { value?: SiteInput; errors: Record<string, string> } {
  const e: Record<string, string> = {};
  const n = (s: string) => Array.from(s.trim()).length;
  if (!f.name.trim()) e.name = '拠点名を入力してください。';
  else if (n(f.name) > 80) e.name = '拠点名は80文字以内で入力してください。';
  if (!f.address.trim()) e.address = '住所を入力してください。';
  else if (n(f.address) < 4 || n(f.address) > 200) e.address = '住所は4〜200文字で入力してください。';
  if (!f.areaLabel.trim()) e.areaLabel = '公開用の地域名を入力してください。';
  else if (n(f.areaLabel) < 2 || n(f.areaLabel) > 40) e.areaLabel = '公開用の地域名は2〜40文字で入力してください。';
  const lat = parseDecimal(f.latitude);
  const lng = parseDecimal(f.longitude);
  if (lat === undefined) e.latitude = '緯度を入力してください。';
  else if (Number.isNaN(lat) || !isValidLatitude(lat)) e.latitude = '緯度は -90〜90 の数値で入力してください。';
  if (lng === undefined) e.longitude = '経度を入力してください。';
  else if (Number.isNaN(lng) || !isValidLongitude(lng)) e.longitude = '経度は -180〜180 の数値で入力してください。';
  if (Object.keys(e).length) return { errors: e };
  return {
    value: { name: f.name.trim(), address: f.address.trim(), areaLabel: f.areaLabel.trim(), location: { latitude: lat!, longitude: lng! } },
    errors: e,
  };
}

