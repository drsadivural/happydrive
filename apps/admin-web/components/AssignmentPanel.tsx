'use client';
import { useState } from 'react';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatRangeJst, formatYen } from '@happydrive/web-ui/format';
import { actorRoleLabel, assignmentStateLabel, earningStateLabel, timelineEventLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, ConfirmDialog, EvidenceGallery, Field, KeyValue, StatusPill } from '@happydrive/web-ui/components';
import { useAdmin } from '@/lib/admin-context';
import { validateDispute, validateReverse, validateWorkerId, type Resolution } from '@/lib/admin-forms';
import { api, unwrap } from '@/lib/api';
import { evidenceUrl } from '@/lib/evidence';

const REVERSIBLE = ['approved', 'payable', 'paid'];
const REASSIGNABLE = ['reserved', 'accepted', 'traveling', 'checked_in', 'working', 'no_show', 'disputed'];
const RESOLUTIONS: { value: Resolution; label: string; desc: string }[] = [
  { value: 'pay_worker', label: '満額支払', desc: '受諾時の報酬を満額確定' },
  { value: 'partial', label: '一部支払', desc: '指定額で確定（差額は記録）' },
  { value: 'no_pay', label: '支払なし', desc: '支払済みの場合は逆仕訳' },
];

export function AssignmentPanel({ assignmentId, onChanged }: { assignmentId: string; onChanged: () => void }) {
  const { canWrite } = useAdmin();
  const q = useQuery(`assignment:${assignmentId}`, () => unwrap(api.GET('/assignments/{assignmentId}', { params: { path: { assignmentId } } })));
  const [dialog, setDialog] = useState<'dispute' | 'reverse' | 'reassign' | null>(null);
  const [resolution, setResolution] = useState<Resolution | ''>('');
  const [amount, setAmount] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const done = (msg: string) => {
    setDialog(null);
    setNotice(msg);
    q.reload();
    onChanged();
  };
  const resolve = useMutation(
    'resolve-dispute',
    (args: { resolution: Resolution; amountYen?: number; reason: string }, key: string) =>
      unwrap(api.POST('/admin/assignments/{assignmentId}/resolve-dispute', { params: { path: { assignmentId }, header: { 'Idempotency-Key': key } }, body: args })),
    { onSuccess: () => done('紛争を裁定しました。') },
  );
  const reverse = useMutation(
    'reverse-earning',
    (args: { amountYen: number; reason: string }, key: string) =>
      unwrap(api.POST('/admin/assignments/{assignmentId}/reverse', { params: { path: { assignmentId }, header: { 'Idempotency-Key': key } }, body: args })),
    { onSuccess: () => done('報酬の取消（逆仕訳）を記録しました。') },
  );
  const reassign = useMutation(
    'reassign',
    (args: { workerId: string; reason: string }, key: string) =>
      unwrap(api.POST('/admin/assignments/{assignmentId}/reassign', { params: { path: { assignmentId }, header: { 'Idempotency-Key': key } }, body: args })),
    { onSuccess: (a) => done(`再割当しました（新しい割当: ${a.id}）。`) },
  );

  return (
    <AsyncView state={q}>
      {(a) => {
        const disputeCheck = validateDispute(resolution, amount, a.acceptedAmountYen);
        const maxReverse = a.earning?.amountYen ?? a.acceptedAmountYen;
        const reverseCheck = validateReverse(amount, maxReverse);
        const workerCheck = validateWorkerId(workerId);
        return (
          <div className="hd-stack">
            {notice ? <Alert tone="green">{notice}</Alert> : null}
            <div className="hd-row">
              <StatusPill status={assignmentStateLabel(a.state)} />
              <strong>{a.job?.title}</strong>
            </div>
            {canWrite ? (
              <div className="hd-actions">
                {a.state === 'disputed' ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setResolution('');
                      setAmount('');
                      setDialog('dispute');
                    }}
                  >
                    紛争を裁定
                  </Button>
                ) : null}
                {REVERSIBLE.includes(a.state) ? (
                  <Button
                    variant="danger"
                    onClick={() => {
                      setAmount('');
                      setDialog('reverse');
                    }}
                  >
                    報酬を取消（逆仕訳）
                  </Button>
                ) : null}
                {REASSIGNABLE.includes(a.state) ? (
                  <Button
                    onClick={() => {
                      setWorkerId('');
                      setDialog('reassign');
                    }}
                  >
                    再割当
                  </Button>
                ) : null}
              </div>
            ) : null}
            <KeyValue
              items={[
                ['割当ID', <span key="i" className="hd-mono">{a.id}</span>],
                ['発注者', a.job?.organizationName],
                ['ドライバー', `${a.workerDisplayName ?? '—'}（${a.workerId}）`],
                ['日時', formatRangeJst(a.job?.startsAt, a.job?.endsAt)],
                ['受諾時の報酬', formatYen(a.acceptedAmountYen)],
                ['報酬台帳', a.earning ? `${earningStateLabel(a.earning.state).label} ${formatYen(a.earning.amountYen)}${a.earning.scheduledPayoutDate ? `（振込予定 ${a.earning.scheduledPayoutDate}）` : ''}` : '—'],
                ['チェックイン', formatDateTimeJst(a.checkedInAt)],
                ['完了報告', formatDateTimeJst(a.submittedAt)],
                ['検収・差戻し理由', a.reviewReason],
                ['完了報告メモ', a.reportNote],
                ['期限後取消', a.lateCancellation ? 'はい' : undefined],
              ]}
            />
            {a.termsSnapshot ? (
              <details>
                <summary>受諾時の条件スナップショット</summary>
                <pre className="hd-mono hd-pre" style={{ maxHeight: 240, overflow: 'auto' }}>
                  {JSON.stringify(a.termsSnapshot, null, 2)}
                </pre>
              </details>
            ) : null}
            <section>
              <h3 style={{ fontSize: 16, marginBottom: 8 }}>証跡</h3>
              <EvidenceGallery items={a.evidence ?? []} getUrl={evidenceUrl} />
            </section>
            <section>
              <h3 style={{ fontSize: 16, marginBottom: 8 }}>経過</h3>
              {a.timeline?.length ? (
                <ol className="hd-timeline">
                  {a.timeline.map((t, i) => (
                    <li key={`${t.eventType}-${i}`}>
                      <strong>{timelineEventLabel(t.eventType)}</strong>{' '}
                      <span className="hd-small hd-muted">
                        {formatDateTimeJst(t.at)} ・ {actorRoleLabel(t.actorRole)}
                      </span>
                      {t.reason ? <div className="hd-small">理由: {t.reason}</div> : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="hd-muted">記録はありません。</p>
              )}
            </section>

            <ConfirmDialog
              open={dialog === 'dispute'}
              title="紛争を裁定しますか？"
              description="裁定は台帳に記録され、支払済みの取消は逆仕訳で処理されます（元の記録は変更されません）。"
              confirmLabel="裁定する"
              requireReason
              reasonLabel="裁定理由"
              extraError={disputeCheck.error}
              pending={resolve.pending}
              error={resolve.error}
              onClose={() => {
                setDialog(null);
                resolve.reset();
              }}
              onConfirm={(reason) =>
                resolution && !disputeCheck.error && void resolve.run({ resolution, reason, ...(disputeCheck.amountYen ? { amountYen: disputeCheck.amountYen } : {}) })
              }
            >
              <div role="radiogroup" aria-label="裁定内容" className="hd-stack" style={{ gap: 4 }}>
                {RESOLUTIONS.map((r) => (
                  <label key={r.value} className="hd-check">
                    <input type="radio" name="resolution" checked={resolution === r.value} onChange={() => setResolution(r.value)} />
                    <span>
                      <strong>{r.label}</strong> <span className="hd-hint">{r.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
              {resolution === 'partial' ? (
                <Field label="支払額（円）" required hint={`受諾時の報酬 ${formatYen(a.acceptedAmountYen)} 未満`}>
                  {(p) => <input {...p} className="hd-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />}
                </Field>
              ) : null}
            </ConfirmDialog>
            <ConfirmDialog
              open={dialog === 'reverse'}
              title="確定済みの報酬を取消しますか？"
              description="台帳に逆仕訳（返金）を追加します。元の記録は変更されません。振込済みの場合は回収手続きが別途必要です。"
              confirmLabel="取消する"
              tone="danger"
              requireReason
              extraError={reverseCheck.error}
              pending={reverse.pending}
              error={reverse.error}
              onClose={() => {
                setDialog(null);
                reverse.reset();
              }}
              onConfirm={(reason) => reverseCheck.amountYen && void reverse.run({ amountYen: reverseCheck.amountYen, reason })}
            >
              <Field label="取消額（円）" required hint={`上限 ${formatYen(maxReverse)}`}>
                {(p) => <input {...p} className="hd-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />}
              </Field>
            </ConfirmDialog>
            <ConfirmDialog
              open={dialog === 'reassign'}
              title="別のドライバーに再割当しますか？"
              description="元の割当を取消し、指定したドライバーに同じ条件で割当てます（資格・時間重複は API が再検査します）。"
              confirmLabel="再割当する"
              requireReason
              extraError={workerCheck.error}
              pending={reassign.pending}
              error={reassign.error}
              onClose={() => {
                setDialog(null);
                reassign.reset();
              }}
              onConfirm={(reason) => workerCheck.workerId && void reassign.run({ workerId: workerCheck.workerId, reason })}
            >
              <Field label="再割当先のドライバーID" required hint="利用者審査の詳細画面のURLに含まれる UUID">
                {(p) => <input {...p} className="hd-input hd-mono" value={workerId} onChange={(e) => setWorkerId(e.target.value)} />}
              </Field>
            </ConfirmDialog>
          </div>
        );
      }}
    </AsyncView>
  );
}
