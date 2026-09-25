'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ApiError } from '@happydrive/web-ui/errors';
import { useMutation, useNow, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatRangeJst, formatYen } from '@happydrive/web-ui/format';
import { actorRoleLabel, assignmentStateLabel, earningStateLabel, categoryLabel, isActiveAssignment, timelineEventLabel } from '@happydrive/web-ui/labels';
import {
  Alert,
  AsyncView,
  Button,
  Card,
  ConfirmDialog,
  ErrorAlert,
  EvidenceGallery,
  Field,
  KeyValue,
  PageHeader,
  StatusPill,
} from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';
import { canRate, canReportNoShow, canReview, formatRating, noShowAvailableAt } from '@/lib/assignment-rules';
import { mapPointUrl } from '@/lib/geo';

type ReviewDecision = 'approved' | 'needs_revision' | 'disputed';

async function evidenceUrl(id: string): Promise<string> {
  const r = await unwrap(api.GET('/evidence/{evidenceId}/url', { params: { path: { evidenceId: id } } }));
  return r.url;
}

/** 業務中のみ最新1点を30秒ごとに取得。業務終了・共有停止（404）で表示を止める。軌跡は取得しない。 */
function LiveLocation({ assignmentId }: { assignmentId: string }) {
  const q = useQuery(
    `live:${assignmentId}`,
    () => unwrap(api.GET('/assignments/{assignmentId}/live-location', { params: { path: { assignmentId } } })),
    { pollMs: 30_000 },
  );
  const notShared = q.error instanceof ApiError && q.error.status === 404;
  return (
    <Card title="現在地（業務中のみ）">
      <p className="hd-small hd-muted" style={{ marginTop: 0 }}>
        ドライバーが業務中の間だけ、最新の1点を表示します（移動の軌跡は表示・保存されません）。30秒ごとに更新し、業務終了後は表示されません。
      </p>
      {notShared ? (
        <p style={{ margin: 0 }}>現在、位置は共有されていません。</p>
      ) : q.error && !q.data ? (
        <ErrorAlert error={q.error} title="位置を取得できませんでした" />
      ) : q.data ? (
        <KeyValue
          items={[
            ['記録時刻', formatDateTimeJst(q.data.recordedAt)],
            [
              '位置',
              <span key="p">
                <span className="hd-mono">
                  {q.data.location.latitude.toFixed(5)}, {q.data.location.longitude.toFixed(5)}
                </span>{' '}
                <a href={mapPointUrl(q.data.location)} target="_blank" rel="noopener noreferrer">
                  地図で開く（外部サイト）
                </a>
              </span>,
            ],
          ]}
        />
      ) : (
        <p className="hd-muted">取得中…</p>
      )}
    </Card>
  );
}

function RatingForm({ assignmentId, onDone }: { assignmentId: string; onDone: () => void }) {
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const rate = useMutation(
    'rating',
    (body: { score: number; comment?: string }) => unwrap(api.POST('/assignments/{assignmentId}/rating', { params: { path: { assignmentId } }, body })),
    { onSuccess: onDone },
  );
  return (
    <Card title="ドライバーの評価">
      <form
        className="hd-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (score < 1 || score > 5) {
            setErr('1〜5の評価を選択してください。');
            return;
          }
          if (comment.length > 500) {
            setErr('コメントは500文字以内で入力してください。');
            return;
          }
          setErr(null);
          void rate.run(comment.trim() ? { score, comment: comment.trim() } : { score });
        }}
      >
        <div role="radiogroup" aria-label="評価" className="hd-row">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="hd-check">
              <input type="radio" name="score" value={n} checked={score === n} onChange={() => setScore(n)} />
              <span>{'★'.repeat(n)}</span>
            </label>
          ))}
        </div>
        <Field label="コメント（任意）" hint="500文字以内。評価は1回のみ送信できます。">
          {(p) => <textarea {...p} className="hd-textarea" rows={3} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />}
        </Field>
        {err ? <span className="hd-error-text">{err}</span> : null}
        <ErrorAlert error={rate.error} title="送信できませんでした" />
        <div>
          <Button type="submit" variant="primary" loading={rate.pending}>
            評価を送信
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function AssignmentDetail({ assignmentId }: { assignmentId: string }) {
  const now = useNow(30_000);
  const q = useQuery(`assignment:${assignmentId}`, () => unwrap(api.GET('/assignments/{assignmentId}', { params: { path: { assignmentId } } })), {
    pollMs: 30_000,
  });
  const [review, setReview] = useState<ReviewDecision | null>(null);
  const [noShow, setNoShow] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const doReview = useMutation(
    'review',
    (args: { decision: ReviewDecision; reason: string }, key: string) =>
      unwrap(
        api.POST('/assignments/{assignmentId}/review', {
          params: { path: { assignmentId }, header: { 'Idempotency-Key': key } },
          body: args.reason ? { decision: args.decision, reason: args.reason } : { decision: args.decision },
        }),
      ),
    {
      onSuccess: (a, args) => {
        q.setData(a);
        setReview(null);
        setNotice(
          args.decision === 'approved'
            ? '検収を承認しました。報酬が確定します。'
            : args.decision === 'needs_revision'
              ? '差戻しました。ドライバーが修正して再提出できます。'
              : '紛争として運営に連絡しました。運営の裁定をお待ちください。',
        );
      },
    },
  );
  const doNoShow = useMutation(
    'no-show',
    (reason: string, key: string) =>
      unwrap(api.POST('/assignments/{assignmentId}/no-show', { params: { path: { assignmentId }, header: { 'Idempotency-Key': key } }, body: { reason } })),
    {
      onSuccess: (a) => {
        q.setData(a);
        setNoShow(false);
        setNotice('無断欠勤を記録しました。枠は解放され再募集されます。');
      },
    },
  );

  return (
    <AsyncView state={q}>
      {(a) => {
        const active = isActiveAssignment(a.state);
        const noShowAt = noShowAvailableAt(a.job?.startsAt);
        return (
          <>
            <PageHeader
              title={a.job?.title ?? '割当の詳細'}
              description={
                <span className="hd-row">
                  <StatusPill status={assignmentStateLabel(a.state)} />
                  <span>
                    {a.workerDisplayName ?? 'ドライバー'}（{formatRating(a.workerRatingAverage)}）
                  </span>
                </span>
              }
              actions={
                <>
                  <Link className="hd-btn" href={`/messages/${a.id}`}>
                    メッセージ
                  </Link>
                  {canReview(a.state) ? (
                    <>
                      <Button onClick={() => setReview('needs_revision')}>差戻し</Button>
                      <Button variant="danger" onClick={() => setReview('disputed')}>
                        紛争にする
                      </Button>
                      <Button variant="success" onClick={() => setReview('approved')}>
                        検収を承認
                      </Button>
                    </>
                  ) : null}
                  {canReportNoShow(a.state, a.job?.startsAt, now) ? (
                    <Button variant="danger" onClick={() => setNoShow(true)}>
                      無断欠勤を報告
                    </Button>
                  ) : null}
                </>
              }
            />
            {notice ? <Alert tone="green">{notice}</Alert> : null}
            {(a.state === 'accepted' || a.state === 'traveling') && !canReportNoShow(a.state, a.job?.startsAt, now) && noShowAt ? (
              <p className="hd-small hd-muted" style={{ margin: 0 }}>
                チェックインがない場合、{formatDateTimeJst(noShowAt)}（開始30分後）以降に無断欠勤を報告できます。
              </p>
            ) : null}
            {a.state === 'needs_revision' && a.reviewReason ? <Alert tone="orange" title="差戻し中">理由: {a.reviewReason}</Alert> : null}
            {a.state === 'disputed' ? <Alert tone="red" title="紛争中">運営が確認しています。{a.reviewReason ? `理由: ${a.reviewReason}` : ''}</Alert> : null}

            {active ? <LiveLocation assignmentId={a.id} /> : null}

            <div className="hd-split">
              <Card title="業務の概要">
                <KeyValue
                  items={[
                    ['カテゴリ', a.job ? categoryLabel(a.job.category).label : '—'],
                    ['日時', formatRangeJst(a.job?.startsAt, a.job?.endsAt)],
                    ['住所', a.job?.address],
                    ['受諾時の報酬', formatYen(a.acceptedAmountYen)],
                    ['受諾日時', formatDateTimeJst(a.acceptedAt)],
                    ['チェックイン', formatDateTimeJst(a.checkedInAt)],
                    ['作業開始', formatDateTimeJst(a.workStartedAt)],
                    ['完了報告', formatDateTimeJst(a.submittedAt)],
                    ['検収完了', formatDateTimeJst(a.completedAt)],
                    ['取消の扱い', a.lateCancellation ? '期限後の取消' : undefined],
                    [
                      '報酬の状態',
                      a.earning
                        ? `${earningStateLabel(a.earning.state).label} ${a.earning.amountYen !== undefined ? formatYen(a.earning.amountYen) : ''}${a.earning.scheduledPayoutDate ? `（振込予定 ${a.earning.scheduledPayoutDate}）` : ''}`
                        : undefined,
                    ],
                  ]}
                />
                {a.reportNote ? (
                  <>
                    <h3 style={{ fontSize: 16, marginTop: 16 }}>完了報告のメモ</h3>
                    <p className="hd-pre">{a.reportNote}</p>
                  </>
                ) : null}
              </Card>
              <Card title="作業手順">
                {a.steps && a.steps.length > 0 ? (
                  <ol style={{ margin: 0, paddingLeft: 20 }} className="hd-stack">
                    {a.steps.map((s) => (
                      <li key={s.index}>
                        <span className="hd-row">
                          <strong>{s.title}</strong>
                          <StatusPill status={s.completed ? { label: '完了', tone: 'green' } : { label: '未完了', tone: 'gray' }} soft />
                        </span>
                        {s.completedAt ? <div className="hd-small hd-muted">{formatDateTimeJst(s.completedAt)}</div> : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="hd-muted">手順の記録はありません。</p>
                )}
              </Card>
            </div>

            <Card title="証跡（写真）">
              <p className="hd-small hd-muted" style={{ marginTop: 0 }}>
                画像は「画像を表示」を押したときに有効期限付きURLで取得します（閲覧は記録されます）。必要な写真: {a.job?.minPhotoCount ?? 0}枚
              </p>
              <EvidenceGallery items={a.evidence ?? []} getUrl={evidenceUrl} />
            </Card>

            <Card title="経過">
              {a.timeline && a.timeline.length > 0 ? (
                <ol className="hd-timeline">
                  {a.timeline.map((t, i) => (
                    <li key={`${t.eventType}-${t.at}-${i}`}>
                      <strong>{timelineEventLabel(t.eventType)}</strong>{' '}
                      <span className="hd-small hd-muted">
                        {formatDateTimeJst(t.at)} ・ {actorRoleLabel(t.actorRole)}
                      </span>
                      {t.reason ? <div className="hd-small">理由: {t.reason}</div> : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="hd-muted">経過の記録はありません。</p>
              )}
            </Card>

            {canRate(a.state, a.myRatingSubmitted) ? <RatingForm assignmentId={a.id} onDone={q.reload} /> : null}
            {a.myRatingSubmitted ? <p className="hd-small hd-muted">このドライバーの評価は送信済みです。</p> : null}

            <ConfirmDialog
              open={!!review}
              title={review === 'approved' ? '検収を承認しますか？' : review === 'needs_revision' ? '差戻しますか？' : '紛争として運営に連絡しますか？'}
              description={
                review === 'approved'
                  ? `承認すると報酬（${formatYen(a.acceptedAmountYen)}）が確定し、支払対象になります。承認後は取り消せません。`
                  : review === 'needs_revision'
                    ? 'ドライバーに理由を伝え、修正・再提出を依頼します。'
                    : '合意できない場合に運営が裁定します。事実関係を具体的に記入してください。'
              }
              confirmLabel={review === 'approved' ? '承認する' : review === 'needs_revision' ? '差戻す' : '紛争にする'}
              tone={review === 'approved' ? 'success' : review === 'disputed' ? 'danger' : 'primary'}
              requireReason={review === 'needs_revision' || review === 'disputed'}
              showReason={review === 'approved'}
              reasonLabel={review === 'approved' ? 'コメント（任意）' : '理由'}
              pending={doReview.pending}
              error={doReview.error}
              onClose={() => {
                setReview(null);
                doReview.reset();
              }}
              onConfirm={(reason) => review && void doReview.run({ decision: review, reason })}
            />
            <ConfirmDialog
              open={noShow}
              title="無断欠勤を報告しますか？"
              description="開始から30分以上チェックインがない場合のみ報告できます。枠は解放されて再募集され、空き待ちのドライバーに通知されます。"
              confirmLabel="報告する"
              tone="danger"
              requireReason
              pending={doNoShow.pending}
              error={doNoShow.error}
              onClose={() => {
                setNoShow(false);
                doNoShow.reset();
              }}
              onConfirm={(reason) => void doNoShow.run(reason)}
            />
          </>
        );
      }}
    </AsyncView>
  );
}
