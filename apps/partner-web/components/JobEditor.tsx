'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { jobStatusLabel } from '@happydrive/web-ui/labels';
import { Alert, ErrorState, LoadingState, PageHeader } from '@happydrive/web-ui/components';
import { JobForm } from './JobForm';
import { api, unwrap } from '@/lib/api';
import { emptyJobForm, jobToForm, type NewJob } from '@/lib/job-form';
import { useCurrentOrg } from '@/lib/org-context';

/**
 * 案件の作成・編集・複製。
 * - create: 空フォーム（fromJobId 指定時は既存案件を複製してフォームに入れ、新規作成する）
 * - edit: draft / rejected のみ
 */
export function JobEditor({ mode, jobId, fromJobId }: { mode: 'create' | 'edit'; jobId?: string; fromJobId?: string }) {
  const { org, isApproved } = useCurrentOrg();
  const router = useRouter();
  const sourceId = mode === 'edit' ? jobId : fromJobId;

  const sites = useQuery(`sites:${org.id}`, () => unwrap(api.GET('/organizations/{organizationId}/sites', { params: { path: { organizationId: org.id } } })));
  const skills = useQuery('skills', () => unwrap(api.GET('/skills/catalog')));
  const source = useQuery(
    `job:${org.id}:${sourceId ?? 'none'}`,
    () => unwrap(api.GET('/organizations/{organizationId}/jobs/{jobId}', { params: { path: { organizationId: org.id, jobId: sourceId! } } })),
    { enabled: !!sourceId },
  );

  const save = useMutation(
    mode === 'edit' ? 'job-update' : 'job-create',
    (body: NewJob, key: string) =>
      mode === 'edit'
        ? unwrap(api.PUT('/organizations/{organizationId}/jobs/{jobId}', { params: { path: { organizationId: org.id, jobId: jobId! } }, body }))
        : unwrap(api.POST('/organizations/{organizationId}/jobs', { params: { path: { organizationId: org.id }, header: { 'Idempotency-Key': key } }, body })),
    { onSuccess: (job) => router.push(`/jobs/${job.id}`) },
  );

  const title = mode === 'edit' ? '案件の編集' : fromJobId ? '案件の複製' : '案件の作成';
  const firstError = sites.error ?? skills.error ?? source.error;
  if (firstError && (!sites.data || !skills.data || (sourceId && !source.data))) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorState
          error={firstError}
          onRetry={() => {
            sites.reload();
            skills.reload();
            source.reload();
          }}
        />
      </>
    );
  }
  if (!sites.data || !skills.data || (sourceId && !source.data)) {
    return (
      <>
        <PageHeader title={title} />
        <LoadingState />
      </>
    );
  }

  const job = source.data;
  if (mode === 'edit' && job && job.status !== 'draft' && job.status !== 'rejected') {
    return (
      <>
        <PageHeader title={title} />
        <Alert tone="orange" title={`この案件は「${jobStatusLabel(job.status).label}」のため編集できません`}>
          公開後の条件変更はできません。必要な場合は案件を取消し、<Link href={`/jobs/new?from=${job.id}`}>複製して新しい案件</Link>を作成してください。
        </Alert>
      </>
    );
  }

  const initial = job ? jobToForm(job) : emptyJobForm();
  return (
    <>
      <PageHeader
        title={title}
        description={
          fromJobId && job
            ? `「${job.title}」の内容をコピーしました。日時・募集人数などを確認して新しい下書きとして保存してください。`
            : '入力内容は下書きとして保存されます。公開前チェックを通過後、審査を申請してください。'
        }
      />
      {mode === 'edit' && job?.status === 'rejected' && job.reviewNote ? (
        <Alert tone="red" title="運営の審査で却下されました">
          理由: {job.reviewNote}
        </Alert>
      ) : null}
      <JobForm
        initial={initial}
        sites={sites.data}
        skills={skills.data}
        orgApproved={isApproved}
        submitLabel={mode === 'edit' ? '変更を保存' : '下書きとして保存'}
        pending={save.pending}
        error={save.error}
        onSubmit={(v) => void save.run(v)}
        onCancel={() => router.push(job && mode === 'edit' ? `/jobs/${job.id}` : '/jobs')}
      />
    </>
  );
}
