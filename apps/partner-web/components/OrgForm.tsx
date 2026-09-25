'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ORG_KIND } from '@happydrive/web-ui/labels';
import { Button, ErrorAlert, Field } from '@happydrive/web-ui/components';
import { validateOrgForm, type OrganizationInput, type OrgFormState } from '@/lib/org-form';

export function OrgForm({
  initial,
  submitLabel,
  pending,
  error,
  disabled,
  onSubmit,
  footer,
}: {
  initial: OrgFormState;
  submitLabel: string;
  pending?: boolean;
  error?: unknown;
  disabled?: boolean;
  onSubmit: (value: OrganizationInput) => void;
  footer?: ReactNode;
}) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof OrgFormState>(k: K, v: OrgFormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = validateOrgForm(form);
    setErrors(r.errors);
    if (r.value) onSubmit(r.value);
  }

  return (
    <form className="hd-form" onSubmit={submit} noValidate>
      <fieldset className="hd-fieldset" disabled={disabled}>
        <legend>組織情報</legend>
        <div className="hd-stack">
          <div className="hd-grid-2">
            <Field label="正式名称" required error={errors.legalName} hint="登記上の名称（自治体は正式名称）">
              {(p) => <input {...p} className="hd-input" value={form.legalName} maxLength={120} onChange={(e) => set('legalName', e.target.value)} />}
            </Field>
            <Field label="種別" error={errors.kind}>
              {(p) => (
                <select {...p} className="hd-select" value={form.kind} onChange={(e) => set('kind', e.target.value as OrgFormState['kind'])}>
                  <option value="">選択してください</option>
                  {Object.entries(ORG_KIND).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <div className="hd-grid-2">
            <Field label="法人番号" error={errors.corporateNumber} hint="13桁（任意。国税庁の法人番号）">
              {(p) => (
                <input {...p} className="hd-input" inputMode="numeric" value={form.corporateNumber} maxLength={20} onChange={(e) => set('corporateNumber', e.target.value)} />
              )}
            </Field>
            <Field label="代表者名" required error={errors.representativeName}>
              {(p) => <input {...p} className="hd-input" value={form.representativeName} maxLength={100} onChange={(e) => set('representativeName', e.target.value)} />}
            </Field>
          </div>
          <Field label="所在地" required error={errors.address}>
            {(p) => <input {...p} className="hd-input" value={form.address} maxLength={200} onChange={(e) => set('address', e.target.value)} />}
          </Field>
          <Field label="公開連絡先" required error={errors.contact} hint="案件詳細でドライバーに表示されます（電話番号またはメールアドレス）">
            {(p) => <input {...p} className="hd-input" value={form.contact} maxLength={200} onChange={(e) => set('contact', e.target.value)} />}
          </Field>
        </div>
      </fieldset>
      <ErrorAlert error={error} title="保存できませんでした" />
      {footer}
      {!disabled ? (
        <div className="hd-actions">
          <Button type="submit" variant="primary" loading={pending}>
            {submitLabel}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
