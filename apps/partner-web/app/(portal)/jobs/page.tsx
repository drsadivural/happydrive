'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { formatNumber, formatRangeJst, formatYen } from '@happydrive/web-ui/format';
import { categoryLabel, contractTypeLabel, JOB_STATUS, jobStatusLabel } from '@happydrive/web-ui/labels';
import { AsyncView, Card, EmptyState, PageHeader, StatusPill, Tabs } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';
import { useCurrentOrg } from '@/lib/org-context';

type JobStatus = components['schemas']['JobStatus'];
type Filter = JobStatus | 'all';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  ...(Object.keys(JOB_STATUS) as JobStatus[]).map((s) => ({ value: s as Filter, label: JOB_STATUS[s].label })),
];

export default function JobsPage() {
  const { org } = useCurrentOrg();
  const [filter, setFilter] = useState<Filter>('all');
  const q = useQuery(`jobs:${org.id}:${filter}`, () =>
    unwrap(
      api.GET('/organizations/{organizationId}/jobs', {
        params: { path: { organizationId: org.id }, query: filter === 'all' ? {} : { status: filter } },
      }),
    ),
  );

  return (
    <>
      <PageHeader
        title="案件管理"
        description="案件の下書き作成・公開前チェック・審査申請・取消を行います。"
        actions={
          <Link href="/jobs/new" className="hd-btn hd-btn--primary">
            案件を作成
          </Link>
        }
      />
      <Card>
        <div className="hd-stack">
          <Tabs label="案件の状態" value={filter} onChange={setFilter} options={FILTERS} />
          <AsyncView
            state={q}
            empty={
              <EmptyState title={filter === 'all' ? '案件はまだありません' : `「${jobStatusLabel(filter).label}」の案件はありません`}>
                {filter === 'all' ? (
                  <Link href="/jobs/new" className="hd-btn hd-btn--primary">
                    最初の案件を作成
                  </Link>
                ) : null}
              </EmptyState>
            }
          >
            {(jobs) => (
              <div className="hd-table-wrap">
                <table className="hd-table">
                  <thead>
                    <tr>
                      <th scope="col">案件</th>
                      <th scope="col">カテゴリ / 契約</th>
                      <th scope="col">日時</th>
                      <th scope="col" className="hd-num">
                        報酬
                      </th>
                      <th scope="col" className="hd-num">
                        残枠 / 定員
                      </th>
                      <th scope="col" className="hd-num">
                        応募
                      </th>
                      <th scope="col">状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => (
                      <tr key={j.id}>
                        <td>
                          <Link className="hd-row-link" href={`/jobs/${j.id}`}>
                            {j.title}
                          </Link>
                          <div className="hd-small hd-muted">{j.areaLabel}</div>
                        </td>
                        <td>
                          <div>{categoryLabel(j.category).label}</div>
                          <div className="hd-small hd-muted">{contractTypeLabel(j.contractType).label}</div>
                        </td>
                        <td className="hd-small">{formatRangeJst(j.startsAt, j.endsAt)}</td>
                        <td className="hd-num">{formatYen(j.amountYen)}</td>
                        <td className="hd-num">
                          {formatNumber(j.remainingCapacity)} / {formatNumber(j.capacity)}
                        </td>
                        <td className="hd-num">{formatNumber(j.applicationCount ?? 0)}</td>
                        <td>
                          <StatusPill status={jobStatusLabel(j.status)} />
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
