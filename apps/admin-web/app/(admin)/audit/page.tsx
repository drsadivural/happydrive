'use client';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatNumber } from '@happydrive/web-ui/format';
import { actorRoleLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, EmptyState, ErrorAlert, Field, PageHeader, StatusPill } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';

const ENTITY_TYPES = ['', 'user', 'organization', 'job', 'assignment', 'earning', 'payout', 'report', 'support_ticket', 'matching_config', 'evidence', 'deletion_request'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Filters {
  entityType: string;
  entityId: string;
  limit: number;
}

export default function AuditPage() {
  const [draft, setDraft] = useState<Filters>({ entityType: '', entityId: '', limit: 100 });
  const [filters, setFilters] = useState<Filters>(draft);
  const [idError, setIdError] = useState<string | null>(null);
  const q = useQuery(`audit:${filters.entityType}:${filters.entityId}:${filters.limit}`, () =>
    unwrap(
      api.GET('/admin/audit-events', {
        params: {
          query: {
            ...(filters.entityType ? { entityType: filters.entityType } : {}),
            ...(filters.entityId ? { entityId: filters.entityId } : {}),
            limit: filters.limit,
          },
        },
      }),
    ),
  );
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; checked: number; firstInvalidId?: number } | null>(null);
  const verify = useMutation('audit-verify', () => unwrap(api.GET('/admin/audit-events/verify')), { onSuccess: (r) => setVerifyResult(r) });

  function submit(e: FormEvent) {
    e.preventDefault();
    const id = draft.entityId.trim();
    if (id && !UUID_RE.test(id)) {
      setIdError('対象IDは UUID 形式で入力してください。');
      return;
    }
    setIdError(null);
    setFilters({ ...draft, entityId: id });
  }

  return (
    <>
      <PageHeader title="監査ログ" description="すべての書込操作の追記式イベント（操作主体・時刻・理由）を確認します。" />
      <Card
        title="改ざん検証"
        actions={
          <Button variant="primary" loading={verify.pending} onClick={() => void verify.run(undefined)}>
            ハッシュ連鎖を検証
          </Button>
        }
      >
        <p className="hd-small hd-muted" style={{ marginTop: 0 }}>
          追記式イベントのハッシュ連鎖を API が再計算し、改変の有無を確認します。
        </p>
        <ErrorAlert error={verify.error} title="検証できませんでした" />
        {verifyResult && !verify.pending ? (
          verifyResult.valid ? (
            <Alert tone="green" title="改ざんは検出されませんでした">
              {formatNumber(verifyResult.checked)}件のイベントを検証しました。
            </Alert>
          ) : (
            <Alert tone="red" title="ハッシュ連鎖の不整合を検出しました" role="alert">
              {formatNumber(verifyResult.checked)}件を検証。最初の不整合: イベント #{verifyResult.firstInvalidId ?? '不明'}{' '}
              <StatusPill status={{ label: '要調査', tone: 'red' }} soft />
            </Alert>
          )
        ) : null}
      </Card>
      <Card title="イベント">
        <form className="hd-grid-3" onSubmit={submit} style={{ alignItems: 'end', marginBottom: 16 }}>
          <Field label="対象の種類">
            {(p) => (
              <select {...p} className="hd-select" value={draft.entityType} onChange={(e) => setDraft({ ...draft, entityType: e.target.value })}>
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t || 'すべて'}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="対象ID（UUID）" error={idError ?? undefined}>
            {(p) => <input {...p} className="hd-input hd-mono" value={draft.entityId} onChange={(e) => setDraft({ ...draft, entityId: e.target.value })} />}
          </Field>
          <div className="hd-row" style={{ alignItems: 'flex-end' }}>
            <Field label="件数">
              {(p) => (
                <select {...p} className="hd-select" value={draft.limit} onChange={(e) => setDraft({ ...draft, limit: Number(e.target.value) })}>
                  {[50, 100, 200, 500].map((n) => (
                    <option key={n} value={n}>
                      {n}件
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Button type="submit">絞り込み</Button>
          </div>
        </form>
        <AsyncView state={q} empty={<EmptyState title="イベントはありません" />}>
          {(events) => (
            <div className="hd-table-wrap">
              <table className="hd-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">日時</th>
                    <th scope="col">対象</th>
                    <th scope="col">イベント</th>
                    <th scope="col">操作主体</th>
                    <th scope="col">理由</th>
                    <th scope="col">ハッシュ・内容</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => (
                    <tr key={ev.id}>
                      <td className="hd-num">{ev.id}</td>
                      <td className="hd-small">{formatDateTimeJst(ev.createdAt)}</td>
                      <td>
                        {ev.entityType}
                        <div>
                          <button
                            type="button"
                            className="hd-btn hd-btn--ghost hd-btn--sm hd-mono"
                            style={{ padding: 0, minHeight: 0 }}
                            title="この対象で絞り込み"
                            onClick={() => {
                              const f = { entityType: ev.entityType, entityId: ev.entityId, limit: filters.limit };
                              setDraft(f);
                              setFilters(f);
                            }}
                          >
                            {ev.entityId}
                          </button>
                        </div>
                      </td>
                      <td>{ev.eventType}</td>
                      <td className="hd-small">
                        {actorRoleLabel(ev.actorRole)}
                        {ev.actorId ? <div className="hd-mono hd-muted">{ev.actorId}</div> : null}
                      </td>
                      <td className="hd-small hd-pre" style={{ maxWidth: 260 }}>
                        {ev.reason ?? '—'}
                      </td>
                      <td className="hd-small">
                        {ev.hash ? <span className="hd-mono" title={ev.hash}>{ev.hash.slice(0, 12)}…</span> : '—'}
                        {ev.payload ? (
                          <details>
                            <summary>内容</summary>
                            <pre className="hd-mono hd-pre" style={{ maxWidth: 360, maxHeight: 200, overflow: 'auto' }}>
                              {JSON.stringify(ev.payload, null, 2)}
                            </pre>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Card>
    </>
  );

}
