'use client';
import { useState } from 'react';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { formatMonth, formatNumber, formatPlainDate, formatYen } from '@happydrive/web-ui/format';
import { AsyncView, Button, Card, EmptyState, KeyValue, PageHeader } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';
import { invoiceCsvFilename, invoiceToCsv } from '@/lib/invoice-csv';
import { useCurrentOrg } from '@/lib/org-context';

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function BillingPage() {
  const { org } = useCurrentOrg();
  const q = useQuery(`invoices:${org.id}`, () => unwrap(api.GET('/organizations/{organizationId}/invoices', { params: { path: { organizationId: org.id } } })));
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="請求・支払" description="検収済みの業務の月次明細です（台帳から算出）。CSV はこの端末で作成してダウンロードします。" />
      <AsyncView state={q} empty={<Card><EmptyState title="請求明細はまだありません">検収を承認した業務が月次で集計されます。</EmptyState></Card>}>
        {(invoices) => (
          <div className="hd-stack">
            {[...invoices]
              .sort((a, b) => b.month.localeCompare(a.month))
              .map((inv) => (
                <Card
                  key={inv.month}
                  title={`${formatMonth(inv.month)}分`}
                  actions={
                    <>
                      <Button size="sm" onClick={() => setOpen(open === inv.month ? null : inv.month)} aria-expanded={open === inv.month}>
                        {open === inv.month ? '明細を閉じる' : `明細を表示（${formatNumber(inv.lines.length)}件）`}
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => download(invoiceCsvFilename(inv.month), invoiceToCsv(inv, org.legalName))}>
                        CSVをダウンロード
                      </Button>
                    </>
                  }
                >
                  <KeyValue
                    items={[
                      ['ドライバーへの支払', formatYen(inv.workerPaymentsYen)],
                      ['実費', formatYen(inv.expensesYen)],
                      ['手数料', formatYen(inv.platformFeeYen)],
                      ['消費税', formatYen(inv.taxYen)],
                      ['合計', <strong key="t">{formatYen(inv.totalYen)}</strong>],
                    ]}
                  />
                  {open === inv.month ? (
                    <div className="hd-table-wrap" style={{ marginTop: 16 }}>
                      <table className="hd-table">
                        <thead>
                          <tr>
                            <th scope="col">実施日</th>
                            <th scope="col">案件</th>
                            <th scope="col">ドライバー</th>
                            <th scope="col" className="hd-num">
                              報酬
                            </th>
                            <th scope="col" className="hd-num">
                              実費
                            </th>
                            <th scope="col" className="hd-num">
                              調整
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {inv.lines.map((l) => (
                            <tr key={l.assignmentId}>
                              <td>{formatPlainDate(l.workDate)}</td>
                              <td>{l.jobTitle}</td>
                              <td>{l.workerDisplayName ?? '—'}</td>
                              <td className="hd-num">{formatYen(l.amountYen)}</td>
                              <td className="hd-num">{formatYen(l.expensesYen ?? 0)}</td>
                              <td className="hd-num">{formatYen(l.adjustmentsYen ?? 0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </Card>
              ))}
          </div>
        )}
      </AsyncView>
    </>
  );
}
