'use client';
import { useState } from 'react';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { addMonths, formatMonth, formatNumber, formatYen, jstMonth } from '@happydrive/web-ui/format';
import { discrepancyLabel } from '@happydrive/web-ui/labels';
import { AsyncView, Button, Card, Field, KeyValue, PageHeader, StatusPill } from '@happydrive/web-ui/components';
import { validateMonth } from '@/lib/admin-forms';
import { api, unwrap } from '@/lib/api';


export default function ReconciliationPage() {
  const [month, setMonth] = useState(() => addMonths(jstMonth(), -1));
  const [draft, setDraft] = useState(month);
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery(`reconciliation:${month}`, () => unwrap(api.GET('/admin/reconciliation', { params: { query: { month } } })));

  return (
    <>
      <PageHeader title="決済照合" description="受諾スナップショット・報酬台帳・振込・決済事業者の確認額を月次で照合します。" />
      <Card>
        <form
          className="hd-row"
          style={{ alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!validateMonth(draft)) return setErr('対象月を選択してください。');
            setErr(null);
            setMonth(draft);
          }}
        >
          <Field label="対象月" error={err ?? undefined}>
            {(p) => <input {...p} className="hd-input" type="month" value={draft} onChange={(e) => setDraft(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary">
            照合する
          </Button>
        </form>
      </Card>
      <AsyncView state={q}>
        {(r) => (
          <>
            <Card title={`${formatMonth(r.month)}の照合結果`} actions={<StatusPill status={r.discrepancies.length === 0 ? { label: '差異なし', tone: 'green' } : { label: `差異 ${r.discrepancies.length}件`, tone: 'red' }} />}>
              <KeyValue
                items={[
                  ['受諾スナップショット合計', formatYen(r.acceptedSnapshotYen)],
                  ['台帳（確定）', formatYen(r.ledgerEarnedYen)],
                  ['台帳（逆仕訳）', formatYen(r.ledgerReversedYen)],
                  ['振込済み', formatYen(r.payoutsPaidYen)],
                  ['決済事業者の確認額', formatYen(r.providerConfirmedYen)],
                  ['振込失敗', `${formatNumber(r.failedPayoutCount ?? 0)}件`],
                ]}
              />
            </Card>
            <Card title="差異">
              {r.discrepancies.length === 0 ? (
                <p className="hd-muted" style={{ margin: 0 }}>
                  差異はありません。
                </p>
              ) : (
                <div className="hd-table-wrap">
                  <table className="hd-table">
                    <thead>
                      <tr>
                        <th scope="col">種類</th>
                        <th scope="col">内容</th>
                        <th scope="col">対象</th>
                        <th scope="col" className="hd-num">
                          金額
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.discrepancies.map((d, i) => (
                        <tr key={i}>
                          <td>{discrepancyLabel(d.type)}</td>
                          <td>{d.message}</td>
                          <td className="hd-mono">{d.assignmentId ?? d.payoutId ?? '—'}</td>
                          <td className="hd-num">{d.amountYen !== undefined ? formatYen(d.amountYen) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </AsyncView>
    </>
  );
}
