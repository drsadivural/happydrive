'use client';
import { useState, type FormEvent } from 'react';
import type { components } from '@happydrive/contracts';
import { CONTRACT_TYPE, categoryLabel, RESTRICTED_CATEGORIES } from '@happydrive/web-ui/labels';
import { Alert, Button, ErrorAlert, Field } from '@happydrive/web-ui/components';
import { LocationFields } from './LocationFields';
import {
  CATEGORY_VALUES,
  CONTRACT_TYPES,
  publishWarnings,
  validateJobForm,
  type ContractType,
  type JobCategory,
  type JobFormState,
  type NewJob,
  type StepForm,
} from '@/lib/job-form';

type Site = components['schemas']['Site'];
type SkillDefinition = components['schemas']['SkillDefinition'];

const CONTRACT_HELP: Record<ContractType, string> = {
  employment: '雇用契約（労働条件の明示が必要）。業務委託と区別して表示・支払されます。',
  contractor: '業務委託（成果・業務の委託）。支払期日・方法などの取引条件を明示してください。',
  other_legal_review: '法務審査中の区分です。下書き保存のみ可能で、公開（審査申請）はできません。',
};

export function JobForm({
  initial,
  sites,
  skills,
  orgApproved,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: JobFormState;
  sites: readonly Site[];
  skills: readonly SkillDefinition[];
  orgApproved: boolean;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (value: NewJob) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<JobFormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof JobFormState>(k: K, v: JobFormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setStep = (i: number, patch: Partial<StepForm>) =>
    setForm((f) => ({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const moveStep = (i: number, d: -1 | 1) =>
    setForm((f) => {
      const steps = [...f.steps];
      const j = i + d;
      if (j < 0 || j >= steps.length) return f;
      [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      return { ...f, steps };
    });

  const warnings = publishWarnings(form, orgApproved);
  const errorCount = Object.keys(errors).length;

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    const r = validateJobForm(form);
    setErrors(r.errors);
    if (r.value) onSubmit(r.value);
    else {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
    }
  }

  function applySite(siteId: string) {
    const site = sites.find((s) => s.id === siteId);
    if (!site) {
      set('siteId', '');
      return;
    }
    setForm((f) => ({
      ...f,
      siteId: site.id,
      address: site.address,
      latitude: String(site.location.latitude),
      longitude: String(site.location.longitude),
      areaLabel: site.areaLabel,
    }));
  }

  const err = (k: string) => errors[k];

  return (
    <form className="hd-form" onSubmit={submit} noValidate>
      {submitted && errorCount > 0 ? (
        <Alert tone="red" title={`入力内容を確認してください（${errorCount}件）`} role="alert">
          赤枠の項目を修正してください。
        </Alert>
      ) : null}

      <fieldset className="hd-fieldset">
        <legend>基本情報</legend>
        <div className="hd-stack">
          <Field label="案件名" required error={err('title')} hint="4〜80文字">
            {(p) => <input {...p} className="hd-input" value={form.title} maxLength={80} onChange={(e) => set('title', e.target.value)} />}
          </Field>
          <div className="hd-grid-2">
            <Field
              label="カテゴリ"
              required
              error={err('category')}
              hint="身体介護・医療関連は、資格要件・事業審査が確定するまで公開不可のため選択できません。"
            >
              {(p) => (
                <select {...p} className="hd-select" value={form.category} onChange={(e) => set('category', e.target.value as JobCategory)}>
                  <option value="">選択してください</option>
                  {CATEGORY_VALUES.map((c) => {
                    const restricted = (RESTRICTED_CATEGORIES as readonly string[]).includes(c);
                    return (
                      <option key={c} value={c} disabled={restricted}>
                        {categoryLabel(c).label}
                        {restricted ? '（資格要件・事業審査が確定するまで公開不可）' : ''}
                      </option>
                    );
                  })}
                </select>
              )}
            </Field>
            <div className="hd-field">
              <span className="hd-label" id="contract-type-label">
                契約区分<span className="hd-required">必須</span>
              </span>
              <div role="radiogroup" aria-labelledby="contract-type-label" className="hd-stack" style={{ gap: 4 }}>
                {CONTRACT_TYPES.map((t) => (
                  <label key={t} className="hd-check" style={{ alignItems: 'flex-start' }}>
                    <input
                      type="radio"
                      name="contractType"
                      value={t}
                      checked={form.contractType === t}
                      onChange={() => set('contractType', t)}
                    />
                    <span>
                      <strong>{CONTRACT_TYPE[t].label}</strong>
                      <br />
                      <span className="hd-hint">{CONTRACT_HELP[t]}</span>
                    </span>
                  </label>
                ))}
              </div>
              {err('contractType') ? <span className="hd-error-text">{err('contractType')}</span> : null}
            </div>
          </div>
          <Field label="業務内容" required error={err('description')} hint="10〜4000文字。医療判断を含む業務は掲載できません。">
            {(p) => (
              <textarea {...p} className="hd-textarea" rows={6} value={form.description} maxLength={4000} onChange={(e) => set('description', e.target.value)} />
            )}
          </Field>
        </div>
      </fieldset>

      <fieldset className="hd-fieldset">
        <legend>日時・募集</legend>
        <div className="hd-stack">
          <div className="hd-grid-2">
            <Field label="開始日時（日本時間）" required error={err('startsAt')}>
              {(p) => <input {...p} className="hd-input" type="datetime-local" value={form.startsAt} onChange={(e) => set('startsAt', e.target.value)} />}
            </Field>
            <Field label="終了日時（日本時間）" required error={err('endsAt')}>
              {(p) => <input {...p} className="hd-input" type="datetime-local" value={form.endsAt} onChange={(e) => set('endsAt', e.target.value)} />}
            </Field>
          </div>
          <div className="hd-grid-2">
            <Field label="募集人数" required error={err('capacity')} hint="1〜500人">
              {(p) => <input {...p} className="hd-input" inputMode="numeric" value={form.capacity} onChange={(e) => set('capacity', e.target.value)} />}
            </Field>
            <div className="hd-field">
              <label className="hd-check">
                <input type="checkbox" checked={form.requiresOrgApproval} onChange={(e) => set('requiresOrgApproval', e.target.checked)} />
                <span>応募を発注者が承認してから確定する</span>
              </label>
              {form.requiresOrgApproval ? (
                <Field label="承認期限（分）" required error={err('reservationTtlMinutes')} hint="10〜1440分。期限内に承認しないと枠は解放されます。">
                  {(p) => (
                    <input {...p} className="hd-input" inputMode="numeric" value={form.reservationTtlMinutes} onChange={(e) => set('reservationTtlMinutes', e.target.value)} />
                  )}
                </Field>
              ) : null}
            </div>
          </div>
        </div>
      </fieldset>

      <fieldset className="hd-fieldset">
        <legend>場所</legend>
        <div className="hd-stack">
          <Field label="拠点から入力" hint={sites.length ? '選択すると住所・位置・地域名を入力します（後から変更できます）' : '拠点は「拠点」画面で登録できます'}>
            {(p) => (
              <select {...p} className="hd-select" value={form.siteId} onChange={(e) => applySite(e.target.value)} disabled={sites.length === 0}>
                <option value="">拠点を使わない</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{s.areaLabel}）
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="住所" required error={err('address')} hint="受諾したドライバーと自組織のみ閲覧できます">
            {(p) => <input {...p} className="hd-input" value={form.address} maxLength={200} onChange={(e) => set('address', e.target.value)} />}
          </Field>
          <LocationFields
            address={form.address}
            latitude={form.latitude}
            longitude={form.longitude}
            errors={{ latitude: err('latitude'), longitude: err('longitude') }}
            onChange={(lat, lng) => setForm((f) => ({ ...f, latitude: lat, longitude: lng }))}
          />
          <div className="hd-grid-2">
            <Field label="公開用の地域名" required error={err('areaLabel')} hint="募集中に公開される粗い地域名（例 横浜市中区）">
              {(p) => <input {...p} className="hd-input" value={form.areaLabel} maxLength={40} onChange={(e) => set('areaLabel', e.target.value)} />}
            </Field>
            <Field label="チェックイン範囲（m）" error={err('checkInRadiusMeters')} hint="50〜2000m。未入力はサーバー既定値">
              {(p) => (
                <input {...p} className="hd-input" inputMode="numeric" value={form.checkInRadiusMeters} onChange={(e) => set('checkInRadiusMeters', e.target.value)} />
              )}
            </Field>
          </div>
          <Field label="集合場所の補足" error={err('meetingPointNote')} hint="500文字以内">
            {(p) => <textarea {...p} className="hd-textarea" rows={2} value={form.meetingPointNote} maxLength={500} onChange={(e) => set('meetingPointNote', e.target.value)} />}
          </Field>
        </div>
      </fieldset>

      <fieldset className="hd-fieldset">
        <legend>報酬・費用・支払条件</legend>
        <div className="hd-stack">
          <div className="hd-grid-2">
            <Field label="報酬（円・1人あたり）" required error={err('amountYen')} hint="1〜1,000,000円（税込の総額を表示してください）">
              {(p) => <input {...p} className="hd-input" inputMode="numeric" value={form.amountYen} onChange={(e) => set('amountYen', e.target.value)} />}
            </Field>
            <Field label="発注者が負担する実費（円）" error={err('expensesReimbursedYen')} hint="交通費等。0〜100,000円">
              {(p) => (
                <input {...p} className="hd-input" inputMode="numeric" value={form.expensesReimbursedYen} onChange={(e) => set('expensesReimbursedYen', e.target.value)} />
              )}
            </Field>
          </div>
          <Field label="ドライバー負担の費用" error={err('workerBorneCostsNote')} hint="燃料・通信費など、ドライバーが負担する費用を明記（500文字以内）">
            {(p) => (
              <textarea {...p} className="hd-textarea" rows={2} value={form.workerBorneCostsNote} maxLength={500} onChange={(e) => set('workerBorneCostsNote', e.target.value)} />
            )}
          </Field>
          <Field
            label="支払条件（支払期日・方法）"
            required={form.contractType === 'contractor'}
            error={err('paymentTermsText')}
            hint="例: 検収月末締め・翌月末に銀行振込（500文字以内）"
          >
            {(p) => <textarea {...p} className="hd-textarea" rows={2} value={form.paymentTermsText} maxLength={500} onChange={(e) => set('paymentTermsText', e.target.value)} />}
          </Field>
          {form.contractType === 'employment' ? (
            <Field label="労働条件" required error={err('employmentTermsText')} hint="就業場所・就業時間・賃金・休憩・社会保険等（4000文字以内）">
              {(p) => (
                <textarea
                  {...p}
                  className="hd-textarea"
                  rows={5}
                  value={form.employmentTermsText}
                  maxLength={4000}
                  onChange={(e) => set('employmentTermsText', e.target.value)}
                />
              )}
            </Field>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="hd-fieldset">
        <legend>作業手順・証跡</legend>
        <div className="hd-stack">
          {err('steps') ? <span className="hd-error-text">{err('steps')}</span> : null}
          <ol className="hd-stack" style={{ paddingLeft: 20, margin: 0 }}>
            {form.steps.map((s, i) => (
              <li key={i}>
                <div className="hd-stack" style={{ gap: 8 }}>
                  <Field label={`手順${i + 1}`} required error={err(`steps.${i}.title`)}>
                    {(p) => <input {...p} className="hd-input" value={s.title} maxLength={100} onChange={(e) => setStep(i, { title: e.target.value })} />}
                  </Field>
                  <Field label="説明" error={err(`steps.${i}.description`)}>
                    {(p) => (
                      <textarea
                        {...p}
                        className="hd-textarea"
                        rows={2}
                        value={s.description}
                        maxLength={1000}
                        onChange={(e) => setStep(i, { description: e.target.value })}
                      />
                    )}
                  </Field>
                  <div className="hd-row">
                    <label className="hd-check">
                      <input type="checkbox" checked={s.requiresPhoto} onChange={(e) => setStep(i, { requiresPhoto: e.target.checked })} />
                      <span>写真の提出が必要</span>
                    </label>
                    <Button size="sm" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label={`手順${i + 1}を上へ`}>
                      ↑ 上へ
                    </Button>
                    <Button size="sm" onClick={() => moveStep(i, 1)} disabled={i === form.steps.length - 1} aria-label={`手順${i + 1}を下へ`}>
                      ↓ 下へ
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={form.steps.length <= 1}
                      onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))}
                    >
                      削除
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <div>
            <Button
              size="sm"
              disabled={form.steps.length >= 20}
              onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, { title: '', description: '', requiresPhoto: false }] }))}
            >
              手順を追加（最大20）
            </Button>
          </div>
          <Field label="完了報告に必要な写真枚数" error={err('minPhotoCount')} hint="0〜20枚">
            {(p) => <input {...p} className="hd-input" inputMode="numeric" value={form.minPhotoCount} onChange={(e) => set('minPhotoCount', e.target.value)} />}
          </Field>
        </div>
      </fieldset>

      <fieldset className="hd-fieldset">
        <legend>必要な資格・講習</legend>
        {skills.length === 0 ? (
          <p className="hd-muted" style={{ margin: 0 }}>
            登録できる資格・講習はありません。
          </p>
        ) : (
          <div className="hd-grid-2">
            {skills.map((sk) => (
              <label key={sk.code} className="hd-check" style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={form.requiredSkills.includes(sk.code)}
                  onChange={(e) =>
                    set('requiredSkills', e.target.checked ? [...form.requiredSkills, sk.code] : form.requiredSkills.filter((c) => c !== sk.code))
                  }
                />
                <span>
                  {sk.name}
                  <span className="hd-hint">（{sk.source === 'training' ? '講習' : '資格証'}）</span>
                  {sk.description ? <span className="hd-hint" style={{ display: 'block' }}>{sk.description}</span> : null}
                </span>
              </label>
            ))}
          </div>
        )}
        {err('requiredSkills') ? <span className="hd-error-text">{err('requiredSkills')}</span> : null}
      </fieldset>

      <fieldset className="hd-fieldset">
        <legend>キャンセル規定</legend>
        <div className="hd-stack">
          <div className="hd-grid-2">
            <Field label="無償で取消できる期限（開始の何時間前まで）" required error={err('freeCancelHoursBefore')} hint="0〜168時間（双方に適用）">
              {(p) => (
                <input {...p} className="hd-input" inputMode="numeric" value={form.freeCancelHoursBefore} onChange={(e) => set('freeCancelHoursBefore', e.target.value)} />
              )}
            </Field>
            <Field label="期限後に発注者が取消した場合の補償率（%）" required error={err('lateCancelCompensationPercent')} hint="0〜100%">
              {(p) => (
                <input
                  {...p}
                  className="hd-input"
                  inputMode="numeric"
                  value={form.lateCancelCompensationPercent}
                  onChange={(e) => set('lateCancelCompensationPercent', e.target.value)}
                />
              )}
            </Field>
          </div>
          <Field label="キャンセル規定の本文" required error={err('cancellationText')} hint="ドライバーに表示されます（2000文字以内）">
            {(p) => (
              <textarea {...p} className="hd-textarea" rows={3} value={form.cancellationText} maxLength={2000} onChange={(e) => set('cancellationText', e.target.value)} />
            )}
          </Field>
        </div>
      </fieldset>

      <fieldset className="hd-fieldset">
        <legend>安全・連絡</legend>
        <div className="hd-stack">
          <Field label="安全上の注意" error={err('safetyNotes')} hint="1000文字以内">
            {(p) => <textarea {...p} className="hd-textarea" rows={3} value={form.safetyNotes} maxLength={1000} onChange={(e) => set('safetyNotes', e.target.value)} />}
          </Field>
          <Field label="連絡担当者名" error={err('contactName')} hint="60文字以内。電話番号はドライバーに公開されません（連絡はメッセージ機能で行います）">
            {(p) => <input {...p} className="hd-input" value={form.contactName} maxLength={60} onChange={(e) => set('contactName', e.target.value)} />}
          </Field>
        </div>
      </fieldset>

      {warnings.map((w) => (
        <Alert key={w} tone="orange">
          {w}
        </Alert>
      ))}
      <ErrorAlert error={error} title="保存できませんでした" />
      <div className="hd-actions">
        <Button type="submit" variant="primary" loading={pending}>
          {submitLabel}
        </Button>
        <Button onClick={onCancel} disabled={pending}>
          キャンセル
        </Button>
      </div>
    </form>
  );
}
