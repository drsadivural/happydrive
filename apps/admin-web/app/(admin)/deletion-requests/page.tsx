'use client';
import Link from 'next/link';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst } from '@happydrive/web-ui/format';
import { deletionStatusLabel } from '@happydrive/web-ui/labels';
import { AsyncView, Card, EmptyState, PageHeader, StatusPill } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';

export default function DeletionRequestsPage() {
  const q = useQuery('deletion-requests', () => unwrap(api.GET('/admin/deletion-requests')));
  return (
    <>
      <PageHeader title="削除要求" description="利用者からのアカウント削除要求と、法令等による保持例外・削除を妨げる要因を確認します。" />
      <Card>
        <AsyncView state={q} empty={<EmptyState title="削除要求はありません" />}>
          {(items) => (
            <div className="hd-table-wrap">
              <table className="hd-table">
                <thead>
                  <tr>
                    <th scope="col">要求日時</th>
                    <th scope="col">利用者</th>
                    <th scope="col">状態</th>
                    <th scope="col">完了日時</th>
                    <th scope="col">保持の説明・妨げる要因</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((d, i) => (
                    <tr key={d.id ?? i}>
                      <td className="hd-small">{formatDateTimeJst(d.requestedAt)}</td>
                      <td className="hd-mono">{d.userId ? <Link href={`/users/${d.userId}`}>{d.userId}</Link> : '—'}</td>
                      <td>
                        <StatusPill status={deletionStatusLabel(d.status)} soft />
                      </td>
                      <td className="hd-small">{formatDateTimeJst(d.completedAt)}</td>
                      <td className="hd-small" style={{ maxWidth: 420 }}>
                        <p className="hd-pre" style={{ margin: 0 }}>{d.retentionNotice}</p>
                        {d.blockers?.length ? (
                          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }} className="hd-error-text">
                            {d.blockers.map((b) => (
                              <li key={b}>{b}</li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Card>
    </>
  );
}
