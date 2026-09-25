'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatRangeJst, formatYen } from '@happydrive/web-ui/format';
import { assignmentStateLabel } from '@happydrive/web-ui/labels';
import { AsyncView, Card, EmptyState, PageHeader, StatusPill, Tabs } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';
import { formatRating } from '@/lib/assignment-rules';
import { useCurrentOrg } from '@/lib/org-context';

type State = components['schemas']['AssignmentState'];
type Filter = State | 'all';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'submitted', label: '検収待ち' },
  { value: 'working', label: '実施中' },
  { value: 'checked_in', label: 'チェックイン済み' },
  { value: 'traveling', label: '移動中' },
  { value: 'accepted', label: '受諾済み' },
  { value: 'reserved', label: '承認待ち' },
  { value: 'needs_revision', label: '差戻し中' },
  { value: 'disputed', label: '紛争中' },
  { value: 'approved', label: '検収済み' },
  { value: 'payable', label: '支払確定' },
  { value: 'paid', label: '支払済み' },
  { value: 'no_show', label: '無断欠勤' },
  { value: 'cancelled', label: '取消' },
  { value: 'all', label: 'すべて' },
];

export default function AssignmentsPage() {
  const { org } = useCurrentOrg();
  const [filter, setFilter] = useState<Filter>('submitted');
  const q = useQuery(
    `org-assignments:${org.id}:${filter}`,
    () =>
      unwrap(
        api.GET('/organizations/{organizationId}/assignments', {
          params: { path: { organizationId: org.id }, query: filter === 'all' ? {} : { state: filter } },
        }),
      ),
    { pollMs: 60_000 },
  );
  const label = FILTERS.find((f) => f.value === filter)?.label ?? '';

  return (
    <>
      <PageHeader title="実施・検収" description="業務の進行を確認し、完了報告を検収（承認・差戻し・紛争）します。" />
      <Card>
        <div className="hd-stack">
          <Tabs label="割当の状態" value={filter} onChange={setFilter} options={FILTERS} />
          <AsyncView state={q} empty={<EmptyState title={`「${label}」の業務はありません`} />}>
            {(items) => (
              <div className="hd-table-wrap">
                <table className="hd-table">
                  <thead>
                    <tr>
                      <th scope="col">案件</th>
                      <th scope="col">ドライバー</th>
                      <th scope="col">日時</th>
                      <th scope="col" className="hd-num">
                        報酬
                      </th>
                      <th scope="col">完了報告</th>
                      <th scope="col">状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Link className="hd-row-link" href={`/assignments/${a.id}`}>
                            {a.job?.title ?? '案件'}
                          </Link>
                        </td>
                        <td>
                          {a.workerDisplayName ?? 'ドライバー'}
                          <div className="hd-small hd-muted">{formatRating(a.workerRatingAverage)}</div>
                        </td>
                        <td className="hd-small">{formatRangeJst(a.job?.startsAt, a.job?.endsAt)}</td>
                        <td className="hd-num">{formatYen(a.acceptedAmountYen)}</td>
                        <td className="hd-small">{formatDateTimeJst(a.submittedAt)}</td>
                        <td>
                          <StatusPill status={assignmentStateLabel(a.state)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </div>
      </Card>
    </>
  );
}
