/**
 * 案件（NewJob）入力フォームの状態・検証・変換。制約は openapi.yaml v1.1 の NewJob を反映する。
 * 画面は文字列で保持し、送信時に NewJob（UTC ISO・整数円）へ変換する。
 */
import type { components } from '@happydrive/contracts';
import { jstInputToUtcIso, utcIsoToJstInput } from '@happydrive/web-ui/format';
import { RESTRICTED_CATEGORIES } from '@happydrive/web-ui/labels';
import { isValidLatitude, isValidLongitude, toHalfWidth } from './geo';

type S = components['schemas'];
export type NewJob = S['NewJob'];
export type OrgJob = S['OrgJob'];
export type JobCategory = S['JobCategory'];
export type ContractType = S['ContractType'];

export const CATEGORY_VALUES: readonly JobCategory[] = [
  'elderly_watch',
  'life_support',
  'shopping_assist',
  'corporate_task',
  'community_info',
  'delivery_related',
  'personal_care',
  'healthcare',
];
export const CONTRACT_TYPES: readonly ContractType[] = ['employment', 'contractor', 'other_legal_review'];

export interface StepForm {
  title: string;
  description: string;
  requiresPhoto: boolean;
}

export interface JobFormState {
  title: string;
  category: JobCategory | '';
  contractType: ContractType | '';
  startsAt: string;
  endsAt: string;
  amountYen: string;
  expensesReimbursedYen: string;
  workerBorneCostsNote: string;
  capacity: string;
  siteId: string;
  address: string;
  latitude: string;
  longitude: string;
  areaLabel: string;
  description: string;
  requiredSkills: string[];
  freeCancelHoursBefore: string;
  lateCancelCompensationPercent: string;
  cancellationText: string;
  steps: StepForm[];
  minPhotoCount: string;
  requiresOrgApproval: boolean;
  reservationTtlMinutes: string;
  checkInRadiusMeters: string;
  meetingPointNote: string;
  safetyNotes: string;
  contactName: string;
  paymentTermsText: string;
  employmentTermsText: string;
}

export function emptyJobForm(): JobFormState {
  return {
    title: '',
    category: '',
    contractType: '',
    startsAt: '',
    endsAt: '',
    amountYen: '',
    expensesReimbursedYen: '',
    workerBorneCostsNote: '',
    capacity: '1',
    siteId: '',
    address: '',
    latitude: '',
    longitude: '',
    areaLabel: '',
    description: '',
    requiredSkills: [],
    freeCancelHoursBefore: '24',
    lateCancelCompensationPercent: '50',
    cancellationText: '',
    steps: [{ title: '', description: '', requiresPhoto: false }],
    minPhotoCount: '',
    requiresOrgApproval: false,
    reservationTtlMinutes: '',
    checkInRadiusMeters: '',
    meetingPointNote: '',
    safetyNotes: '',
    contactName: '',
    paymentTermsText: '',
    employmentTermsText: '',
  };
}

const str = (v: number | undefined | null) => (v === undefined || v === null ? '' : String(v));

/** 既存案件をフォームへ（編集・複製） */
export function jobToForm(job: OrgJob): JobFormState {
  return {
    title: job.title,
    category: job.category,
    contractType: job.contractType,
    startsAt: utcIsoToJstInput(job.startsAt),
    endsAt: utcIsoToJstInput(job.endsAt),
    amountYen: str(job.amountYen),
    expensesReimbursedYen: str(job.expensesReimbursedYen),
    workerBorneCostsNote: job.workerBorneCostsNote ?? '',
    capacity: str(job.capacity),
    siteId: job.siteId ?? '',
    address: job.address,
    latitude: str(job.location?.latitude),
    longitude: str(job.location?.longitude),
    areaLabel: job.areaLabel,
    description: job.description,
    requiredSkills: [...(job.requiredSkills ?? [])],
    freeCancelHoursBefore: str(job.cancellationPolicy?.freeCancelHoursBefore),
    lateCancelCompensationPercent: str(job.cancellationPolicy?.lateCancelCompensationPercent),
    cancellationText: job.cancellationPolicy?.text ?? '',
    steps: (job.steps ?? []).map((s) => ({ title: s.title, description: s.description ?? '', requiresPhoto: !!s.requiresPhoto })),
    minPhotoCount: str(job.minPhotoCount),
    requiresOrgApproval: !!job.requiresOrgApproval,
    reservationTtlMinutes: str(job.reservationTtlMinutes),
    checkInRadiusMeters: str(job.checkInRadiusMeters),
    meetingPointNote: job.meetingPointNote ?? '',
    safetyNotes: job.safetyNotes ?? '',
    contactName: job.contactName ?? '',
    paymentTermsText: job.paymentTermsText ?? '',
    employmentTermsText: job.employmentTermsText ?? '',
  };
}

export type JobFormErrors = Record<string, string>;

/** 「12,000」「１２０００」も受け付ける整数解釈。空は undefined、不正は NaN。 */
export function parseInteger(raw: string): number | undefined {
  const s = toHalfWidth(raw).replace(/[,\s円¥￥]/g, '');
  if (s === '') return undefined;
  if (!/^-?\d+$/.test(s)) return Number.NaN;
  return Number(s);
}

export function parseDecimal(raw: string): number | undefined {
  const s = toHalfWidth(raw).trim();
  if (s === '') return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Number(s);
}

const len = (s: string) => Array.from(s).length;

function checkText(errors: JobFormErrors, key: string, label: string, value: string, opts: { min?: number; max: number; required?: boolean }) {
  const v = value.trim();
  if (!v) {
    if (opts.required) errors[key] = `${label}を入力してください。`;
    return;
  }
  if (opts.min && len(v) < opts.min) errors[key] = `${label}は${opts.min}文字以上で入力してください。`;
  else if (len(v) > opts.max) errors[key] = `${label}は${opts.max}文字以内で入力してください。`;
}

function checkInt(
  errors: JobFormErrors,
  key: string,
  label: string,
  raw: string,
  opts: { min: number; max: number; required?: boolean; unit?: string },
): number | undefined {
  const n = parseInteger(raw);
  if (n === undefined) {
    if (opts.required) errors[key] = `${label}を入力してください。`;
    return undefined;
  }
  const unit = opts.unit ?? '';
  if (Number.isNaN(n)) errors[key] = `${label}は半角の整数で入力してください。`;
  else if (n < opts.min || n > opts.max)
    errors[key] = `${label}は${opts.min.toLocaleString('ja-JP')}${unit}以上${opts.max.toLocaleString('ja-JP')}${unit}以下で入力してください。`;
  else return n;
  return undefined;
}

export interface ValidationResult {
  value?: NewJob;
  errors: JobFormErrors;
}

/**
 * フォームを検証して NewJob に変換する。エラーがあれば value は undefined。
 * - personal_care / healthcare は資格要件・事業審査が確定するまで作成不可
 * - 雇用は労働条件（employmentTermsText）必須、業務委託は支払条件（paymentTermsText）必須
 * - 日時は JST 入力 → UTC ISO
 */
export function validateJobForm(form: JobFormState, now: Date = new Date()): ValidationResult {
  const errors: JobFormErrors = {};

  checkText(errors, 'title', '案件名', form.title, { min: 4, max: 80, required: true });

  if (!form.category) errors.category = 'カテゴリを選択してください。';
  else if (!CATEGORY_VALUES.includes(form.category)) errors.category = 'カテゴリが正しくありません。';
  else if ((RESTRICTED_CATEGORIES as readonly string[]).includes(form.category))
    errors.category = '身体介護・医療関連は資格要件・事業審査が確定するまで作成・公開できません。';

  if (!form.contractType) errors.contractType = '契約区分を選択してください。';
  else if (!CONTRACT_TYPES.includes(form.contractType)) errors.contractType = '契約区分が正しくありません。';

  const startsAt = jstInputToUtcIso(form.startsAt);
  const endsAt = jstInputToUtcIso(form.endsAt);
  if (!form.startsAt) errors.startsAt = '開始日時を入力してください。';
  else if (!startsAt) errors.startsAt = '開始日時が正しくありません。';
  else if (Date.parse(startsAt) <= now.getTime()) errors.startsAt = '開始日時は現在より後にしてください。';
  if (!form.endsAt) errors.endsAt = '終了日時を入力してください。';
  else if (!endsAt) errors.endsAt = '終了日時が正しくありません。';
  else if (startsAt && Date.parse(endsAt) <= Date.parse(startsAt)) errors.endsAt = '終了日時は開始日時より後にしてください。';

  const amountYen = checkInt(errors, 'amountYen', '報酬', form.amountYen, { min: 1, max: 1_000_000, required: true, unit: '円' });
  const expensesReimbursedYen = checkInt(errors, 'expensesReimbursedYen', '実費負担', form.expensesReimbursedYen, { min: 0, max: 100_000, unit: '円' });
  checkText(errors, 'workerBorneCostsNote', 'ドライバー負担の費用', form.workerBorneCostsNote, { max: 500 });
  const capacity = checkInt(errors, 'capacity', '募集人数', form.capacity, { min: 1, max: 500, required: true, unit: '人' });

  checkText(errors, 'address', '住所', form.address, { min: 4, max: 200, required: true });
  const lat = parseDecimal(form.latitude);
  const lng = parseDecimal(form.longitude);
  if (lat === undefined) errors.latitude = '緯度を入力してください。';
  else if (Number.isNaN(lat) || !isValidLatitude(lat)) errors.latitude = '緯度は -90〜90 の数値で入力してください。';
  if (lng === undefined) errors.longitude = '経度を入力してください。';
  else if (Number.isNaN(lng) || !isValidLongitude(lng)) errors.longitude = '経度は -180〜180 の数値で入力してください。';
  checkText(errors, 'areaLabel', '公開用の地域名', form.areaLabel, { min: 2, max: 40, required: true });

  checkText(errors, 'description', '業務内容', form.description, { min: 10, max: 4000, required: true });

  if (form.requiredSkills.length > 10) errors.requiredSkills = '必要資格は10件まで選択できます。';

  const freeCancelHoursBefore = checkInt(errors, 'freeCancelHoursBefore', '無償取消の期限', form.freeCancelHoursBefore, {
    min: 0,
    max: 168,
    required: true,
    unit: '時間',
  });
  const lateCancelCompensationPercent = checkInt(errors, 'lateCancelCompensationPercent', '期限後取消の補償率', form.lateCancelCompensationPercent, {
    min: 0,
    max: 100,
    required: true,
    unit: '%',
  });
  checkText(errors, 'cancellationText', 'キャンセル規定', form.cancellationText, { min: 1, max: 2000, required: true });

  if (form.steps.length === 0) errors.steps = '手順を1件以上登録してください。';
  else if (form.steps.length > 20) errors.steps = '手順は20件までです。';
  form.steps.forEach((s, i) => {
    checkText(errors, `steps.${i}.title`, `手順${i + 1}の名称`, s.title, { min: 1, max: 100, required: true });
    checkText(errors, `steps.${i}.description`, `手順${i + 1}の説明`, s.description, { max: 1000 });
  });

  const minPhotoCount = checkInt(errors, 'minPhotoCount', '必要な写真枚数', form.minPhotoCount, { min: 0, max: 20, unit: '枚' });
  const photoSteps = form.steps.filter((s) => s.requiresPhoto).length;
  if (minPhotoCount !== undefined && photoSteps > 0 && minPhotoCount < photoSteps && !errors.minPhotoCount) {
    errors.minPhotoCount = `写真必須の手順が${photoSteps}件あるため、${photoSteps}枚以上にしてください。`;
  }
  const reservationTtlMinutes = checkInt(errors, 'reservationTtlMinutes', '承認期限', form.reservationTtlMinutes, { min: 10, max: 1440, unit: '分' });
  if (form.requiresOrgApproval && reservationTtlMinutes === undefined && !errors.reservationTtlMinutes) {
    errors.reservationTtlMinutes = '発注者承認ありの場合は承認期限（分）を入力してください。';
  }
  const checkInRadiusMeters = checkInt(errors, 'checkInRadiusMeters', 'チェックイン範囲', form.checkInRadiusMeters, { min: 50, max: 2000, unit: 'm' });
  checkText(errors, 'meetingPointNote', '集合場所の補足', form.meetingPointNote, { max: 500 });
  checkText(errors, 'safetyNotes', '安全上の注意', form.safetyNotes, { max: 1000 });
  checkText(errors, 'contactName', '連絡担当者名', form.contactName, { max: 60 });
  checkText(errors, 'paymentTermsText', '支払条件', form.paymentTermsText, {
    min: 1,
    max: 500,
    required: form.contractType === 'contractor',
  });
  if (form.contractType === 'contractor' && errors.paymentTermsText?.endsWith('を入力してください。')) {
    errors.paymentTermsText = '業務委託では支払期日・支払方法（取引条件）の明示が必要です。';
  }
  checkText(errors, 'employmentTermsText', '労働条件', form.employmentTermsText, { max: 4000, required: form.contractType === 'employment' });
  if (form.contractType === 'employment' && errors.employmentTermsText?.endsWith('を入力してください。')) {
    errors.employmentTermsText = '雇用の案件は労働条件（就業場所・時間・賃金・休憩等）の記載が必要です。';
  }

  if (Object.keys(errors).length > 0) return { errors };

  const opt = (s: string) => (s.trim() ? s.trim() : undefined);
  const value: NewJob = {
    title: form.title.trim(),
    category: form.category as JobCategory,
    contractType: form.contractType as ContractType,
    startsAt: startsAt!,
    endsAt: endsAt!,
    amountYen: amountYen!,
    capacity: capacity!,
    address: form.address.trim(),
    location: { latitude: lat!, longitude: lng! },
    areaLabel: form.areaLabel.trim(),
    description: form.description.trim(),
    cancellationPolicy: {
      freeCancelHoursBefore: freeCancelHoursBefore!,
      lateCancelCompensationPercent: lateCancelCompensationPercent!,
      text: form.cancellationText.trim(),
    },
    steps: form.steps.map((s) => ({
      title: s.title.trim(),
      ...(opt(s.description) ? { description: s.description.trim() } : {}),
      requiresPhoto: s.requiresPhoto,
    })),
    requiredSkills: [...form.requiredSkills],
    requiresOrgApproval: form.requiresOrgApproval,
  };
  if (expensesReimbursedYen !== undefined) value.expensesReimbursedYen = expensesReimbursedYen;
  if (opt(form.workerBorneCostsNote)) value.workerBorneCostsNote = form.workerBorneCostsNote.trim();
  if (form.siteId) value.siteId = form.siteId;
  if (minPhotoCount !== undefined) value.minPhotoCount = minPhotoCount;
  if (form.requiresOrgApproval && reservationTtlMinutes !== undefined) value.reservationTtlMinutes = reservationTtlMinutes;
  if (checkInRadiusMeters !== undefined) value.checkInRadiusMeters = checkInRadiusMeters;
  if (opt(form.meetingPointNote)) value.meetingPointNote = form.meetingPointNote.trim();
  if (opt(form.safetyNotes)) value.safetyNotes = form.safetyNotes.trim();
  if (opt(form.contactName)) value.contactName = form.contactName.trim();
  if (opt(form.paymentTermsText)) value.paymentTermsText = form.paymentTermsText.trim();
  if (opt(form.employmentTermsText)) value.employmentTermsText = form.employmentTermsText.trim();
  return { value, errors: {} };
}

/** 保存はできるが公開できない条件の注意 */
export function publishWarnings(form: JobFormState, orgApproved: boolean): string[] {
  const w: string[] = [];
  if (form.contractType === 'other_legal_review') w.push('契約区分「その他（法務審査中）」の案件は下書き保存のみ可能で、公開（審査申請）はできません。');
  if (!orgApproved) w.push('組織が運営の審査で承認されるまで、この案件を公開（審査申請）できません。');
  return w;
}
