'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MESSAGE_SENDER, assignmentStateLabel } from '@happydrive/web-ui/labels';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst } from '@happydrive/web-ui/format';
import { Button, ConfirmDialog, ErrorAlert, ErrorState, Field, LoadingState, PageHeader, StatusPill, Alert } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';
import { latestCreatedAt, mergeMessages, REPORT_REASONS, type Message, type ReportReason } from '@/lib/chat';

const POLL_MS = 10_000;

function useMessages(assignmentId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const latestRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    latestRef.current = undefined;
    async function tick() {
      try {
        const after = latestRef.current;
        const incoming = await unwrap(
          api.GET('/assignments/{assignmentId}/messages', { params: { path: { assignmentId }, query: after ? { after } : {} } }),
        );
        if (cancelled) return;
        setMessages((prev) => {
          const merged = mergeMessages(after ? prev : [], incoming);
          latestRef.current = latestCreatedAt(merged);
          return merged;
        });
        setError(null);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    }
    void tick();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [assignmentId, nonce]);

  return {
    messages,
    loaded,
    error,
    retry: () => setNonce((n) => n + 1),
    append: (m: Message) => setMessages((prev) => mergeMessages(prev, [m])),
  };
}

export function ChatView({ assignmentId }: { assignmentId: string }) {
  const assignment = useQuery(`assignment:${assignmentId}`, () => unwrap(api.GET('/assignments/{assignmentId}', { params: { path: { assignmentId } } })));
  const { messages, loaded, error, retry, append } = useMessages(assignmentId);
  const [body, setBody] = useState('');
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<Message | null>(null);
  const [reportReason, setReportReason] = useState<ReportReason>('harassment');
  const [reported, setReported] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const send = useMutation(
    'message',
    (text: string, key: string) =>
      unwrap(api.POST('/assignments/{assignmentId}/messages', { params: { path: { assignmentId }, header: { 'Idempotency-Key': key } }, body: { body: text } })),
    {
      onSuccess: (m) => {
        append(m);
        setBody('');
      },
    },
  );
  const report = useMutation(
    'report',
    (args: { messageId: string; reason: ReportReason; detail: string }, key: string) =>
      unwrap(
        api.POST('/reports', {
          params: { header: { 'Idempotency-Key': key } },
          body: { targetType: 'message', targetId: args.messageId, reason: args.reason, ...(args.detail ? { detail: args.detail } : {}) },
        }),
      ),
    {
      onSuccess: () => {
        setReporting(null);
        setReported('通報を受け付けました。運営が内容を確認します。');
      },
    },
  );

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) {
      setBodyError('メッセージを入力してください。');
      return;
    }
    if (text.length > 2000) {
      setBodyError('メッセージは2000文字以内で入力してください。');
      return;
    }
    setBodyError(null);
    void send.run(text);
  }

  const a = assignment.data;
  return (
    <>
      <PageHeader
        title={a?.job?.title ?? 'メッセージ'}
        description={
          a ? (
            <span className="hd-row">
              <span>{a.workerDisplayName ?? 'ドライバー'}</span>
              <StatusPill status={assignmentStateLabel(a.state)} soft />
              <Link href={`/assignments/${a.id}`}>業務の詳細</Link>
            </span>
          ) : undefined
        }
      />
      {reported ? <Alert tone="green">{reported}</Alert> : null}
      <section className="hd-card">
        {!loaded && error ? (
          <ErrorState error={error} onRetry={retry} />
        ) : !loaded ? (
          <LoadingState label="メッセージを読み込み中…" />
        ) : (
          <>
            {error ? <ErrorAlert error={error} title="新着メッセージを取得できませんでした（自動で再試行します）" /> : null}
            <div className="hd-chat" ref={listRef} aria-live="polite" aria-label="メッセージ一覧">
              {messages.length === 0 ? <p className="hd-muted">まだメッセージはありません。</p> : null}
              {messages.map((m) => (
                <div key={m.id} className="hd-bubble" data-mine={!!m.isMine}>
                  <div className="hd-bubble-meta">
                    <strong>{m.senderName ?? MESSAGE_SENDER[m.senderRole] ?? m.senderRole}</strong>
                    <span>{formatDateTimeJst(m.createdAt)}</span>
                    {!m.isMine && m.senderRole !== 'system' && !m.hidden ? (
                      <button type="button" className="hd-btn hd-btn--ghost hd-btn--sm" onClick={() => setReporting(m)}>
                        通報
                      </button>
                    ) : null}
                  </div>
                  {m.hidden ? <em className="hd-muted">（運営により非表示にされたメッセージ）</em> : <p className="hd-pre" style={{ margin: 0 }}>{m.body}</p>}
                  {m.evidenceId ? <div className="hd-small hd-muted">添付あり</div> : null}
                </div>
              ))}
            </div>
            <form className="hd-form" onSubmit={submit} noValidate style={{ marginTop: 16 }}>
              <Field label="メッセージ" error={bodyError ?? undefined} hint="2000文字以内。電話番号・住所などの個人情報は送らないでください。">
                {(p) => <textarea {...p} className="hd-textarea" rows={3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />}
              </Field>
              <ErrorAlert error={send.error} title="送信できませんでした" />
              <div className="hd-actions">
                <Button type="submit" variant="primary" loading={send.pending}>
                  送信
                </Button>
                <span className="hd-small hd-muted">新着は10秒ごとに自動で確認します。</span>
              </div>
            </form>
          </>
        )}
      </section>
      <ConfirmDialog
        open={!!reporting}
        title="このメッセージを通報しますか？"
        description="運営が内容を確認し、必要に応じて非表示・利用停止などの対応を行います。"
        confirmLabel="通報する"
        tone="danger"
        showReason
        reasonLabel="詳細（任意）"
        reasonMaxLength={2000}
        pending={report.pending}
        error={report.error}
        onClose={() => {
          setReporting(null);
          report.reset();
        }}
        onConfirm={(detail) => reporting && void report.run({ messageId: reporting.id, reason: reportReason, detail })}
      >
        <Field label="通報の理由" required>
          {(p) => (
            <select {...p} className="hd-select" value={reportReason} onChange={(e) => setReportReason(e.target.value as ReportReason)}>
              {REPORT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </ConfirmDialog>
    </>
  );
}
