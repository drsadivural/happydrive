'use client';
import { useState, type FormEvent } from 'react';
import type { components } from '@happydrive/contracts';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatNumber, formatPercent } from '@happydrive/web-ui/format';
import { AsyncView, Alert, Button, Card, ConfirmDialog, Field, KeyValue, PageHeader, StatCard } from '@happydrive/web-ui/components';
import { DateRangePicker, defaultRange, type Range } from '@/components/DateRange';
import { useAdmin } from '@/lib/admin-context';
import { validateMatchingConfig, WEIGHT_KEYS, WEIGHT_LABELS, type WeightForm } from '@/lib/admin-forms';
import { api, unwrap } from '@/lib/api';

type MatchingConfig = components['schemas']['MatchingConfig'];

function toForm(c: MatchingConfig): WeightForm {
  return {
    weights: Object.fromEntries(WEIGHT_KEYS.map((k) => [k, String(c.weights[k])])) as WeightForm['weights'],
    maxDistanceKm: String(c.maxDistanceKm),
    reason: '',
  };
}

function ConfigEditor({ config, onSaved }: { config: MatchingConfig; onSaved: (c: MatchingConfig) => void }) {
  const { canWrite } = useAdmin();
  const [form, setForm] = useState<WeightForm>(() => toForm(config));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingValue, setPendingValue] = useState<MatchingConfig | null>(null);
  const save = useMutation('matching-config', (body: MatchingConfig, key: string) => unwrap(api.PUT('/admin/matching/config', { params: { header: { 'Idempotency-Key': key } }, body })), {
    onSuccess: (c) => {
      setPendingValue(null);
      onSaved(c);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = validateMatchingConfig(form);
    setErrors(r.errors);
    if (r.value) setPendingValue(r.value);
  }

  return (
    <form className="hd-form" onSubmit={submit} noValidate>
      <fieldset className="hd-fieldset" disabled={!canWrite}>
        <legend>スコアの重み（0〜1）</legend>
        <div className="hd-grid-3">
          {WEIGHT_KEYS.map((k) => (
            <Field key={k} label={WEIGHT_LABELS[k]} error={errors[k]}>
              {(p) => (
                <input
                  {...p}
                  className="hd-input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={form.weights[k]}
                  onChange={(e) => setForm({ ...form, weights: { ...form.weights, [k]: e.target.value } })}
                />
              )}
            </Field>
          ))}
        </div>
        {errors.weights ? <span className="hd-error-text">{errors.weights}</span> : null}
        <div className="hd-grid-2" style={{ marginTop: 16 }}>
          <Field label="推薦の最大距離（km）" error={errors.maxDistanceKm} hint="1〜100km（ハード条件）">
            {(p) => <input {...p} className="hd-input" type="number" min={1} max={100} value={form.maxDistanceKm} onChange={(e) => setForm({ ...form, maxDistanceKm: e.target.value })} />}
          </Field>
          <Field label="変更理由" required error={errors.reason} hint="監査記録に残ります（500文字以内）">
            {(p) => <input {...p} className="hd-input" value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}
          </Field>
        </div>
      </fieldset>
      {canWrite ? (
        <div>
          <Button type="submit" variant="primary">
            重みを更新
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={!!pendingValue}
        title="マッチングの重みを更新しますか？"
        description="以後の推薦順位に反映されます（ハード条件による除外は変わりません）。変更は監査記録に残ります。"
        confirmLabel="更新する"
        pending={save.pending}
        error={save.error}
        onClose={() => {
          setPendingValue(null);
          save.reset();
        }}
        onConfirm={() => pendingValue && void save.run(pendingValue)}
      >
        {pendingValue ? (
          <KeyValue items={[...WEIGHT_KEYS.map((k) => [WEIGHT_LABELS[k], `${config.weights[k]} → ${pendingValue.weights[k]}`] as [string, string]), ['最大距離', `${config.maxDistanceKm}km → ${pendingValue.maxDistanceKm}km`], ['理由', pendingValue.reason]]} />
        ) : null}
      </ConfirmDialog>
    </form>
  );
}

export default function MatchingPage() {
  const config = useQuery('matching-config', () => unwrap(api.GET('/admin/matching/config')));
  const [range, setRange] = useState<Range>(() => defaultRange(30));
  const audit = useQuery(`matching-audit:${range.from}:${range.to}`, () => unwrap(api.GET('/admin/matching/audit', { params: { query: range } })));
  const [saved, setSaved] = useState(false);

  return (
    <>
      <PageHeader title="マッチング監査" description="推薦スコアの重みの管理と、除外理由・提示の偏り・受諾率の監査を行います。" />
      <Card title="推薦の設定">
        <AsyncView state={config}>
          {(c) => (
            <div className="hd-stack">
              {saved ? <Alert tone="green">重みを更新しました（監査記録済み）。</Alert> : null}
              <p className="hd-small hd-muted" style={{ margin: 0 }}>
                最終更新: {formatDateTimeJst(c.updatedAt)}
                {c.updatedBy ? `（${c.updatedBy}）` : ''}
                {c.reason ? ` ・ 理由: ${c.reason}` : ''}
              </p>
              <ConfigEditor
                key={c.updatedAt ?? 'initial'}
                config={c}
                onSaved={(n) => {
                  config.setData(n);
                  setSaved(true);
                }}
              />
            </div>
          )}
        </AsyncView>
      </Card>
      <Card title="推薦の監査">
        <div className="hd-stack">
          <DateRangePicker value={range} onChange={setRange} />
          <AsyncView state={audit}>
            {(a) => (
              <>
                <div className="hd-stats">
                  <StatCard label="提示回数" value={formatNumber(a.impressions)} tone="blue" />
                  <StatCard label="提示された人数" value={`${formatNumber(a.uniqueWorkersShown)}人`} tone="blue" />
                  <StatCard label="上位10%への集中度" value={formatPercent(a.top10PercentShare)} tone={(a.top10PercentShare ?? 0) > 0.5 ? 'red' : 'green'} />
                  <StatCard label="受諾率" value={formatPercent(a.acceptRate)} tone="green" />
                  <StatCard label="未対応の異議申立て" value={`${formatNumber(a.openAppeals ?? 0)}件`} tone="orange" />
                </div>
                <h3 style={{ fontSize: 16 }}>除外理由の分布</h3>
                {a.exclusionReasons.length === 0 ? (
                  <p className="hd-muted">除外の記録はありません。</p>
                ) : (
                  <div className="hd-table-wrap">
                    <table className="hd-table">
                      <thead>
                        <tr>
                          <th scope="col">理由</th>
                          <th scope="col" className="hd-num">
                            件数
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...a.exclusionReasons]
                          .sort((x, y) => y.count - x.count)
                          .map((r) => (
                            <tr key={r.reason}>
                              <td>{r.reason}</td>
                              <td className="hd-num">{formatNumber(r.count)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </AsyncView>
        </div>
      </Card>
    </>
  );
}
