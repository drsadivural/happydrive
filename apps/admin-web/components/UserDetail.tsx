'use client';
import { useState } from 'react';
import type { components } from '@happydrive/contracts';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatNumber, formatPlainDate } from '@happydrive/web-ui/format';
import { skillStatusLabel, userRoleLabel, vehicleTypeLabel, verificationLabel } from '@happydrive/web-ui/labels';
import { Alert, AsyncView, Button, Card, ConfirmDialog, EvidenceGallery, Field, KeyValue, PageHeader, StatusPill } from '@happydrive/web-ui/components';
import { useAdmin } from '@/lib/admin-context';
import { api, unwrap } from '@/lib/api';
import { evidenceUrl } from '@/lib/evidence';
import { maskAddress, maskBirthDate, maskPlate, maskPostalCode } from '@/lib/mask';

type Detail = components['schemas']['AdminUserDetail'];
type Decision = 'verified' | 'rejected';

export function UserDetail({ userId }: { userId: string }) {
  const { canWrite } = useAdmin();
  const q = useQuery(`admin-user:${userId}`, () => unwrap(api.GET('/admin/users/{userId}', { params: { path: { userId } } })));
  const [reveal, setReveal] = useState(false);
  const [verification, setVerification] = useState<Decision | null>(null);
  const [suspension, setSuspension] = useState<boolean | null>(null);
  const [skill, setSkill] = useState<{ code: string; name: string; decision: Decision } | null>(null);
  const [validUntil, setValidUntil] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const decideVerification = useMutation(
    'verification',
    (args: { decision: Decision; reason: string }, key: string) =>
      unwrap(api.POST('/admin/users/{userId}/verification', { params: { path: { userId }, header: { 'Idempotency-Key': key } }, body: args })),
    {
      onSuccess: (d, args) => {
        q.setData(d);
        setVerification(null);
        setNotice(args.decision === 'verified' ? '本人確認を承認しました。' : '本人確認を却下しました。');
      },
    },
  );
  const setSuspended = useMutation(
    'suspension',
    (args: { suspended: boolean; reason: string }, key: string) =>
      unwrap(api.POST('/admin/users/{userId}/suspension', { params: { path: { userId }, header: { 'Idempotency-Key': key } }, body: args })),
    {
      onSuccess: (d, args) => {
        q.setData(d);
        setSuspension(null);
        setNotice(args.suspended ? '利用を停止しました。' : '利用停止を解除しました。');
      },
    },
  );
  const decideSkill = useMutation(
    'skill-decision',
    (args: { code: string; decision: Decision; reason: string; validUntil?: string }, key: string) =>
      unwrap(
        api.POST('/admin/users/{userId}/skills/{skillCode}', {
          params: { path: { userId, skillCode: args.code }, header: { 'Idempotency-Key': key } },
          body: { decision: args.decision, reason: args.reason, ...(args.validUntil ? { validUntil: args.validUntil } : {}) },
        }),
      ),
    {
      onSuccess: (_s, args) => {
        setSkill(null);
        setNotice(args.decision === 'verified' ? '資格を確認済みにしました。' : '資格を却下しました。');
        q.reload();
      },
    },
  );

  const validUntilError = skill?.decision === 'verified' && validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil) ? '有効期限の形式が正しくありません。' : undefined;

  return (
    <AsyncView state={q}>
      {(u: Detail) => (
        <>
          <PageHeader
            title={u.displayName}
            description={
              <span className="hd-row">
                <StatusPill status={verificationLabel(u.verificationStatus)} />
                {u.suspended ? <StatusPill status={{ label: '利用停止中', tone: 'red' }} /> : null}
                {u.deleted ? <StatusPill status={{ label: '削除済み', tone: 'gray' }} /> : null}
                <span className="hd-small">{u.roles.map((r) => userRoleLabel(r).label).join('、')}</span>
              </span>
            }
            actions={
              canWrite ? (
                <>
                  {u.verificationStatus === 'pending' ? (
                    <>
                      <Button onClick={() => setVerification('rejected')}>本人確認を却下</Button>
                      <Button variant="success" onClick={() => setVerification('verified')}>
                        本人確認を承認
                      </Button>
                    </>
                  ) : null}
                  <Button variant={u.suspended ? 'primary' : 'danger'} onClick={() => setSuspension(!u.suspended)}>
                    {u.suspended ? '利用停止を解除' : '利用停止'}
                  </Button>
                </>
              ) : null
            }
          />
          {notice ? <Alert tone="green">{notice}</Alert> : null}
          {u.verificationNote ? <Alert tone="blue" title="審査メモ">{u.verificationNote}</Alert> : null}

          <div className="hd-split">
            <Card
              title="本人情報"
              actions={
                <Button size="sm" onClick={() => setReveal((v) => !v)} aria-pressed={reveal}>
                  {reveal ? 'マスクする' : '住所・生年月日を表示'}
                </Button>
              }
            >
              <KeyValue
                items={[
                  ['氏名', u.profile?.legalName],
                  ['フリガナ', u.profile?.legalNameKana],
                  ['生年月日', reveal ? formatPlainDate(u.profile?.birthDate) : maskBirthDate(u.profile?.birthDate)],
                  ['郵便番号', reveal ? u.profile?.postalCode : maskPostalCode(u.profile?.postalCode)],
                  ['住所', reveal ? u.profile?.address : maskAddress(u.profile?.address)],
                  ['適格請求書番号', u.profile?.invoiceRegistrationNumber],
                  ['連絡先', u.phoneMasked ?? u.email],
                  ['登録日時', formatDateTimeJst(u.createdAt)],
                  ['業務件数', formatNumber(u.assignmentCount ?? 0)],
                  ['評価', typeof u.ratingAverage === 'number' ? `★ ${u.ratingAverage.toFixed(1)}` : '評価なし'],
                ]}
              />
            </Card>
            <div className="hd-stack">
              <Card title="車両">
                <KeyValue
                  items={[
                    ['種類', vehicleTypeLabel(u.vehicle?.type)],
                    ['ナンバー', maskPlate(u.vehicle?.plateNumber)],
                    ['黒ナンバー届出', u.vehicle?.blackPlateRegistered === undefined ? '—' : u.vehicle.blackPlateRegistered ? 'あり' : 'なし'],
                    ['最大積載量', u.vehicle?.cargoCapacityKg !== undefined ? `${u.vehicle.cargoCapacityKg}kg` : '—'],
                  ]}
                />
              </Card>
              <Card title="振込口座（マスク済み）">
                <KeyValue
                  items={[
                    ['銀行コード', u.bankAccount?.bankCode],
                    ['支店コード', u.bankAccount?.branchCode],
                    ['種別', u.bankAccount?.accountType === 'ordinary' ? '普通' : u.bankAccount?.accountType === 'checking' ? '当座' : u.bankAccount?.accountType === 'savings' ? '貯蓄' : u.bankAccount?.accountType],
                    ['口座番号', u.bankAccount?.accountNumberLast4 ? `＊＊＊${u.bankAccount.accountNumberLast4}` : '—'],
                    ['名義（カナ）', u.bankAccount?.holderNameKana],
                  ]}
                />
              </Card>
            </div>
          </div>

          <Card title="本人確認書類">
            <p className="hd-small hd-muted" style={{ marginTop: 0 }}>
              画像は必要なときだけ有効期限付きURLで取得します（閲覧は監査記録されます）。
            </p>
            <EvidenceGallery items={(u.verificationDocumentIds ?? []).map((id) => ({ id, purpose: 'identity_document' }))} getUrl={evidenceUrl} />
          </Card>

          <Card title="資格・講習">
            {u.skills && u.skills.length > 0 ? (
              <div className="hd-stack">
                {u.skills.map((s) => (
                  <section key={s.code} className="hd-card" style={{ padding: 16 }}>
                    <div className="hd-row" style={{ justifyContent: 'space-between' }}>
                      <div className="hd-row">
                        <strong>{s.name}</strong>
                        <StatusPill status={skillStatusLabel(s.status)} soft />
                        <span className="hd-small hd-muted">
                          {s.source === 'training' ? '講習' : '資格証'}・有効期限 {formatPlainDate(s.validUntil)}
                        </span>
                      </div>
                      {canWrite && s.status === 'pending' ? (
                        <div className="hd-actions">
                          <Button size="sm" onClick={() => setSkill({ code: s.code, name: s.name, decision: 'rejected' })}>
                            却下
                          </Button>
                          <Button
                            size="sm"
                            variant="success"
                            onClick={() => {
                              setValidUntil(s.validUntil ?? '');
                              setSkill({ code: s.code, name: s.name, decision: 'verified' });
                            }}
                          >
                            確認済みにする
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    {s.note ? <p className="hd-small">メモ: {s.note}</p> : null}
                    {s.documentEvidenceIds && s.documentEvidenceIds.length > 0 ? (
                      <div style={{ marginTop: 12 }}>
                        <EvidenceGallery items={s.documentEvidenceIds.map((id) => ({ id, purpose: 'skill_document' }))} getUrl={evidenceUrl} />
                      </div>
                    ) : null}
                  </section>
                ))}
              </div>
            ) : (
              <p className="hd-muted">登録された資格はありません。</p>
            )}
          </Card>

          <ConfirmDialog
            open={!!verification}
            title={verification === 'verified' ? '本人確認を承認しますか？' : '本人確認を却下しますか？'}
            description={verification === 'verified' ? '書類と本人情報が一致することを確認してください。承認後、案件を受諾できるようになります。' : '却下理由は利用者に通知されます。再提出が必要な点を具体的に記入してください。'}
            confirmLabel={verification === 'verified' ? '承認する' : '却下する'}
            tone={verification === 'verified' ? 'success' : 'danger'}
            requireReason
            pending={decideVerification.pending}
            error={decideVerification.error}
            onClose={() => {
              setVerification(null);
              decideVerification.reset();
            }}
            onConfirm={(reason) => verification && void decideVerification.run({ decision: verification, reason })}
          />
          <ConfirmDialog
            open={suspension !== null}
            title={suspension ? '利用を停止しますか？' : '利用停止を解除しますか？'}
            description={suspension ? '停止中は案件の検索・受諾ができなくなります。進行中の業務は別途確認してください。' : '利用を再開できるようにします。'}
            confirmLabel={suspension ? '停止する' : '解除する'}
            tone={suspension ? 'danger' : 'primary'}
            requireReason
            pending={setSuspended.pending}
            error={setSuspended.error}
            onClose={() => {
              setSuspension(null);
              setSuspended.reset();
            }}
            onConfirm={(reason) => suspension !== null && void setSuspended.run({ suspended: suspension, reason })}
          />
          <ConfirmDialog
            open={!!skill}
            title={skill ? `「${skill.name}」を${skill.decision === 'verified' ? '確認済みにしますか' : '却下しますか'}？` : ''}
            description={skill?.decision === 'verified' ? '資格証の記載（氏名・種類・有効期限）を確認してください。' : '却下理由は利用者に通知されます。'}
            confirmLabel={skill?.decision === 'verified' ? '確認済みにする' : '却下する'}
            tone={skill?.decision === 'verified' ? 'success' : 'danger'}
            requireReason
            extraError={validUntilError}
            pending={decideSkill.pending}
            error={decideSkill.error}
            onClose={() => {
              setSkill(null);
              decideSkill.reset();
            }}
            onConfirm={(reason) =>
              skill && void decideSkill.run({ code: skill.code, decision: skill.decision, reason, validUntil: skill.decision === 'verified' ? validUntil || undefined : undefined })
            }
          >
            {skill?.decision === 'verified' ? (
              <Field label="有効期限（任意）" hint="資格証に記載の有効期限。期限後は自動で期限切れになります。" error={validUntilError}>
                {(p) => <input {...p} className="hd-input" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />}
              </Field>
            ) : null}
          </ConfirmDialog>
        </>
      )}
    </AsyncView>
  );
}
