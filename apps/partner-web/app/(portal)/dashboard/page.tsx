'use client';
import Link from 'next/link';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatNumber, formatYen } from '@happydrive/web-ui/format';
import { categoryLabel, progressLabel } from '@happydrive/web-ui/labels';
import { AsyncView, Card, EmptyState, PageHeader, StatCard, StatusPill } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';
import { useCurrentOrg } from '@/lib/org-context';

export default function DashboardPage() {
  const { org } = useCurrentOrg();
  const q = useQuery(
    `dashboard:${org.id}`,
    () => unwrap(api.GET('/organizations/{organizationId}/dashboard', { params: { path: { organizationId: org.id } } })),
    { pollMs: 60_000 },
  );

  return (
    <>
      <PageHeader title="企業ダッシュボード" description="本日の業務と応募状況を確認できます" />
      <AsyncView state={q} loadingLabel="ダッシュボードを読み込み中…">
        {(d) => (
          <>
            <div className="hd-stats">
              <StatCard label="公開中の案件" value={`${formatNumber(d.publishedJobCount)}件`} tone="blue" />
              <StatCard label="本日の稼働" value={`${formatNumber(d.activeWorkersToday)}人`} tone="green" />
              <StatCard label="検収待ち" value={`${formatNumber(d.awaitingReviewCount)}件`} tone="orange" />
            </div>
            {d.pendingReservationCount !== undefined || d.monthToDateSpendYen !== undefined ? (
              <div className="hd-row hd-muted">
                {d.pendingReservationCount !== undefined ? (
                  <span>
                    承認待ちの予約: <Link href="/matching">{formatNumber(d.pendingReservationCount)}件</Link>
                  </span>
                ) : null}
                {d.monthToDateSpendYen !== undefined ? <span>今月の検収済み金額: {formatYen(d.monthToDateSpendYen)}</span> : null}
              </div>
            ) : null}
            <Card title="案件の進行状況" actions={<Link href="/jobs">案件管理へ</Link>}>
              {d.jobs.length === 0 ? (
                <EmptyState title="案件はまだありません">
                  <Link href="/jobs/new" className="hd-btn hd-btn--primary">
                    案件を作成する
                  </Link>
                </EmptyState>
              ) : (
                <div className="hd-table-wrap">
                  <table className="hd-table">
                    <caption className="hd-visually-hidden">案件の進行状況</caption>
                    <thead>
                      <tr>
                        <th scope="col">案件</th>
                        <th scope="col">カテゴリ</th>
                        <th scope="col">開始</th>
                        <th scope="col">応募</th>
                        <th scope="col">状況</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.jobs.map((j) => (
                        <tr key={j.id} className="hd-progress-row">
                          <td>
                            <Link className="hd-row-link" href={`/jobs/${j.id}`}>
                              {j.title}
                            </Link>
                          </td>
                          <td className="hd-muted">{categoryLabel(j.category).label}</td>
                          <td className="hd-muted">{j.startsAt ? formatDateTimeJst(j.startsAt) : '—'}</td>
                          <td className="hd-muted">応募 {formatNumber(j.applicationCount)}件</td>
                          <td>
                            <StatusPill status={progressLabel(j.progressLabel)} />
                          </td>
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
