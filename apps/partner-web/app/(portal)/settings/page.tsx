'use client';
import { useState, type FormEvent } from 'react';
import type { components } from '@happydrive/contracts';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst } from '@happydrive/web-ui/format';
import { MEMBER_ROLE, memberRoleLabel, orgKindLabel, orgReviewLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, ConfirmDialog, EmptyState, ErrorAlert, Field, KeyValue, PageHeader, StatusPill } from '@happydrive/web-ui/components';
import { OrgForm } from '@/components/OrgForm';
import { api, unwrap } from '@/lib/api';
import { orgToForm, type OrganizationInput } from '@/lib/org-form';
import { useCurrentOrg } from '@/lib/org-context';

type Member = components['schemas']['Member'];
type MemberRole = Member['role'];

function OrgInfo() {
  const { org, isOwner, reloadMe } = useCurrentOrg();
  const q = useQuery(`org:${org.id}`, () => unwrap(api.GET('/organizations/{organizationId}', { params: { path: { organizationId: org.id } } })));
  const [editing, setEditing] = useState(false);
  const [pendingValue, setPendingValue] = useState<OrganizationInput | null>(null);
  const [saved, setSaved] = useState(false);
  const update = useMutation(
    'org-update',
    (body: OrganizationInput) => unwrap(api.PATCH('/organizations/{organizationId}', { params: { path: { organizationId: org.id } }, body })),
    {
      onSuccess: (o) => {
        q.setData(o);
        setPendingValue(null);
        setEditing(false);
        setSaved(true);
        reloadMe();
      },
    },
  );

  return (
    <Card
      title="組織情報"
      actions={
        isOwner && !editing ? (
          <Button
            size="sm"
            onClick={() => {
              setEditing(true);
              setSaved(false);
            }}
          >
            編集
          </Button>
        ) : null
      }
    >
      <AsyncView state={q}>
        {(o) =>
          editing ? (
            <div className="hd-stack">
              <Alert tone="orange" title="法的情報を変更すると再審査になります">
                名称・所在地・代表者などを変更すると組織は「審査中」に戻り、承認されるまで新しい案件を公開（審査申請）できません。
              </Alert>
              <OrgForm
                initial={orgToForm(o)}
                submitLabel="変更を保存"
                pending={update.pending}
                onSubmit={(v) => setPendingValue(v)}
                footer={
                  <Button onClick={() => setEditing(false)} disabled={update.pending}>
                    編集をやめる
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="hd-stack">
              {saved ? <Alert tone="green">組織情報を更新しました。</Alert> : null}
              <div className="hd-row">
                <StatusPill status={orgReviewLabel(o.reviewStatus)} />
                {o.reviewNote ? <span className="hd-small">運営からのコメント: {o.reviewNote}</span> : null}
              </div>
              <KeyValue
                items={[
                  ['正式名称', o.legalName],
                  ['種別', orgKindLabel(o.kind)],
                  ['法人番号', o.corporateNumber],
                  ['所在地', o.address],
                  ['公開連絡先', o.contact],
                  ['代表者', o.representativeName],
                  ['登録日時', formatDateTimeJst(o.createdAt)],
                  ['あなたの権限', memberRoleLabel(org.role).label],
                ]}
              />
              {!isOwner ? <p className="hd-small hd-muted">組織情報の変更はオーナーのみ可能です。</p> : null}
            </div>
          )
        }
      </AsyncView>
      <ConfirmDialog
        open={!!pendingValue}
        title="組織情報を変更しますか？"
        description="法的情報の変更は運営の再審査（審査中）になり、承認までは新しい案件を公開できません。"
        confirmLabel="変更して再審査を受ける"
        pending={update.pending}
        error={update.error}
        onClose={() => {
          setPendingValue(null);
          update.reset();
        }}
        onConfirm={() => pendingValue && void update.run(pendingValue)}
      />
    </Card>
  );
}

function Members() {
  const { org, isOwner, me } = useCurrentOrg();
  const q = useQuery(`members:${org.id}`, () => unwrap(api.GET('/organizations/{organizationId}/members', { params: { path: { organizationId: org.id } } })));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('manager');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const add = useMutation(
    'member-add',
    (body: { email: string; role: MemberRole }) => unwrap(api.POST('/organizations/{organizationId}/members', { params: { path: { organizationId: org.id } }, body })),
    {
      onSuccess: () => {
        setEmail('');
        q.reload();
      },
    },
  );
  const remove = useMutation(
    'member-remove',
    (userId: string) => unwrap(api.DELETE('/organizations/{organizationId}/members/{userId}', { params: { path: { organizationId: org.id, userId } } })),
    {
      onSuccess: () => {
        setRemoving(null);
        q.reload();
      },
    },
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 254) {
      setEmailError('メールアドレスの形式が正しくありません。');
      return;
    }
    setEmailError(null);
    void add.run({ email: v, role });
  }

  return (
    <Card title="メンバー">
      <AsyncView state={q} empty={<EmptyState title="メンバーはいません" />}>
        {(members) => (
          <div className="hd-table-wrap">
            <table className="hd-table">
              <thead>
                <tr>
                  <th scope="col">名前</th>
                  <th scope="col">メール</th>
                  <th scope="col">権限</th>
                  <th scope="col">二段階認証</th>
                  {isOwner ? <th scope="col">操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td>
                      {m.displayName}
                      {m.userId === me.id ? <span className="hd-small hd-muted">（あなた）</span> : null}
                    </td>
                    <td>{m.email ?? '—'}</td>
                    <td>{memberRoleLabel(m.role).label}</td>
                    <td>{m.mfaEnabled === undefined ? '—' : m.mfaEnabled ? '設定済み' : '未設定'}</td>
                    {isOwner ? (
                      <td>
                        <Button size="sm" variant="danger" onClick={() => setRemoving(m)}>
                          削除
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncView>
      {isOwner ? (
        <form className="hd-form" onSubmit={submit} noValidate style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 16 }}>メンバーを追加</h3>
          <p className="hd-small hd-muted" style={{ margin: 0 }}>
            追加する方は先に企業ポータルでアカウントを作成（新規登録）しておく必要があります。
          </p>
          <div className="hd-grid-2">
            <Field label="メールアドレス" required error={emailError ?? undefined}>
              {(p) => <input {...p} className="hd-input" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Field label="権限" required hint="オーナー: 組織情報・メンバー管理 / 管理者: 案件・検収 / 検収担当: 検収">
              {(p) => (
                <select {...p} className="hd-select" value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
                  {(Object.keys(MEMBER_ROLE) as MemberRole[]).map((r) => (
                    <option key={r} value={r}>
                      {MEMBER_ROLE[r].label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <ErrorAlert error={add.error} title="追加できませんでした" />
          <div>
            <Button type="submit" variant="primary" loading={add.pending}>
              追加する
            </Button>
          </div>
        </form>
      ) : (
        <p className="hd-small hd-muted">メンバーの追加・削除はオーナーのみ可能です。</p>
      )}
      <ConfirmDialog
        open={!!removing}
        title="メンバーを削除しますか？"
        description={removing ? `${removing.displayName} さんはこの組織の案件・検収を操作できなくなります。` : null}
        confirmLabel="削除する"
        tone="danger"
        pending={remove.pending}
        error={remove.error}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        onConfirm={() => removing && void remove.run(removing.userId)}
      />
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="組織・設定" description="組織情報とメンバーを管理します。" />
      <OrgInfo />
      <Members />
    </>
  );
}
