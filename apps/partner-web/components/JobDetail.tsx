'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatNumber, formatRangeJst, formatYen } from '@happydrive/web-ui/format';
import { categoryLabel, contractTypeLabel, jobStatusLabel, RESTRICTED_CATEGORIES } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, ConfirmDialog, KeyValue, PageHeader, StatusPill } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';
import type { OrgJob } from '@/lib/job-form';
import { useCurrentOrg } from '@/lib/org-context';

const EDITABLE = ['draft', 'rejected'];
const CANCELLABLE = ['draft', 'pending_review', 'published', 'filled', 'rejected'];

function submitBlockers(job: OrgJob, orgApproved: boolean): string[] {
  const b: string[] = [];
  if (!orgApproved) b.push('組織が運営の審査で承認されていません。');
  if (job.contractType === 'other_legal_review') b.push('契約区分「その他（法務審査中）」は公開できません。');
  if ((RESTRICTED_CATEGORIES as readonly string[]).includes(job.category)) b.push('身体介護・医療関連は資格要件・事業審査が確定するまで公開できません。');
  return b;
}

export function JobDetail({ jobId }: { jobId: string }) {
  const { org, isApproved } = useCurrentOrg();
  const q = useQuery(`job:${org.id}:${jobId}`, () =>
    unwrap(api.GET('/organizations/{organizationId}/jobs/{jobId}', { params: { path: { organizationId: org.id, jobId } } })),
  );
  const [confirm, setConfirm] = useState<'submit' | 'cancel' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = useMutation(
    'job-submit',
    (_: null, key: string) =>
      unwrap(
        api.POST('/organizations/{organizationId}/jobs/{jobId}/submit', {
          params: { path: { organizationId: org.id, jobId }, header: { 'Idempotency-Key': key } },
        }),
      ),
    {
      onSuccess: (job) => {
        q.setData(job);
        setConfirm(null);
        setNotice(job.status === 'published' ? '公開前チェックを通過し、公開されました。' : '審査を申請しました。運営の確認後に公開されます。');
      },
    },
  );
  const cancel = useMutation(
    'job-cancel',
    (reason: string, key: string) =>
      unwrap(
        api.POST('/organizations/{organizationId}/jobs/{jobId}/cancel', {
          params: { path: { organizationId: org.id, jobId }, header: { 'Idempotency-Key': key } },
          body: { reason },
        }),
      ),
    {
      onSuccess: (job) => {
        q.setData(job);
        setConfirm(null);
        setNotice('案件を取消しました。受諾済みのドライバーにはキャンセル規定に従って通知・補償されます。');
      },
    },
  );

  return (
    <AsyncView state={q}>
      {(job) => {
        const blockers = submitBlockers(job, isApproved);
        const canEdit = EDITABLE.includes(job.status);
        const failedChecks = (job.publishChecks ?? []).filter((c) => !c.ok);
        return (
          <>
            <PageHeader
              title={job.title}
              description={
                <span className="hd-row">
                  <StatusPill status={jobStatusLabel(job.status)} />
                  <span>
                    {categoryLabel(job.category).label} ・ {contractTypeLabel(job.contractType).label} ・ {job.areaLabel}
                  </span>
                </span>
              }
              actions={
                <>
                  {canEdit ? (
                    <Link href={`/jobs/${job.id}/edit`} className="hd-btn">
                      編集
                    </Link>
                  ) : null}
                  <Link href={`/jobs/new?from=${job.id}`} className="hd-btn">
                    複製して新規作成
                  </Link>
                  {job.status !== 'draft' ? (
                    <Link href={`/matching?job=${job.id}`} className="hd-btn">
                      応募を見る
                    </Link>
                  ) : null}
                  {CANCELLABLE.includes(job.status) ? (
                    <Button variant="danger" onClick={() => setConfirm('cancel')}>
                      取消
                    </Button>
                  ) : null}
                  {canEdit ? (
                    <Button variant="primary" onClick={() => setConfirm('submit')} disabled={blockers.length > 0}>
                      審査を申請
                    </Button>
                  ) : null}
                </>
              }
            />
            {notice ? <Alert tone="green">{notice}</Alert> : null}
            {canEdit && blockers.length > 0 ? (
              <Alert tone="orange" title="現在この案件は審査申請できません">
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {job.status === 'rejected' && job.reviewNote ? (
              <Alert tone="red" title="運営の審査で却下されました">
                理由: {job.reviewNote}（修正して再申請できます）
              </Alert>
            ) : null}

            <Card title="公開前チェック">
              {job.publishChecks && job.publishChecks.length > 0 ? (
                <ul className="hd-stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
                  {job.publishChecks.map((c) => (
                    <li key={c.code} className="hd-row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                      <StatusPill status={c.ok ? { label: 'OK', tone: 'green' } : { label: '要対応', tone: 'red' }} soft />
                      <span>{c.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hd-muted" style={{ margin: 0 }}>
                  公開前チェックの結果はありません。
                </p>
              )}
              {failedChecks.length > 0 && canEdit ? (
                <p className="hd-small hd-muted">「要対応」の項目を修正してから審査を申請してください。</p>
              ) : null}
            </Card>

            <div className="hd-stats">
              <Card>
                <div className="hd-stat-label">応募・割当</div>
                <div className="hd-stat-value hd-tone-blue">{formatNumber(job.applicationCount ?? 0)}件</div>
              </Card>
              <Card>
                <div className="hd-stat-label">実施中</div>
                <div className="hd-stat-value hd-tone-green">{formatNumber(job.activeCount ?? 0)}件</div>
              </Card>
              <Card>
                <div className="hd-stat-label">検収待ち</div>
                <div className="hd-stat-value hd-tone-orange">{formatNumber(job.awaitingReviewCount ?? 0)}件</div>
              </Card>
              <Card>
                <div className="hd-stat-label">空き待ち</div>
                <div className="hd-stat-value hd-tone-gray">{formatNumber(job.waitlistCount ?? 0)}人</div>
              </Card>
            </div>

            <div className="hd-split">
              <Card title="募集条件">
                <KeyValue
                  items={[
                    ['日時', formatRangeJst(job.startsAt, job.endsAt)],
                    ['報酬（1人）', formatYen(job.amountYen)],
                    ['実費負担', job.expensesReimbursedYen !== undefined ? formatYen(job.expensesReimbursedYen) : '—'],
                    ['ドライバー負担の費用', job.workerBorneCostsNote],
                    ['募集人数', `${formatNumber(job.capacity)}人（残り${formatNumber(job.remainingCapacity)}人）`],
                    ['発注者承認', job.requiresOrgApproval ? `必要（承認期限 ${job.reservationTtlMinutes ?? '—'}分）` : '不要（先着で確定）'],
                    ['必要な資格', job.requiredSkillNames?.length ? job.requiredSkillNames.join('、') : job.requiredSkills.length ? job.requiredSkills.join('、') : 'なし'],
                    ['支払条件', job.paymentTermsText],
                    ...(job.contractType === 'employment' ? ([['労働条件', <p key="e" className="hd-pre">{job.employmentTermsText}</p>]] as [string, React.ReactNode][]) : []),
                    ['作成日時', formatDateTimeJst(job.createdAt)],
                    ['公開日時', job.publishedAt ? formatDateTimeJst(job.publishedAt) : '—'],
                  ]}
                />
              </Card>
              <Card title="場所・安全">
                <KeyValue
                  items={[
                    ['住所', job.address],
                    ['公開用の地域名', job.areaLabel],
                    ['緯度・経度', <span key="l" className="hd-mono">{`${job.location.latitude}, ${job.location.longitude}`}</span>],
                    ['チェックイン範囲', job.checkInRadiusMeters ? `${job.checkInRadiusMeters}m` : '—'],
                    ['集合場所', job.meetingPointNote],
                    ['安全上の注意', job.safetyNotes],
                    ['連絡担当者', job.contactName],
                  ]}
                />
              </Card>
            </div>

            <Card title="業務内容">
              <p className="hd-pre">{job.description}</p>
            </Card>

            <div className="hd-split">
              <Card title="作業手順">
                <ol style={{ margin: 0, paddingLeft: 20 }} className="hd-stack">
                  {job.steps.map((s, i) => (
                    <li key={i}>
                      <strong>{s.title}</strong>
                      {s.requiresPhoto ? <span className="hd-small hd-muted">（写真必須）</span> : null}
                      {s.description ? <p className="hd-pre hd-muted" style={{ margin: '4px 0 0' }}>{s.description}</p> : null}
                    </li>
                  ))}
                </ol>
                <p className="hd-small hd-muted">完了報告に必要な写真: {job.minPhotoCount ?? 0}枚</p>
              </Card>
              <Card title="キャンセル規定">
                <KeyValue
                  items={[
                    ['無償取消の期限', `開始${job.cancellationPolicy.freeCancelHoursBefore}時間前まで`],
                    ['期限後の発注者取消の補償', `${job.cancellationPolicy.lateCancelCompensationPercent}%`],
                  ]}
                />
                <p className="hd-pre">{job.cancellationPolicy.text}</p>
              </Card>
            </div>

            <ConfirmDialog
              open={confirm === 'submit'}
              title="審査を申請しますか？"
              description={
                <>
                  公開前チェック（企業審査・必須表示事項・カテゴリ・契約区分）を実行し、通過すると運営の審査待ちになります。申請後は内容を編集できません。
                  {failedChecks.length > 0 ? (
                    <p className="hd-error-text">公開前チェックに「要対応」の項目が{failedChecks.length}件あります。修正しないと申請できない場合があります。</p>
                  ) : null}
                </>
              }
              confirmLabel="申請する"
              pending={submit.pending}
              error={submit.error}
              onClose={() => {
                setConfirm(null);
                submit.reset();
                if (submit.error) q.reload();
              }}
              onConfirm={() => void submit.run(null)}
            />
            <ConfirmDialog
              open={confirm === 'cancel'}
              title="案件を取消しますか？"
              description="受諾済みのドライバーがいる場合、キャンセル規定に従って補償が発生し、全員に通知されます。この操作は元に戻せません。"
              confirmLabel="取消する"
              tone="danger"
              requireReason
              reasonLabel="取消理由"
              pending={cancel.pending}
              error={cancel.error}
              onClose={() => {
                setConfirm(null);
                cancel.reset();
              }}
              onConfirm={(reason) => void cancel.run(reason)}
            />
          </>
        );
      }}
    </AsyncView>
  );
}
