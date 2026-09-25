'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatNumber, formatRangeJst, formatRelative, formatYen } from '@happydrive/web-ui/format';
import { assignmentStateLabel, jobStatusLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, ConfirmDialog, EmptyState, Field, PageHeader, StatusPill } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';
import { formatRating } from '@/lib/assignment-rules';
import { useCurrentOrg } from '@/lib/org-context';

type Assignment = components['schemas']['Assignment'];

function JobAssignments({ jobId }: { jobId: string }) {
  const { org } = useCurrentOrg();
  const job = useQuery(`job:${org.id}:${jobId}`, () =>
    unwrap(api.GET('/organizations/{organizationId}/jobs/{jobId}', { params: { path: { organizationId: org.id, jobId } } })),
  );
  const list = useQuery(
    `job-assignments:${org.id}:${jobId}`,
    () => unwrap(api.GET('/organizations/{organizationId}/jobs/{jobId}/assignments', { params: { path: { organizationId: org.id, jobId } } })),
    { pollMs: 30_000 },
  );
  const [target, setTarget] = useState<{ a: Assignment; decision: 'approve' | 'decline' } | null>(null);
  const decide = useMutation(
    'reservation',
    (args: { id: string; decision: 'approve' | 'decline'; reason: string }, key: string) =>
      unwrap(
        api.POST('/assignments/{assignmentId}/reservation', {
          params: { path: { assignmentId: args.id }, header: { 'Idempotency-Key': key } },
          body: args.reason ? { decision: args.decision, reason: args.reason } : { decision: args.decision },
        }),
      ),
    {
      onSuccess: () => {
        setTarget(null);
        list.reload();
        job.reload();
      },
    },
  );

  return (
    <div className="hd-stack">
      {job.data ? (
        <Card>
          <div className="hd-row" style={{ justifyContent: 'space-between' }}>
            <div>
              <Link href={`/jobs/${job.data.id}`} className="hd-row-link">
                <strong>{job.data.title}</strong>
              </Link>
              <div className="hd-small hd-muted">
                {formatRangeJst(job.data.startsAt, job.data.endsAt)} ・ {formatYen(job.data.amountYen)} ・{' '}
                {job.data.requiresOrgApproval ? `発注者承認あり（期限${job.data.reservationTtlMinutes ?? '—'}分）` : '先着で確定'}
              </div>
            </div>
            <div className="hd-row">
              <StatusPill status={jobStatusLabel(job.data.status)} />
              <span>
                残枠 {formatNumber(job.data.remainingCapacity)} / {formatNumber(job.data.capacity)}
              </span>
              <span>空き待ち {formatNumber(job.data.waitlistCount ?? 0)}人</span>
            </div>
          </div>
        </Card>
      ) : null}
      <Card title="応募・割当">
        <p className="hd-small hd-muted" style={{ marginTop: 0 }}>
          ドライバーの電話番号・住所は表示されません。連絡は案件ごとのメッセージで行ってください。30秒ごとに自動更新します。
        </p>
        <AsyncView state={list} empty={<EmptyState title="まだ応募はありません" />}>
          {(items) => (
            <div className="hd-table-wrap">
              <table className="hd-table">
                <thead>
                  <tr>
                    <th scope="col">ドライバー</th>
                    <th scope="col">評価</th>
                    <th scope="col">状態</th>
                    <th scope="col">受諾・予約日時</th>
                    <th scope="col">承認期限</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link className="hd-row-link" href={`/assignments/${a.id}`}>
                          {a.workerDisplayName ?? 'ドライバー'}
                        </Link>
                      </td>
                      <td>{formatRating(a.workerRatingAverage)}</td>
                      <td>
                        <StatusPill status={assignmentStateLabel(a.state)} />
                      </td>
                      <td className="hd-small">{formatDateTimeJst(a.acceptedAt)}</td>
                      <td className="hd-small">
                        {a.state === 'reserved' && a.reservationExpiresAt ? (
                          <>
                            {formatDateTimeJst(a.reservationExpiresAt)}
                            <div className="hd-muted">{formatRelative(a.reservationExpiresAt)}</div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {a.state === 'reserved' ? (
                          <div className="hd-actions">
                            <Button size="sm" variant="success" onClick={() => setTarget({ a, decision: 'approve' })}>
                              承認
                            </Button>
                            <Button size="sm" onClick={() => setTarget({ a, decision: 'decline' })}>
                              却下
                            </Button>
                          </div>
                        ) : (
                          <Link href={`/assignments/${a.id}`}>詳細</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Card>
      <ConfirmDialog
        open={!!target}
        title={target?.decision === 'approve' ? '予約を承認しますか？' : '予約を却下しますか？'}
        description={
          target?.decision === 'approve'
            ? `${target.a.workerDisplayName ?? 'ドライバー'} さんの受諾を確定します。`
            : '却下すると枠は解放され、再募集されます（ドライバーに通知されます）。'
        }
        confirmLabel={target?.decision === 'approve' ? '承認する' : '却下する'}
        tone={target?.decision === 'approve' ? 'success' : 'danger'}
        showReason={target?.decision === 'decline'}
        reasonLabel="却下理由（ドライバーに通知される場合があります）"
        pending={decide.pending}
        error={decide.error}
        onClose={() => {
          setTarget(null);
          decide.reset();
        }}
        onConfirm={(reason) => target && void decide.run({ id: target.a.id, decision: target.decision, reason })}
      />
    </div>
  );
}

export function MatchingView({ initialJobId }: { initialJobId?: string }) {
  const { org } = useCurrentOrg();
  const router = useRouter();
  const jobs = useQuery(`jobs:${org.id}:all`, () =>
    unwrap(api.GET('/organizations/{organizationId}/jobs', { params: { path: { organizationId: org.id } } })),
  );
  const [selected, setSelected] = useState<string | undefined>(initialJobId);
  const candidates = (jobs.data ?? []).filter((j) => j.status !== 'draft' && j.status !== 'rejected');
  const jobId = selected ?? candidates.find((j) => j.status === 'published')?.id ?? candidates[0]?.id;

  return (
    <>
      <PageHeader title="応募・マッチング" description="案件ごとの応募・予約の状況を確認し、発注者承認が必要な予約を承認・却下します。" />
      <AsyncView state={jobs} isEmpty={() => candidates.length === 0} empty={<EmptyState title="公開済みの案件はまだありません"><Link href="/jobs">案件管理へ</Link></EmptyState>}>
        {() => (
          <>
            <Card>
              <Field label="案件を選択">
                {(p) => (
                  <select
                    {...p}
                    className="hd-select"
                    value={jobId ?? ''}
                    onChange={(e) => {
                      setSelected(e.target.value);
                      router.replace(`/matching?job=${e.target.value}`);
                    }}
                  >
                    {candidates.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.title}（{jobStatusLabel(j.status).label}・応募{j.applicationCount ?? 0}件）
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {selected && !candidates.some((j) => j.id === selected) ? (
                <Alert tone="orange">指定された案件は一覧にありません（下書き・却下の案件には応募がありません）。</Alert>
              ) : null}
            </Card>
            {jobId ? <JobAssignments key={jobId} jobId={jobId} /> : null}
          </>
        )}
      </AsyncView>
    </>
  );
}
