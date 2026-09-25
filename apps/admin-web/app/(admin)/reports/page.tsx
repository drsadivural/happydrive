'use client';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst } from '@happydrive/web-ui/format';
import { reportReasonLabel, reportStatusLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, ConfirmDialog, EmptyState, Field, PageHeader, StatusPill, Tabs } from '@happydrive/web-ui/components';
import { useAdmin } from '@/lib/admin-context';
import { api, unwrap } from '@/lib/api';

type Report = components['schemas']['Report'];
type Action = 'no_action' | 'hide_content' | 'suspend_target' | 'cancel_job';
const ACTIONS: { value: Action; label: string; desc: string }[] = [
  { value: 'no_action', label: '対応不要', desc: '違反なしとして記録' },
  { value: 'hide_content', label: '非表示にする', desc: 'メッセージ等を非表示' },
  { value: 'suspend_target', label: '対象を停止', desc: '利用者・組織を停止' },
  { value: 'cancel_job', label: '案件を取消', desc: '違反案件を取消' },
];
const TARGET: Record<string, string> = { message: 'メッセージ', job: '案件', user: '利用者', organization: '組織' };

export default function ReportsPage() {
  const { canWrite } = useAdmin();
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const q = useQuery(`admin-reports:${filter}`, () => unwrap(api.GET('/admin/reports', { params: { query: { status: filter } } })));
  const [target, setTarget] = useState<Report | null>(null);
  const [action, setAction] = useState<Action>('no_action');
  const [notice, setNotice] = useState<string | null>(null);
  const resolve = useMutation(
    'report-resolve',
    (args: { id: string; action: Action; reason: string }, key: string) =>
      unwrap(api.POST('/admin/reports/{reportId}/resolve', { params: { path: { reportId: args.id }, header: { 'Idempotency-Key': key } }, body: { action: args.action, reason: args.reason } })),
    {
      onSuccess: () => {
        setTarget(null);
        setNotice('通報を対応済みにしました。');
        q.reload();
      },
    },
  );

  return (
    <>
      <PageHeader title="通報" description="メッセージ・案件・利用者・組織への通報を確認して対応します。" />
      {notice ? <Alert tone="green">{notice}</Alert> : null}
      <Card>
        <div className="hd-stack">
          <Tabs
            label="対応状況"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'open', label: '未対応' },
              { value: 'resolved', label: '対応済み' },
            ]}
          />
          <AsyncView state={q} empty={<EmptyState title={filter === 'open' ? '未対応の通報はありません' : '対応済みの通報はありません'} />}>
            {(reports) => (
              <div className="hd-table-wrap">
                <table className="hd-table">
                  <thead>
                    <tr>
                      <th scope="col">受付日時</th>
                      <th scope="col">対象</th>
                      <th scope="col">理由</th>
                      <th scope="col">詳細</th>
                      <th scope="col">状態</th>
                      {canWrite && filter === 'open' ? <th scope="col">操作</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((r) => (
                      <tr key={r.id}>
                        <td className="hd-small">{formatDateTimeJst(r.createdAt)}</td>
                        <td>
                          {TARGET[r.targetType] ?? r.targetType}
                          <div className="hd-mono hd-muted">{r.targetId}</div>
                        </td>
                        <td>{reportReasonLabel(r.reason)}</td>
                        <td className="hd-pre" style={{ maxWidth: 360 }}>
                          {r.detail ?? '—'}
                          {r.resolution ? <div className="hd-small hd-muted">対応: {r.resolution}</div> : null}
                        </td>
                        <td>
                          <StatusPill status={reportStatusLabel(r.status)} soft />
                        </td>
                        {canWrite && filter === 'open' ? (
                          <td>
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => {
                                setAction('no_action');
                                setTarget(r);
                              }}
                            >
                              対応する
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </div>
      </Card>
      <ConfirmDialog
        open={!!target}
        title="通報に対応しますか？"
        description={target ? `${TARGET[target.targetType] ?? target.targetType}への通報（${reportReasonLabel(target.reason)}）` : null}
        confirmLabel="対応を記録する"
        tone={action === 'no_action' ? 'primary' : 'danger'}
        requireReason
        reasonLabel="対応理由"
        pending={resolve.pending}
        error={resolve.error}
        onClose={() => {
          setTarget(null);
          resolve.reset();
        }}
        onConfirm={(reason) => target && void resolve.run({ id: target.id, action, reason })}
      >
        <Field label="対応内容" required>
          {(p) => (
            <select {...p} className="hd-select" value={action} onChange={(e) => setAction(e.target.value as Action)}>
              {ACTIONS.filter((a) => a.value !== 'cancel_job' || target?.targetType === 'job').map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}（{a.desc}）
                </option>
              ))}
            </select>
          )}
        </Field>
      </ConfirmDialog>
    </>
  );
}
