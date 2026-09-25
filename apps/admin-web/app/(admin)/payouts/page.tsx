'use client';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { ApiError, errorMessage } from '@happydrive/web-ui/errors';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatNumber, formatPlainDate, formatYen, jstToday } from '@happydrive/web-ui/format';
import { payoutStatusLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, ConfirmDialog, EmptyState, Field, PageHeader, StatusPill, Tabs } from '@happydrive/web-ui/components';
import { useAdmin } from '@/lib/admin-context';
import { api, unwrap } from '@/lib/api';

type Payout = components['schemas']['Payout'];
type Filter = Payout['status'] | 'all';
type Batch = components['schemas']['PayoutBatch'];

function BatchError({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError && error.status === 503) {
    return (
      <Alert tone="orange" title="振込を実行できません（決済事業者が未契約・停止中）" role="alert">
        {errorMessage(error)}
        <div className="hd-small">事業者との契約・本番設定が完了するまで、この環境から送金は行われません。</div>
      </Alert>
    );
  }
  return (
    <Alert tone="red" title="振込バッチを作成できませんでした" role="alert">
      {errorMessage(error)}
    </Alert>
  );
}

export default function PayoutsPage() {
  const { canWrite } = useAdmin();
  const [filter, setFilter] = useState<Filter>('failed');
  const q = useQuery(`admin-payouts:${filter}`, () => unwrap(api.GET('/admin/payouts', { params: { query: filter === 'all' ? {} : { status: filter } } })));
  const [cutoff, setCutoff] = useState(() => jstToday());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [retrying, setRetrying] = useState<Payout | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cutoffError = /^\d{4}-\d{2}-\d{2}$/.test(cutoff) ? undefined : '締め日を入力してください。';

  const createBatch = useMutation(
    'payout-batch',
    (cutoffDate: string, key: string) => unwrap(api.POST('/admin/payouts/batches', { params: { header: { 'Idempotency-Key': key } }, body: { cutoffDate } })),
    {
      onSuccess: (b) => {
        setBatch(b);
        setConfirmBatch(false);
        q.reload();
      },
    },
  );
  const retry = useMutation(
    'payout-retry',
    (id: string, key: string) => unwrap(api.POST('/admin/payouts/{payoutId}/retry', { params: { path: { payoutId: id }, header: { 'Idempotency-Key': key } } })),
    {
      onSuccess: (p) => {
        setRetrying(null);
        setNotice(`振込を再試行しました（状態: ${payoutStatusLabel(p.status).label}）。`);
        q.reload();
      },
    },
  );

  return (
    <>
      <PageHeader title="振込" description="支払確定（payable）の報酬を利用者ごとに集計して振込を依頼します。二重振込防止キーを使用します。" />
      {notice ? <Alert tone="green">{notice}</Alert> : null}
      {canWrite ? (
        <Card title="振込バッチの作成">
          <div className="hd-row" style={{ alignItems: 'flex-end' }}>
            <Field label="締め日（JST）" required error={cutoffError} hint="この日までに支払確定した報酬が対象">
              {(p) => <input {...p} className="hd-input" type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />}
            </Field>
            <Button variant="primary" disabled={!!cutoffError} onClick={() => setConfirmBatch(true)}>
              振込バッチを作成
            </Button>
          </div>
          {!confirmBatch ? <BatchError error={createBatch.error} /> : null}
          {batch ? (
            <Alert tone="green" title="振込バッチを作成しました">
              締め日 {formatPlainDate(batch.cutoffDate)}：{formatNumber(batch.payoutCount)}件・合計 {formatYen(batch.totalYen)}
            </Alert>
          ) : null}
        </Card>
      ) : null}
      <Card title="振込一覧">
        <div className="hd-stack">
          <Tabs
            label="振込状態"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'failed', label: '失敗' },
              { value: 'requested', label: '依頼済み' },
              { value: 'processing', label: '処理中' },
              { value: 'paid', label: '振込済み' },
              { value: 'all', label: 'すべて' },
            ]}
          />
          <AsyncView state={q} empty={<EmptyState title="該当する振込はありません" />}>
            {(payouts) => (
              <div className="hd-table-wrap">
                <table className="hd-table">
                  <thead>
                    <tr>
                      <th scope="col">作成日時</th>
                      <th scope="col">利用者</th>
                      <th scope="col" className="hd-num">
                        金額
                      </th>
                      <th scope="col">状態</th>
                      <th scope="col">予定日 / 振込日時</th>
                      <th scope="col">事業者参照・失敗理由</th>
                      {canWrite ? <th scope="col">操作</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((p) => (
                      <tr key={p.id}>
                        <td className="hd-small">{formatDateTimeJst(p.createdAt)}</td>
                        <td>{p.workerDisplayName ?? p.workerId ?? '—'}</td>
                        <td className="hd-num">{formatYen(p.amountYen)}</td>
                        <td>
                          <StatusPill status={payoutStatusLabel(p.status)} soft />
                          {p.attemptCount ? <div className="hd-small hd-muted">試行 {p.attemptCount}回</div> : null}
                        </td>
                        <td className="hd-small">
                          {formatPlainDate(p.scheduledDate)}
                          <div>{p.paidAt ? formatDateTimeJst(p.paidAt) : ''}</div>
                        </td>
                        <td className="hd-small">
                          {p.providerReference ? <span className="hd-mono">{p.providerReference}</span> : null}
                          {p.failureReason ? <div className="hd-error-text">{p.failureReason}</div> : null}
                        </td>
                        {canWrite ? (
                          <td>
                            {p.status === 'failed' ? (
                              <Button size="sm" onClick={() => setRetrying(p)}>
                                再試行
                              </Button>
                            ) : null}
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
        open={confirmBatch}
        title="振込バッチを作成しますか？"
        description={`締め日 ${formatPlainDate(cutoff)} までの支払確定分を集計し、決済事業者へ振込を依頼します。同じ操作の再送では二重に振込まれません。`}
        confirmLabel="作成して依頼する"
        pending={createBatch.pending}
        onClose={() => {
          setConfirmBatch(false);
        }}
        onConfirm={() => void createBatch.run(cutoff)}
      >
        <BatchError error={createBatch.error} />
      </ConfirmDialog>
      <ConfirmDialog
        open={!!retrying}
        title="振込を再試行しますか？"
        description={retrying ? `${retrying.workerDisplayName ?? '利用者'}への ${formatYen(retrying.amountYen)} の振込を再依頼します。` : null}
        confirmLabel="再試行する"
        pending={retry.pending}
        error={retry.error}
        onClose={() => {
          setRetrying(null);
          retry.reset();
        }}
        onConfirm={() => retrying && void retry.run(retrying.id)}
      />
    </>
  );
}
