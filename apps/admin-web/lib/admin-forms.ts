/** 運営操作の入力検証（契約の制約 + 画面での業務ルール）。 */
import type { components } from '@happydrive/contracts';

type MatchingConfig = components['schemas']['MatchingConfig'];
export type Resolution = 'pay_worker' | 'partial' | 'no_pay';
export type Weights = MatchingConfig['weights'];
export const WEIGHT_KEYS: readonly (keyof Weights)[] = ['distance', 'timeFit', 'skillFit', 'reliability', 'preference', 'fairness'];
export const WEIGHT_LABELS: Record<keyof Weights, string> = {
  distance: '距離（移動ETA）',
  timeFit: '時間の適合',
  skillFit: '資格・スキル適合',
  reliability: '完了実績',
  preference: '本人の希望',
  fairness: '公平性（提示の偏り是正）',
};

function toHalf(s: string): string {
  return s.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,\s円¥￥]/g, '');
}

export function parseYen(raw: string): number | null {
  const s = toHalf(raw);
  return /^\d+$/.test(s) ? Number(s) : null;
}

export function validateDispute(resolution: Resolution | '', amountRaw: string, acceptedAmountYen: number | undefined): { amountYen?: number; error?: string } {
  if (!resolution) return { error: '裁定内容を選択してください。' };
  if (resolution !== 'partial') return {};
  const n = parseYen(amountRaw);
  if (n === null || n < 1) return { error: '一部支払の金額（1円以上の整数）を入力してください。' };
  if (acceptedAmountYen !== undefined && n >= acceptedAmountYen) return { error: `一部支払は受諾時の報酬（${acceptedAmountYen.toLocaleString('ja-JP')}円）未満にしてください。満額の場合は「満額支払」を選択してください。` };
  return { amountYen: n };
}

export function validateReverse(amountRaw: string, maxYen: number | undefined): { amountYen?: number; error?: string } {
  const n = parseYen(amountRaw);
  if (n === null || n < 1) return { error: '取消する金額（1円以上の整数）を入力してください。' };
  if (maxYen !== undefined && n > maxYen) return { error: `取消額は確定額（${maxYen.toLocaleString('ja-JP')}円）以下にしてください。` };
  return { amountYen: n };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateWorkerId(raw: string): { workerId?: string; error?: string } {
  const v = raw.trim();
  if (!v) return { error: '再割当先のドライバーID（UUID）を入力してください。' };
  if (!UUID_RE.test(v)) return { error: 'ドライバーIDは UUID 形式で入力してください（利用者詳細のURLで確認できます）。' };
  return { workerId: v.toLowerCase() };
}

export interface WeightForm {
  weights: Record<keyof Weights, string>;
  maxDistanceKm: string;
  reason: string;
}

export function validateMatchingConfig(f: WeightForm): { value?: MatchingConfig; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const weights = {} as Weights;
  for (const k of WEIGHT_KEYS) {
    const s = toHalf(f.weights[k] ?? '');
    const n = Number(s);
    if (s === '' || !/^\d*(\.\d+)?$/.test(s) || !Number.isFinite(n) || n < 0 || n > 1) errors[k] = `${WEIGHT_LABELS[k]}は0〜1の数値で入力してください。`;
    else weights[k] = n;
  }
  const d = Number(toHalf(f.maxDistanceKm));
  if (f.maxDistanceKm.trim() === '' || !Number.isFinite(d) || d < 1 || d > 100) errors.maxDistanceKm = '最大距離は1〜100kmで入力してください。';
  const reason = f.reason.trim();
  if (!reason) errors.reason = '変更理由を入力してください（監査記録に残ります）。';
  else if (reason.length > 500) errors.reason = '変更理由は500文字以内で入力してください。';
  if (Object.keys(errors).length === 0 && WEIGHT_KEYS.every((k) => weights[k] === 0)) errors.weights = 'すべての重みを0にはできません。';
  if (Object.keys(errors).length) return { errors };
  return { value: { weights, maxDistanceKm: d, reason }, errors };
}

export function validateMonth(m: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}
