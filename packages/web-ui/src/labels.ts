/**
 * 契約の列挙値 → 日本語ラベルと表示トーン。未知の値は値そのものを表示（将来の契約追加に耐える）。
 * トーンは色だけに依存しない表示（ラベル文字列を常に併記）に使う。
 */
import type { components } from '@happydrive/contracts';
import { categories } from '@happydrive/design-tokens';

type S = components['schemas'];

export type Tone = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'gray' | 'navy';

export interface StatusLabel {
  label: string;
  tone: Tone;
}

function lookup<K extends string>(map: Record<K, StatusLabel>, value: string | null | undefined): StatusLabel {
  if (!value) return { label: '—', tone: 'gray' };
  return (map as Record<string, StatusLabel>)[value] ?? { label: value, tone: 'gray' };
}

export const JOB_STATUS: Record<S['JobStatus'], StatusLabel> = {
  draft: { label: '下書き', tone: 'gray' },
  pending_review: { label: '審査中', tone: 'purple' },
  published: { label: '募集中', tone: 'blue' },
  filled: { label: '満員', tone: 'navy' },
  expired: { label: '期限切れ', tone: 'gray' },
  cancelled: { label: '取消', tone: 'red' },
  rejected: { label: '却下', tone: 'red' },
  completed: { label: '完了', tone: 'green' },
};
export const jobStatusLabel = (v: string | null | undefined) => lookup(JOB_STATUS, v);

export const ASSIGNMENT_STATE: Record<S['AssignmentState'], StatusLabel> = {
  reserved: { label: '承認待ち（予約）', tone: 'orange' },
  accepted: { label: '受諾済み', tone: 'blue' },
  traveling: { label: '移動中', tone: 'green' },
  checked_in: { label: 'チェックイン済み', tone: 'green' },
  working: { label: '実施中', tone: 'green' },
  submitted: { label: '検収待ち', tone: 'orange' },
  needs_revision: { label: '差戻し中', tone: 'orange' },
  approved: { label: '検収済み', tone: 'green' },
  payable: { label: '支払確定', tone: 'green' },
  paid: { label: '支払済み', tone: 'navy' },
  cancelled: { label: '取消', tone: 'red' },
  declined: { label: '却下', tone: 'red' },
  expired: { label: '期限切れ', tone: 'gray' },
  no_show: { label: '無断欠勤', tone: 'red' },
  disputed: { label: '紛争中', tone: 'red' },
  refunded: { label: '返金済み', tone: 'gray' },
};
export const assignmentStateLabel = (v: string | null | undefined) => lookup(ASSIGNMENT_STATE, v);

/** 業務中（位置共有が有効になりうる）状態 */
export const ACTIVE_ASSIGNMENT_STATES: ReadonlyArray<S['AssignmentState']> = ['traveling', 'checked_in', 'working'];
export function isActiveAssignment(state: string | null | undefined): boolean {
  return !!state && (ACTIVE_ASSIGNMENT_STATES as readonly string[]).includes(state);
}

/** ダッシュボードの progressLabel（API が日本語で返す）→ トーン。モックアップ: 実施中=緑 / 募集中=青 / 検収待ち=橙 */
const PROGRESS_TONE: Record<string, Tone> = {
  募集中: 'blue',
  実施中: 'green',
  検収待ち: 'orange',
  満員: 'navy',
  完了: 'green',
  下書き: 'gray',
  審査中: 'purple',
  取消: 'red',
  却下: 'red',
  期限切れ: 'gray',
};
export function progressLabel(label: string | null | undefined): StatusLabel {
  if (!label) return { label: '—', tone: 'gray' };
  return { label, tone: PROGRESS_TONE[label] ?? 'gray' };
}

export const ORG_REVIEW_STATUS: Record<NonNullable<S['Organization']['reviewStatus']>, StatusLabel> = {
  pending: { label: '審査中', tone: 'orange' },
  approved: { label: '承認済み', tone: 'green' },
  rejected: { label: '却下', tone: 'red' },
  suspended: { label: '停止中', tone: 'red' },
};
export const orgReviewLabel = (v: string | null | undefined) => lookup(ORG_REVIEW_STATUS, v);

export const VERIFICATION_STATUS: Record<S['User']['verificationStatus'], StatusLabel> = {
  unsubmitted: { label: '未申請', tone: 'gray' },
  pending: { label: '審査待ち', tone: 'orange' },
  verified: { label: '確認済み', tone: 'green' },
  rejected: { label: '却下', tone: 'red' },
};
export const verificationLabel = (v: string | null | undefined) => lookup(VERIFICATION_STATUS, v);

export const SKILL_STATUS: Record<S['Skill']['status'], StatusLabel> = {
  pending: { label: '確認待ち', tone: 'orange' },
  verified: { label: '確認済み', tone: 'green' },
  rejected: { label: '却下', tone: 'red' },
  expired: { label: '期限切れ', tone: 'gray' },
};
export const skillStatusLabel = (v: string | null | undefined) => lookup(SKILL_STATUS, v);

export const PAYOUT_STATUS: Record<S['Payout']['status'], StatusLabel> = {
  requested: { label: '依頼済み', tone: 'blue' },
  processing: { label: '処理中', tone: 'orange' },
  paid: { label: '振込済み', tone: 'green' },
  failed: { label: '失敗', tone: 'red' },
};
export const payoutStatusLabel = (v: string | null | undefined) => lookup(PAYOUT_STATUS, v);

export const REPORT_STATUS: Record<S['Report']['status'], StatusLabel> = {
  open: { label: '未対応', tone: 'orange' },
  resolved: { label: '対応済み', tone: 'green' },
};
export const reportStatusLabel = (v: string | null | undefined) => lookup(REPORT_STATUS, v);

export const TICKET_STATUS: Record<S['SupportTicket']['status'], StatusLabel> = {
  open: { label: '未回答', tone: 'orange' },
  answered: { label: '回答済み', tone: 'blue' },
  closed: { label: '完了', tone: 'gray' },
};
export const ticketStatusLabel = (v: string | null | undefined) => lookup(TICKET_STATUS, v);

export const DELETION_STATUS: Record<S['DeletionRequest']['status'], StatusLabel> = {
  confirmation_required: { label: '本人確認待ち', tone: 'orange' },
  completed: { label: '削除完了', tone: 'gray' },
};
export const deletionStatusLabel = (v: string | null | undefined) => lookup(DELETION_STATUS, v);

export const CONTRACT_TYPE: Record<S['ContractType'], StatusLabel> = {
  employment: { label: '雇用', tone: 'blue' },
  contractor: { label: '業務委託', tone: 'green' },
  other_legal_review: { label: 'その他（法務審査中）', tone: 'orange' },
};
export const contractTypeLabel = (v: string | null | undefined) => lookup(CONTRACT_TYPE, v);

const CATEGORY_TONE: Record<string, Tone> = {
  jobGreen: 'green',
  corporatePurple: 'purple',
  communityOrange: 'orange',
  brandBlue: 'blue',
  danger: 'red',
};
export function categoryLabel(v: string | null | undefined): StatusLabel {
  if (!v) return { label: '—', tone: 'gray' };
  const c = (categories as Record<string, { label: string; color: string }>)[v];
  return c ? { label: c.label, tone: CATEGORY_TONE[c.color] ?? 'gray' } : { label: v, tone: 'gray' };
}
export const JOB_CATEGORIES = Object.keys(categories) as S['JobCategory'][];
/** 資格要件・事業審査が確定するまで公開不可のカテゴリ */
export const RESTRICTED_CATEGORIES: ReadonlyArray<S['JobCategory']> = ['personal_care', 'healthcare'];

export const MEMBER_ROLE: Record<S['Member']['role'], StatusLabel> = {
  owner: { label: 'オーナー', tone: 'navy' },
  manager: { label: '管理者', tone: 'blue' },
  reviewer: { label: '検収担当', tone: 'green' },
};
export const memberRoleLabel = (v: string | null | undefined) => lookup(MEMBER_ROLE, v);

export const USER_ROLE: Record<S['Role'], StatusLabel> = {
  worker: { label: 'ドライバー', tone: 'blue' },
  org_member: { label: '発注者', tone: 'purple' },
  admin_operator: { label: '運営', tone: 'navy' },
  admin_support: { label: 'サポート', tone: 'green' },
  admin_auditor: { label: '監査（閲覧のみ）', tone: 'gray' },
};
export const userRoleLabel = (v: string | null | undefined) => lookup(USER_ROLE, v);

export const REPORT_REASON: Record<string, string> = {
  harassment: '嫌がらせ',
  fraud: '詐欺・不正',
  unsafe: '安全上の問題',
  illegal: '違法',
  spam: 'スパム',
  privacy: 'プライバシー侵害',
  other: 'その他',
};
export const reportReasonLabel = (v: string | null | undefined) => (v ? REPORT_REASON[v] ?? v : '—');

export const TICKET_CATEGORY: Record<string, string> = {
  account: 'アカウント',
  payment: '支払い',
  job: '案件',
  delivery: '配送',
  safety: '安全',
  privacy: 'プライバシー',
  other: 'その他',
  matching_appeal: 'マッチング異議申立て',
};
export const ticketCategoryLabel = (v: string | null | undefined) => (v ? TICKET_CATEGORY[v] ?? v : '—');

export const VEHICLE_TYPE: Record<string, string> = {
  kei_van: '軽バン',
  kei_truck: '軽トラック',
  car: '普通車',
  motorbike: 'バイク',
  bicycle: '自転車',
  none: 'なし',
};
export const vehicleTypeLabel = (v: string | null | undefined) => (v ? VEHICLE_TYPE[v] ?? v : '—');

export const ORG_KIND: Record<string, string> = {
  company: '企業',
  municipality: '自治体',
  npo: 'NPO',
  other: 'その他',
};
export const orgKindLabel = (v: string | null | undefined) => (v ? ORG_KIND[v] ?? v : '—');

export const MESSAGE_SENDER: Record<string, string> = {
  worker: 'ドライバー',
  organization: '発注者',
  operator: '運営',
  system: 'システム',
};

export const TIMELINE_EVENT: Record<string, string> = {
  reserved: '予約',
  accepted: '受諾',
  reservation_approved: '予約承認',
  reservation_declined: '予約却下',
  traveling: '移動開始',
  checked_in: 'チェックイン',
  working: '作業開始',
  step_completed: '手順完了',
  submitted: '完了報告',
  needs_revision: '差戻し',
  approved: '検収承認',
  payable: '支払確定',
  paid: '支払済み',
  cancelled: '取消',
  declined: '却下',
  expired: '期限切れ',
  no_show: '無断欠勤',
  disputed: '紛争',
  dispute_resolved: '紛争裁定',
  refunded: '返金',
  reversed: '逆仕訳',
  reassigned: '再割当',
  safety_alert: '危険報告',
  help_requested: 'ヘルプ要請',
};
export const timelineEventLabel = (v: string | null | undefined) => (v ? TIMELINE_EVENT[v] ?? v : '—');

export const ACTOR_ROLE: Record<string, string> = {
  worker: 'ドライバー',
  organization: '発注者',
  org_member: '発注者',
  operator: '運営',
  admin_operator: '運営',
  admin_support: 'サポート',
  admin_auditor: '監査',
  system: 'システム',
};
export const actorRoleLabel = (v: string | null | undefined) => (v ? ACTOR_ROLE[v] ?? v : '—');

type EarningState = NonNullable<NonNullable<S['Assignment']['earning']>['state']>;
export const EARNING_STATE: Record<EarningState, StatusLabel> = {
  estimated: { label: '見込み', tone: 'gray' },
  pending: { label: '保留', tone: 'orange' },
  payable: { label: '支払確定', tone: 'green' },
  paid: { label: '振込済み', tone: 'navy' },
  failed: { label: '振込失敗', tone: 'red' },
  reversed: { label: '取消（逆仕訳）', tone: 'red' },
};
export const earningStateLabel = (v: string | null | undefined) => lookup(EARNING_STATE, v);

type DiscrepancyType = S['Reconciliation']['discrepancies'][number]['type'];
export const DISCREPANCY_TYPE: Record<DiscrepancyType, string> = {
  snapshot_mismatch: '受諾スナップショットと台帳の不一致',
  provider_unconfirmed: '決済事業者で未確認',
  ledger_payout_mismatch: '台帳と振込の不一致',
  payout_failed: '振込失敗',
  employment_payroll: '雇用（給与計算で別処理）',
};
export const discrepancyLabel = (v: string | null | undefined) => (v ? (DISCREPANCY_TYPE as Record<string, string>)[v] ?? v : '—');
