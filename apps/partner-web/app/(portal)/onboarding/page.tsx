'use client';
import Link from 'next/link';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst } from '@happydrive/web-ui/format';
import { orgReviewLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Card, KeyValue, PageHeader, StatusPill } from '@happydrive/web-ui/components';
import { OrgForm } from '@/components/OrgForm';
import { api, unwrap } from '@/lib/api';
import { emptyOrgForm, type OrganizationInput } from '@/lib/org-form';
import { useOrg } from '@/lib/org-context';

function OrgStatus({ orgId }: { orgId: string }) {
  const q = useQuery(`org:${orgId}`, () => unwrap(api.GET('/organizations/{organizationId}', { params: { path: { organizationId: orgId } } })));
  return (
    <AsyncView state={q}>
      {(o) => (
        <div className="hd-stack">
          <div className="hd-row">
            <strong>{o.legalName}</strong>
            <StatusPill status={orgReviewLabel(o.reviewStatus)} />
          </div>
          {o.reviewStatus === 'pending' ? (
            <Alert tone="orange" title="運営が審査中です">
              審査には数営業日かかる場合があります。承認されると案件の公開申請ができるようになります。その間も拠点の登録や案件の下書き作成は可能です。
            </Alert>
          ) : null}
          {o.reviewStatus === 'rejected' ? (
            <Alert tone="red" title="登録が却下されました">
              {o.reviewNote ? `理由: ${o.reviewNote}` : '理由は運営からの連絡をご確認ください。'}
              <div>
                <Link href="/settings">組織情報を修正する</Link>（修正後は再審査になります）
              </div>
            </Alert>
          ) : null}
          {o.reviewStatus === 'suspended' ? (
            <Alert tone="red" title="組織は停止中です">
              {o.reviewNote ? `理由: ${o.reviewNote}` : '詳細は運営からの連絡をご確認ください。'}
            </Alert>
          ) : null}
          {o.reviewStatus === 'approved' ? (
            <Alert tone="green" title="承認済みです">
              <Link href="/jobs/new">案件を作成する</Link>
            </Alert>
          ) : null}
          <KeyValue
            items={[
              ['所在地', o.address],
              ['公開連絡先', o.contact],
              ['代表者', o.representativeName],
              ['法人番号', o.corporateNumber],
              ['申請日時', formatDateTimeJst(o.createdAt)],
            ]}
          />
        </div>
      )}
    </AsyncView>
  );
}

export default function OnboardingPage() {
  const { org, orgs, reloadMe, setOrgId } = useOrg();
  const register = useMutation(
    'org-register',
    (body: OrganizationInput, key: string) =>
      unwrap(api.POST('/organizations', { params: { header: { 'Idempotency-Key': key } }, body })),
    {
      onSuccess: (created) => {
        setOrgId(created.id);
        reloadMe();
      },
    },
  );

  return (
    <>
      <PageHeader
        title={orgs.length ? '組織の審査状況' : '組織の登録'}
        description="企業・自治体の情報を登録し、運営の審査で承認されると案件を公開できます。"
      />
      {org ? (
        <Card title="選択中の組織">
          <OrgStatus orgId={org.id} />
        </Card>
      ) : null}
      <Card title={orgs.length ? '別の組織を登録する' : '登録申請'}>
        <p className="hd-muted" style={{ marginTop: 0 }}>
          登録したアカウントが組織のオーナーになります。入力内容は運営が確認します（公開連絡先は案件詳細に表示されます）。
        </p>
        <OrgForm initial={emptyOrgForm()} submitLabel="登録を申請する" pending={register.pending} error={register.error} onSubmit={(v) => void register.run(v)} />
      </Card>
    </>
  );
}
