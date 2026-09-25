import type { components } from '@happydrive/contracts';

export type Message = components['schemas']['Message'];

/** 取得済みと新着をID重複なしで結合し、作成日時順に並べる（ポーリングの差分取得用） */
export function mergeMessages(current: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of current) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

export function latestCreatedAt(messages: readonly Message[]): string | undefined {
  let max: string | undefined;
  for (const m of messages) if (!max || Date.parse(m.createdAt) > Date.parse(max)) max = m.createdAt;
  return max;
}

export const REPORT_REASONS = [
  { value: 'harassment', label: '嫌がらせ' },
  { value: 'fraud', label: '詐欺・不正' },
  { value: 'unsafe', label: '安全上の問題' },
  { value: 'illegal', label: '違法' },
  { value: 'spam', label: 'スパム' },
  { value: 'privacy', label: 'プライバシー侵害' },
  { value: 'other', label: 'その他' },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]['value'];
