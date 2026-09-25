'use client';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst } from '@happydrive/web-ui/format';
import { ticketCategoryLabel, ticketStatusLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, ConfirmDialog, EmptyState, Field, PageHeader, StatusPill, Tabs } from '@happydrive/web-ui/components';
import { useAdmin } from '@/lib/admin-context';
import { api, unwrap } from '@/lib/api';
import { isAppeal } from '@/lib/tickets';

type Ticket = components['schemas']['SupportTicket'];
type Status = Ticket['status'];


function AnswerForm({ ticket, onDone }: { ticket: Ticket; onDone: () => void }) {
  const [answer, setAnswer] = useState(ticket.answer ?? '');
  const [close, setClose] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const submit = useMutation(
    'ticket-answer',
    (body: { answer: string; close: boolean }, key: string) =>
      unwrap(api.POST('/admin/support-tickets/{ticketId}/answer', { params: { path: { ticketId: ticket.id }, header: { 'Idempotency-Key': key } }, body })),
    { onSuccess: onDone },
  );
  return (
    <form
      className="hd-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const v = answer.trim();
        if (!v) return setErr('回答を入力してください。');
        if (v.length > 4000) return setErr('回答は4000文字以内で入力してください。');
        setErr(null);
        setConfirming(true);
      }}
    >
      <Field label="回答" required error={err ?? undefined} hint="利用者に通知されます（4000文字以内）">
        {(p) => <textarea {...p} className="hd-textarea" rows={4} maxLength={4000} value={answer} onChange={(e) => setAnswer(e.target.value)} />}
      </Field>
      <label className="hd-check">
        <input type="checkbox" checked={close} onChange={(e) => setClose(e.target.checked)} />
        <span>回答と同時に完了（クローズ）にする</span>
      </label>
      <div>
        <Button type="submit" variant="primary" loading={submit.pending}>
          回答を送信
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={close ? '回答を送信して完了にしますか？' : '回答を送信しますか？'}
        description="回答は利用者に通知され、監査記録に残ります。"
        confirmLabel="送信する"
        pending={submit.pending}
        error={submit.error}
        onClose={() => {
          setConfirming(false);
          submit.reset();
        }}
        onConfirm={() => void submit.run({ answer: answer.trim(), close })}
      />
    </form>
  );
}

export default function SupportPage() {
  const { canWrite } = useAdmin();
  const [status, setStatus] = useState<Status>('open');
  const [appealsOnly, setAppealsOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const q = useQuery(`admin-tickets:${status}`, () => unwrap(api.GET('/admin/support-tickets', { params: { query: { status } } })));

  return (
    <>
      <PageHeader title="問い合わせ" description="利用者からの問い合わせと、マッチング（推薦・除外）への異議申立てに回答します。" />
      {notice ? <Alert tone="green">{notice}</Alert> : null}
      <Card>
        <div className="hd-stack">
          <Tabs
            label="対応状況"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setOpenId(null);
            }}
            options={[
              { value: 'open', label: '未回答' },
              { value: 'answered', label: '回答済み' },
              { value: 'closed', label: '完了' },
            ]}
          />
          <label className="hd-check">
            <input type="checkbox" checked={appealsOnly} onChange={(e) => setAppealsOnly(e.target.checked)} />
            <span>マッチングへの異議申立てのみ表示</span>
          </label>
          <AsyncView
            state={q}
            isEmpty={(items) => items.filter((t) => !appealsOnly || isAppeal(t)).length === 0}
            empty={<EmptyState title="該当する問い合わせはありません" />}
          >
            {(tickets) => (
              <div className="hd-stack">
                {tickets
                  .filter((t) => !appealsOnly || isAppeal(t))
                  .map((t) => (
                    <section key={t.id} className="hd-card" style={{ padding: 16 }}>
                      <div className="hd-row" style={{ justifyContent: 'space-between' }}>
                        <div className="hd-row">
                          <StatusPill status={ticketStatusLabel(t.status)} soft />
                          <strong>{isAppeal(t) ? 'マッチング異議申立て' : ticketCategoryLabel(t.category)}</strong>
                          <span className="hd-small hd-muted">
                            {t.userDisplayName ?? '利用者'} ・ {formatDateTimeJst(t.createdAt)}
                          </span>
                        </div>
                        {canWrite && t.status !== 'closed' ? (
                          <Button size="sm" onClick={() => setOpenId(openId === t.id ? null : t.id)} aria-expanded={openId === t.id}>
                            {openId === t.id ? '閉じる' : '回答する'}
                          </Button>
                        ) : null}
                      </div>
                      <p className="hd-pre">{t.body}</p>
                      {t.jobId ? <div className="hd-small hd-muted">案件ID: <span className="hd-mono">{t.jobId}</span></div> : null}
                      {t.assignmentId ? <div className="hd-small hd-muted">割当ID: <span className="hd-mono">{t.assignmentId}</span></div> : null}
                      {t.answer ? (
                        <div className="hd-alert hd-tone-blue" style={{ marginTop: 8 }}>
                          <strong>回答</strong>
                          <p className="hd-pre" style={{ margin: 0 }}>{t.answer}</p>
                        </div>
                      ) : null}
                      {openId === t.id ? (
                        <div style={{ marginTop: 12 }}>
                          <AnswerForm
                            ticket={t}
                            onDone={() => {
                              setOpenId(null);
                              setNotice('回答を送信しました。');
                              q.reload();
                            }}
                          />
                        </div>
                      ) : null}
                    </section>
                  ))}
              </div>
            )}
          </AsyncView>
        </div>
      </Card>
    </>
  );
}
