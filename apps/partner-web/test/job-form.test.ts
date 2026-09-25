import { describe, expect, it } from 'vitest';
import { emptyJobForm, jobToForm, parseInteger, publishWarnings, validateJobForm, type JobFormState, type OrgJob } from '@/lib/job-form';

const NOW = new Date('2026-09-26T00:00:00Z');

function validForm(overrides: Partial<JobFormState> = {}): JobFormState {
  return {
    ...emptyJobForm(),
    title: '買い物付き添い',
    category: 'shopping_assist',
    contractType: 'contractor',
    startsAt: '2026-10-01T09:00',
    endsAt: '2026-10-01T12:00',
    amountYen: '4,500',
    capacity: '2',
    address: '神奈川県横浜市中区本町1-1',
    latitude: '35.4478',
    longitude: '139.6425',
    areaLabel: '横浜市中区',
    description: '高齢の方の買い物に付き添い、荷物を運びます。',
    cancellationText: '開始24時間前までは無償で取消できます。',
    steps: [{ title: '集合・挨拶', description: '', requiresPhoto: false }],
    paymentTermsText: '月末締め翌月末払い（銀行振込）',
    ...overrides,
  };
}

describe('validateJobForm', () => {
  it('正しい入力を NewJob（UTC・整数円）に変換する', () => {
    const { value, errors } = validateJobForm(validForm(), NOW);
    expect(errors).toEqual({});
    expect(value).toMatchObject({
      title: '買い物付き添い',
      category: 'shopping_assist',
      contractType: 'contractor',
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-10-01T03:00:00.000Z',
      amountYen: 4500,
      capacity: 2,
      location: { latitude: 35.4478, longitude: 139.6425 },
      cancellationPolicy: { freeCancelHoursBefore: 24, lateCancelCompensationPercent: 50 },
      steps: [{ title: '集合・挨拶', requiresPhoto: false }],
      requiresOrgApproval: false,
    });
    // 空の任意項目は送らない（additionalProperties: false・minLength 対策）
    expect(value).not.toHaveProperty('contactName');
    expect(value).not.toHaveProperty('employmentTermsText');
    expect(value).not.toHaveProperty('siteId');
    expect(value).not.toHaveProperty('reservationTtlMinutes');
  });

  it('必須項目の欠落を日本語で指摘する', () => {
    const { value, errors } = validateJobForm(emptyJobForm(), NOW);
    expect(value).toBeUndefined();
    expect(errors.title).toBe('案件名を入力してください。');
    expect(errors.category).toBe('カテゴリを選択してください。');
    expect(errors.contractType).toBe('契約区分を選択してください。');
    expect(errors.startsAt).toBe('開始日時を入力してください。');
    expect(errors.amountYen).toBe('報酬を入力してください。');
    expect(errors.latitude).toBe('緯度を入力してください。');
    expect(errors['steps.0.title']).toBe('手順1の名称を入力してください。');
    expect(errors.cancellationText).toBe('キャンセル規定を入力してください。');
  });

  it('文字数の境界（title 4〜80, description 10〜4000, areaLabel 2〜40）', () => {
    expect(validateJobForm(validForm({ title: 'abc' }), NOW).errors.title).toMatch(/4文字以上/);
    expect(validateJobForm(validForm({ title: 'abcd' }), NOW).errors.title).toBeUndefined();
    expect(validateJobForm(validForm({ title: 'あ'.repeat(81) }), NOW).errors.title).toMatch(/80文字以内/);
    expect(validateJobForm(validForm({ description: '短い説明' }), NOW).errors.description).toMatch(/10文字以上/);
    expect(validateJobForm(validForm({ areaLabel: '横' }), NOW).errors.areaLabel).toMatch(/2文字以上/);
    expect(validateJobForm(validForm({ address: '横浜' }), NOW).errors.address).toMatch(/4文字以上/);
  });

  it('金額・人数の範囲（amountYen 1〜1,000,000、capacity 1〜500）', () => {
    expect(validateJobForm(validForm({ amountYen: '0' }), NOW).errors.amountYen).toMatch(/1円以上1,000,000円以下/);
    expect(validateJobForm(validForm({ amountYen: '1000001' }), NOW).errors.amountYen).toBeDefined();
    expect(validateJobForm(validForm({ amountYen: '1000.5' }), NOW).errors.amountYen).toMatch(/整数/);
    expect(validateJobForm(validForm({ amountYen: '１２０００' }), NOW).value?.amountYen).toBe(12000);
    expect(validateJobForm(validForm({ capacity: '501' }), NOW).errors.capacity).toBeDefined();
    expect(validateJobForm(validForm({ expensesReimbursedYen: '100001' }), NOW).errors.expensesReimbursedYen).toBeDefined();
    expect(validateJobForm(validForm({ expensesReimbursedYen: '0' }), NOW).value?.expensesReimbursedYen).toBe(0);
  });

  it('日時: 終了は開始より後、開始は未来', () => {
    expect(validateJobForm(validForm({ endsAt: '2026-10-01T09:00' }), NOW).errors.endsAt).toMatch(/開始日時より後/);
    expect(validateJobForm(validForm({ startsAt: '2026-09-25T09:00', endsAt: '2026-09-25T10:00' }), NOW).errors.startsAt).toMatch(/現在より後/);
    expect(validateJobForm(validForm({ startsAt: '2026-02-30T09:00' }), NOW).errors.startsAt).toMatch(/正しくありません/);
  });

  it('身体介護・医療関連は作成不可', () => {
    expect(validateJobForm(validForm({ category: 'personal_care' }), NOW).errors.category).toMatch(/資格要件・事業審査/);
    expect(validateJobForm(validForm({ category: 'healthcare' }), NOW).errors.category).toMatch(/資格要件・事業審査/);
  });

  it('雇用は労働条件が必須、業務委託は支払条件が必須', () => {
    const emp = validateJobForm(validForm({ contractType: 'employment', employmentTermsText: '' }), NOW);
    expect(emp.errors.employmentTermsText).toMatch(/労働条件/);
    const empOk = validateJobForm(validForm({ contractType: 'employment', employmentTermsText: '就業場所: 横浜市中区、時給1,200円、休憩なし' }), NOW);
    expect(empOk.errors).toEqual({});
    const con = validateJobForm(validForm({ paymentTermsText: '  ' }), NOW);
    expect(con.errors.paymentTermsText).toMatch(/取引条件/);
  });

  it('その他（法務審査中）は保存可能だが公開不可の警告', () => {
    const r = validateJobForm(validForm({ contractType: 'other_legal_review', paymentTermsText: '' }), NOW);
    expect(r.errors).toEqual({});
    expect(publishWarnings(validForm({ contractType: 'other_legal_review' }), true)[0]).toMatch(/公開（審査申請）はできません/);
    expect(publishWarnings(validForm(), false)[0]).toMatch(/承認されるまで/);
    expect(publishWarnings(validForm(), true)).toEqual([]);
  });

  it('手順は1〜20件、写真必須の手順数以上の写真枚数', () => {
    expect(validateJobForm(validForm({ steps: [] }), NOW).errors.steps).toMatch(/1件以上/);
    const many = Array.from({ length: 21 }, (_, i) => ({ title: `手順${i}`, description: '', requiresPhoto: false }));
    expect(validateJobForm(validForm({ steps: many }), NOW).errors.steps).toMatch(/20件まで/);
    const photo = validateJobForm(
      validForm({
        steps: [
          { title: 'a', description: '', requiresPhoto: true },
          { title: 'b', description: '', requiresPhoto: true },
        ],
        minPhotoCount: '1',
      }),
      NOW,
    );
    expect(photo.errors.minPhotoCount).toMatch(/2枚以上/);
  });

  it('位置・チェックイン範囲・承認期限の範囲', () => {
    expect(validateJobForm(validForm({ latitude: '91' }), NOW).errors.latitude).toBeDefined();
    expect(validateJobForm(validForm({ longitude: 'abc' }), NOW).errors.longitude).toBeDefined();
    expect(validateJobForm(validForm({ checkInRadiusMeters: '49' }), NOW).errors.checkInRadiusMeters).toMatch(/50m以上2,000m以下/);
    expect(validateJobForm(validForm({ requiresOrgApproval: true }), NOW).errors.reservationTtlMinutes).toMatch(/承認期限/);
    expect(validateJobForm(validForm({ requiresOrgApproval: true, reservationTtlMinutes: '9' }), NOW).errors.reservationTtlMinutes).toBeDefined();
    const ok = validateJobForm(validForm({ requiresOrgApproval: true, reservationTtlMinutes: '60' }), NOW);
    expect(ok.value?.reservationTtlMinutes).toBe(60);
  });

  it('キャンセル規定の範囲（0〜168時間、0〜100%）', () => {
    expect(validateJobForm(validForm({ freeCancelHoursBefore: '169' }), NOW).errors.freeCancelHoursBefore).toBeDefined();
    expect(validateJobForm(validForm({ lateCancelCompensationPercent: '101' }), NOW).errors.lateCancelCompensationPercent).toBeDefined();
    expect(validateJobForm(validForm({ freeCancelHoursBefore: '' }), NOW).errors.freeCancelHoursBefore).toMatch(/入力してください/);
  });

  it('必要資格は10件まで', () => {
    const skills = Array.from({ length: 11 }, (_, i) => `skill_${i}`);
    expect(validateJobForm(validForm({ requiredSkills: skills }), NOW).errors.requiredSkills).toBeDefined();
  });
});

describe('jobToForm（編集・複製）', () => {
  it('既存案件をフォームに戻し、再検証で同じ NewJob になる', () => {
    const { value } = validateJobForm(validForm({ contactName: '山田', siteId: '4f7c2c64-3f2b-4d8d-9f5e-2f9a6b0b8a11' }), NOW);
    const job = { ...value!, id: 'j', organizationId: 'o', organizationName: 'x', status: 'draft', remainingCapacity: 2, requiredSkills: [], createdAt: '2026-09-01T00:00:00Z' } as unknown as OrgJob;
    const again = validateJobForm(jobToForm(job), NOW);
    expect(again.value).toEqual(value);
  });
});

describe('parseInteger', () => {
  it('カンマ・円記号・全角数字を許容', () => {
    expect(parseInteger('12,000')).toBe(12000);
    expect(parseInteger('￥3,000')).toBe(3000);
    expect(parseInteger('')).toBeUndefined();
    expect(Number.isNaN(parseInteger('1e3'))).toBe(true);
  });
});
