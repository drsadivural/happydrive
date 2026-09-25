'use client';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatRangeJst, formatYen } from '@happydrive/web-ui/format';
import { categoryLabel, JOB_STATUS, jobStatusLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, ConfirmDialog, EmptyState, PageHeader, StatusPill, Tabs } from '@happydrive/web-ui/components';
import { JobTerms } from '@/components/JobTerms';
import { useAdmin } from '@/lib/admin-context';
import { api, unwrap } from '@/lib/api';

type OrgJob = components['schemas']['OrgJob'];
type JobStatus = components['schemas']['JobStatus'];
type Filter = JobStatus | 'all';
type Decision = 'published' | 'rejected' | 'cancelled';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'pending_review', label: '審査待ち' },
  ...(Object.keys(JOB_STATUS) as JobStatus[]).filter((s) => s !== 'pending_review').map((s) => ({ value: s as Filter, label: JOB_STATUS[s].label })),
  { value: 'all', label: 'すべて' },
];
const DECISION: Record<Decision, { title: string; label: string; tone: 'success' | 'danger'; desc: string }> = {
  published: { title: '案件を公開しますか？', label: '公開する', tone: 'success', desc: '公開前チェック・表示事項（発注者・所在地・連絡先・内容・就業場所・報酬）を確認してください。' },
  rejected: { title: '案件を却下しますか？', label: '却下する', tone: 'danger', desc: '却下理由は発注者に表示されます。修正すべき点を具体的に記入してください。' },
  cancelled: { title: '違反案件として取消しますか？', label: '取消する', tone: 'danger', desc: '受諾済みのドライバーにはキャンセル規定に従って通知・補償されます。' },
};

export default function JobsReviewPage() {
  const { canWrite } = useAdmin();
  const [filter, setFilter] = useState<Filter>('pending_review');
  const q = useQuery(`admin-jobs:${filter}`, () => unwrap(api.GET('/admin/jobs', { params: { query: filter === 'all' ? {} : { status: filter } } })));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [target, setTarget] = useState<{ job: OrgJob; decision: Decision } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const review = useMutation(
    'job-review',
    (args: { id: string; decision: Decision; reason: string }, key: string) =>
      unwrap(api.POST('/admin/jobs/{jobId}/review', { params: { path: { jobId: args.id }, header: { 'Idempotency-Key': key } }, body: { decision: args.decision, reason: args.reason } })),
    {
      onSuccess: (job) => {
        setTarget(null);
        setNotice(`「${job.title}」を${jobStatusLabel(job.status).label}にしました。`);
        q.reload();
        detail.reload();
      },
    },
  );
  const detail = useQuery(
    `admin-job:${selectedId ?? 'none'}`,
    () => unwrap(api.GET('/admin/jobs/{jobId}', { params: { path: { jobId: selectedId! } } })),
    { enabled: !!selectedId },
  );
  const selected = selectedId && detail.data?.id === selectedId ? detail.data : null;

  return (
    <>
      <PageHeader title="案件審査" description="審査待ちの案件の条件・公開前チェックを確認し、公開・却下します。公開後の違反案件は取消できます。" />
      {notice ? <Alert tone="green">{notice}</Alert> : null}
      <Tabs
        label="案件の状態"
        value={filter}
        onChange={(v) => {
          setFilter(v);
          setSelectedId(null);
        }}
        options={FILTERS}
      />
      <div className="hd-split">
        <Card title="案件一覧">
          <AsyncView state={q} empty={<EmptyState title="該当する案件はありません" />}>
            {(jobs) => (
              <div className="hd-table-wrap">
                <table className="hd-table">
                  <tbody>
                    {jobs.map((j) => (
                      <tr key={j.id} data-selected={j.id === selectedId}>
                        <td>
                          <button type="button" className="hd-btn hd-btn--ghost" style={{ padding: 0, minHeight: 0, whiteSpace: 'normal', textAlign: 'left' }} onClick={() => setSelectedId(j.id)}>
                            {j.title}
                          </button>
                          <div className="hd-small hd-muted">
                            {j.organizationName} ・ {categoryLabel(j.category).label} ・ {formatYen(j.amountYen)}
                          </div>
                          <div className="hd-small hd-muted">{formatRangeJst(j.startsAt, j.endsAt)}</div>
                        </td>
                        <td>
                          <StatusPill status={jobStatusLabel(j.status)} soft />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </Card>
        <Card
          title={selected ? selected.title : '案件の詳細'}
          actions={
            selected && canWrite ? (
              <>
                {selected.status === 'pending_review' ? (
                  <>
                    <Button size="sm" onClick={() => setTarget({ job: selected, decision: 'rejected' })}>
                      却下
                    </Button>
                    <Button size="sm" variant="success" onClick={() => setTarget({ job: selected, decision: 'published' })}>
                      公開
                    </Button>
                  </>
                ) : null}
                {['published', 'filled', 'pending_review'].includes(selected.status) ? (
                  <Button size="sm" variant="danger" onClick={() => setTarget({ job: selected, decision: 'cancelled' })}>
                    違反として取消
                  </Button>
                ) : null}
              </>
            ) : null
          }
        >
          {selectedId ? (
            <AsyncView state={detail}>{(job) => <JobTerms job={job} />}</AsyncView>
          ) : (
            <p className="hd-muted">一覧から案件を選択してください。</p>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={!!target}
        title={target ? DECISION[target.decision].title : ''}
        description={target ? <>{`「${target.job.title}」（${target.job.organizationName}）`}<br />{DECISION[target.decision].desc}</> : null}
        confirmLabel={target ? DECISION[target.decision].label : ''}
        tone={target ? DECISION[target.decision].tone : 'primary'}
        requireReason
        pending={review.pending}
        error={review.error}
        onClose={() => {
          setTarget(null);
          review.reset();
        }}
        onConfirm={(reason) => target && void review.run({ id: target.job.id, decision: target.decision, reason })}
      />
    </>
  );
}
