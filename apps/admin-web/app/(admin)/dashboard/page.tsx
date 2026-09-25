'use client';
import { useState } from 'react';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { formatNumber, formatPlainDate, formatYen } from '@happydrive/web-ui/format';
import { categoryLabel } from '@happydrive/web-ui/labels';
import { AsyncView, Card, PageHeader, StatCard } from '@happydrive/web-ui/components';
import { DateRangePicker, defaultRange, type Range } from '@/components/DateRange';
import { api, unwrap } from '@/lib/api';

export default function DashboardPage() {
  const [range, setRange] = useState<Range>(() => defaultRange(30));
  const q = useQuery(`analytics:${range.from}:${range.to}`, () => unwrap(api.GET('/admin/analytics', { params: { query: range } })));

  return (
    <>
      <PageHeader title="運営ダッシュボード" description="期間内の登録・案件・業務・決済の集計です（日付は日本時間）。" />
      <Card>
        <DateRangePicker value={range} onChange={setRange} />
      </Card>
      <AsyncView state={q}>
        {(a) => (
          <>
            <p className="hd-muted" style={{ margin: 0 }}>
              集計期間: {formatPlainDate(a.from)} 〜 {formatPlainDate(a.to)}
            </p>
            <div className="hd-stats">
              <StatCard label="新規ドライバー" value={`${formatNumber(a.newWorkers)}人`} tone="blue" />
              <StatCard label="本人確認済み" value={`${formatNumber(a.verifiedWorkers)}人`} tone="green" />
              <StatCard label="公開案件" value={`${formatNumber(a.publishedJobs)}件`} tone="blue" />
              <StatCard label="受諾" value={`${formatNumber(a.acceptedAssignments)}件`} tone="green" />
              <StatCard label="検収承認" value={`${formatNumber(a.approvedAssignments)}件`} tone="green" />
              <StatCard label="取消" value={`${formatNumber(a.cancelledAssignments)}件`} tone="orange" />
              <StatCard label="無断欠勤" value={`${formatNumber(a.noShows)}件`} tone="red" />
              <StatCard label="紛争" value={`${formatNumber(a.disputes)}件`} tone="red" />
              <StatCard label="取扱高" value={formatYen(a.grossYen)} tone="navy" />
              <StatCard label="配送完了" value={`${formatNumber(a.deliveriesCompleted)}件`} tone="blue" />
              <StatCard label="配送失敗" value={`${formatNumber(a.deliveriesFailed)}件`} tone="orange" />
              <StatCard label="受諾競合（同時要求）" value={`${formatNumber(a.acceptConflicts)}件`} tone="gray" />
            </div>
            <Card title="カテゴリ別">
              {a.byCategory && a.byCategory.length > 0 ? (
                <div className="hd-table-wrap">
                  <table className="hd-table">
                    <thead>
                      <tr>
                        <th scope="col">カテゴリ</th>
                        <th scope="col" className="hd-num">
                          案件
                        </th>
                        <th scope="col" className="hd-num">
                          業務
                        </th>
                        <th scope="col" className="hd-num">
                          取扱高
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.byCategory.map((c, i) => (
                        <tr key={c.category ?? i}>
                          <td>{categoryLabel(c.category).label}</td>
                          <td className="hd-num">{formatNumber(c.jobs)}</td>
                          <td className="hd-num">{formatNumber(c.assignments)}</td>
                          <td className="hd-num">{formatYen(c.grossYen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="hd-muted">データがありません。</p>
              )}
            </Card>
          </>
        )}
      </AsyncView>
    </>
  );
}
