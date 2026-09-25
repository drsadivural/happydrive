'use client';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst } from '@happydrive/web-ui/format';
import { orgKindLabel, orgReviewLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, ConfirmDialog, EmptyState, KeyValue, PageHeader, StatusPill, Tabs } from '@happydrive/web-ui/components';
import { useAdmin } from '@/lib/admin-context';
import { api, unwrap } from '@/lib/api';

type Org = components['schemas']['Organization'];
type Status = Org['reviewStatus'];
type Decision = 'approved' | 'rejected' | 'suspended';
type Filter = Status | 'all';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'pending', label: '審査中' },
  { value: 'approved', label: '承認済み' },
  { value: 'rejected', label: '却下' },
  { value: 'suspended', label: '停止中' },
  { value: 'all', label: 'すべて' },
];
const DECISION_TEXT: Record<Decision, { title: string; label: string; tone: 'success' | 'danger'; desc: string }> = {
  approved: { title: '組織を承認しますか？', label: '承認する', tone: 'success', desc: '承認後、この組織は案件を公開申請できるようになります。法人番号・所在地・連絡先を確認してください。' },
  rejected: { title: '組織を却下しますか？', label: '却下する', tone: 'danger', desc: '却下理由は組織に表示されます。修正が必要な点を具体的に記入してください。' },
  suspended: { title: '組織を停止しますか？', label: '停止する', tone: 'danger', desc: '停止中は新しい案件を公開できません。進行中の業務への影響を確認してください。' },
};

/** GET /admin/organizations/{id} で最新の登録内容を表示 */
function OrgDetail({ orgId }: { orgId: string }) {
  const d = useQuery(`admin-org:${orgId}`, () => unwrap(api.GET('/admin/organizations/{organizationId}', { params: { path: { organizationId: orgId } } })));
  return (
    <AsyncView state={d}>
      {(o) => (
        <KeyValue
          items={[
            ['正式名称', o.legalName],
            ['審査状態', orgReviewLabel(o.reviewStatus).label],
            ['種別', orgKindLabel(o.kind)],
            ['法人番号', o.corporateNumber],
            ['所在地', o.address],
            ['公開連絡先', o.contact],
            ['代表者', o.representativeName],
            ['審査メモ', o.reviewNote],
            ['申請日時', formatDateTimeJst(o.createdAt)],
          ]}
        />
      )}
    </AsyncView>
  );
}

export default function OrganizationsPage() {
  const { canWrite } = useAdmin();
  const [filter, setFilter] = useState<Filter>('pending');
  const q = useQuery(`admin-orgs:${filter}`, () => unwrap(api.GET('/admin/organizations', { params: { query: filter === 'all' ? {} : { reviewStatus: filter } } })));
  const [target, setTarget] = useState<{ org: Org; decision: Decision } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const review = useMutation(
    'org-review',
    (args: { id: string; decision: Decision; reason: string }, key: string) =>
      unwrap(
        api.POST('/admin/organizations/{organizationId}/review', {
          params: { path: { organizationId: args.id }, header: { 'Idempotency-Key': key } },
          body: { decision: args.decision, reason: args.reason },
        }),
      ),
    {
      onSuccess: (o) => {
        setTarget(null);
        setNotice(`「${o.legalName}」を${orgReviewLabel(o.reviewStatus).label}にしました。`);
        q.reload();
        setDetailId(null);
      },
    },
  );

  return (
    <>
      <PageHeader title="組織審査" description="企業・自治体の登録内容を確認し、承認・却下・停止を行います。" />
      {notice ? <Alert tone="green">{notice}</Alert> : null}
      <Card>
        <div className="hd-stack">
          <Tabs label="審査状態" value={filter} onChange={setFilter} options={FILTERS} />
          <AsyncView state={q} empty={<EmptyState title="該当する組織はありません" />}>
            {(orgs) => (
              <div className="hd-stack">
                {orgs.map((o) => (
                  <section key={o.id} className="hd-card" style={{ padding: 16 }}>
                    <div className="hd-row" style={{ justifyContent: 'space-between' }}>
                      <div className="hd-row">
                        <strong>{o.legalName}</strong>
                        <StatusPill status={orgReviewLabel(o.reviewStatus)} />
                      </div>
                      <div className="hd-actions">
                        <Button size="sm" variant="ghost" onClick={() => setDetailId(detailId === o.id ? null : o.id)} aria-expanded={detailId === o.id}>
                          {detailId === o.id ? '詳細を閉じる' : '詳細（最新）'}
                        </Button>
                      </div>
                      {canWrite ? (
                        <div className="hd-actions">
                          {o.reviewStatus !== 'approved' ? (
                            <Button size="sm" variant="success" onClick={() => setTarget({ org: o, decision: 'approved' })}>
                              承認
                            </Button>
                          ) : null}
                          {o.reviewStatus === 'pending' ? (
                            <Button size="sm" onClick={() => setTarget({ org: o, decision: 'rejected' })}>
                              却下
                            </Button>
                          ) : null}
                          {o.reviewStatus !== 'suspended' ? (
                            <Button size="sm" variant="danger" onClick={() => setTarget({ org: o, decision: 'suspended' })}>
                              停止
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    {detailId === o.id ? (
                      <div style={{ marginTop: 12 }}>
                        <OrgDetail orgId={o.id} />
                      </div>
                    ) : null}
                    <div style={{ marginTop: 12, display: detailId === o.id ? 'none' : undefined }}>
                      <KeyValue
                        items={[
                          ['種別', orgKindLabel(o.kind)],
                          ['法人番号', o.corporateNumber],
                          ['所在地', o.address],
                          ['公開連絡先', o.contact],
                          ['代表者', o.representativeName],
                          ['審査メモ', o.reviewNote],
                          ['申請日時', formatDateTimeJst(o.createdAt)],
                        ]}
                      />
                    </div>
                  </section>
                ))}
              </div>
            )}
          </AsyncView>
        </div>
      </Card>
      <ConfirmDialog
        open={!!target}
        title={target ? DECISION_TEXT[target.decision].title : ''}
        description={target ? <>{`「${target.org.legalName}」`}<br />{DECISION_TEXT[target.decision].desc}</> : null}
        confirmLabel={target ? DECISION_TEXT[target.decision].label : ''}
        tone={target ? DECISION_TEXT[target.decision].tone : 'primary'}
        requireReason
        pending={review.pending}
        error={review.error}
        onClose={() => {
          setTarget(null);
          review.reset();
        }}
        onConfirm={(reason) => target && void review.run({ id: target.org.id, decision: target.decision, reason })}
      />
    </>
  );
}
