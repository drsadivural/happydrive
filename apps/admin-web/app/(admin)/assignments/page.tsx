'use client';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { formatRangeJst, formatYen } from '@happydrive/web-ui/format';
import { ASSIGNMENT_STATE, assignmentStateLabel } from '@happydrive/web-ui/labels';
import { AsyncView, Card, EmptyState, PageHeader, StatusPill, Tabs } from '@happydrive/web-ui/components';
import { AssignmentPanel } from '@/components/AssignmentPanel';
import { api, unwrap } from '@/lib/api';

type State = components['schemas']['AssignmentState'];
type Filter = State | 'all';
const FIRST: State[] = ['disputed', 'submitted', 'working', 'checked_in', 'traveling', 'no_show'];
const FILTERS: { value: Filter; label: string }[] = [
  ...FIRST.map((s) => ({ value: s as Filter, label: ASSIGNMENT_STATE[s].label })),
  ...(Object.keys(ASSIGNMENT_STATE) as State[]).filter((s) => !FIRST.includes(s)).map((s) => ({ value: s as Filter, label: ASSIGNMENT_STATE[s].label })),
  { value: 'all', label: 'すべて' },
];

export default function AssignmentsMonitorPage() {
  const [filter, setFilter] = useState<Filter>('disputed');
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery(`admin-assignments:${filter}`, () => unwrap(api.GET('/admin/assignments', { params: { query: filter === 'all' ? {} : { state: filter } } })), {
    pollMs: 60_000,
  });

  return (
    <>
      <PageHeader title="業務監視・紛争" description="業務の状態を監視し、紛争の裁定・報酬の取消（逆仕訳）・再割当を行います。" />
      <Tabs
        label="割当の状態"
        value={filter}
        onChange={(v) => {
          setFilter(v);
          setSelected(null);
        }}
        options={FILTERS}
      />
      <div className="hd-split">
        <Card title="割当一覧">
          <AsyncView state={q} empty={<EmptyState title="該当する業務はありません" />}>
            {(items) => (
              <div className="hd-table-wrap">
                <table className="hd-table">
                  <tbody>
                    {items.map((a) => (
                      <tr key={a.id} data-selected={a.id === selected}>
                        <td>
                          <button type="button" className="hd-btn hd-btn--ghost" style={{ padding: 0, minHeight: 0, whiteSpace: 'normal', textAlign: 'left' }} onClick={() => setSelected(a.id)}>
                            {a.job?.title ?? a.id}
                          </button>
                          <div className="hd-small hd-muted">
                            {a.job?.organizationName} ・ {a.workerDisplayName ?? a.workerId}
                          </div>
                          <div className="hd-small hd-muted">
                            {formatRangeJst(a.job?.startsAt, a.job?.endsAt)} ・ {formatYen(a.acceptedAmountYen)}
                          </div>
                        </td>
                        <td>
                          <StatusPill status={assignmentStateLabel(a.state)} soft />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </Card>
        <Card title="詳細">{selected ? <AssignmentPanel key={selected} assignmentId={selected} onChanged={q.reload} /> : <p className="hd-muted">一覧から業務を選択してください。</p>}</Card>
      </div>
    </>
  );
}
