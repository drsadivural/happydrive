'use client';
import { useState, type FormEvent } from 'react';
import type { components } from '@happydrive/contracts';
import { useMutation, useQuery } from '@happydrive/web-ui/client/hooks';
import { AsyncView, Button, Card, ConfirmDialog, EmptyState, ErrorAlert, Field, PageHeader } from '@happydrive/web-ui/components';
import { LocationFields } from '@/components/LocationFields';
import { api, unwrap } from '@/lib/api';
import { EMPTY_SITE_FORM as EMPTY, validateSite, type SiteFormState } from '@/lib/site-form';
import { useCurrentOrg } from '@/lib/org-context';

type Site = components['schemas']['Site'];
type SiteInput = components['schemas']['SiteInput'];


function SiteEditor({
  initial,
  editingId,
  orgId,
  onDone,
}: {
  initial: SiteFormState;
  editingId: string | null;
  orgId: string;
  onDone: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation(
    'site-save',
    async (body: SiteInput, key: string) =>
      editingId
        ? unwrap(api.PUT('/organizations/{organizationId}/sites/{siteId}', { params: { path: { organizationId: orgId, siteId: editingId } }, body }))
        : unwrap(api.POST('/organizations/{organizationId}/sites', { params: { path: { organizationId: orgId }, header: { 'Idempotency-Key': key } }, body })),
    { onSuccess: onDone },
  );
  const set = <K extends keyof SiteFormState>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = validateSite(form);
    setErrors(r.errors);
    if (r.value) void save.run(r.value);
  }

  return (
    <form className="hd-form" onSubmit={submit} noValidate>
      <div className="hd-grid-2">
        <Field label="拠点名" required error={errors.name}>
          {(p) => <input {...p} className="hd-input" value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />}
        </Field>
        <Field label="公開用の地域名" required error={errors.areaLabel} hint="ドライバーに公開される粗い地域名（例 横浜市中区）">
          {(p) => <input {...p} className="hd-input" value={form.areaLabel} maxLength={40} onChange={(e) => set('areaLabel', e.target.value)} />}
        </Field>
      </div>
      <Field label="住所" required error={errors.address} hint="受諾者と自組織のみ閲覧できます">
        {(p) => <input {...p} className="hd-input" value={form.address} maxLength={200} onChange={(e) => set('address', e.target.value)} />}
      </Field>
      <LocationFields
        address={form.address}
        latitude={form.latitude}
        longitude={form.longitude}
        errors={errors}
        onChange={(lat, lng) => setForm((f) => ({ ...f, latitude: lat, longitude: lng }))}
      />
      <ErrorAlert error={save.error} title="保存できませんでした" />
      <div className="hd-actions">
        <Button type="submit" variant="primary" loading={save.pending}>
          {editingId ? '更新する' : '登録する'}
        </Button>
        <Button onClick={onDone} disabled={save.pending}>
          キャンセル
        </Button>
      </div>
    </form>
  );
}

export default function SitesPage() {
  const { org } = useCurrentOrg();
  const q = useQuery(`sites:${org.id}`, () => unwrap(api.GET('/organizations/{organizationId}/sites', { params: { path: { organizationId: org.id } } })));
  const [editor, setEditor] = useState<{ id: string | null; initial: SiteFormState; seq: number } | null>(null);
  const [deleting, setDeleting] = useState<Site | null>(null);
  const del = useMutation(
    'site-delete',
    (id: string) => unwrap(api.DELETE('/organizations/{organizationId}/sites/{siteId}', { params: { path: { organizationId: org.id, siteId: id } } })),
    {
      onSuccess: () => {
        setDeleting(null);
        q.reload();
      },
    },
  );

  return (
    <>
      <PageHeader
        title="拠点"
        description="案件の実施場所として繰り返し使う住所・位置を登録します。案件作成時に選択すると住所・位置・地域名が入力されます。"
        actions={
          <Button variant="primary" onClick={() => setEditor({ id: null, initial: EMPTY, seq: Date.now() })}>
            拠点を追加
          </Button>
        }
      />
      {editor ? (
        <Card title={editor.id ? '拠点の編集' : '拠点の追加'}>
          <SiteEditor
            key={editor.seq}
            initial={editor.initial}
            editingId={editor.id}
            orgId={org.id}
            onDone={() => {
              setEditor(null);
              q.reload();
            }}
          />
        </Card>
      ) : null}
      <Card title="登録済みの拠点">
        <AsyncView state={q} empty={<EmptyState title="拠点はまだ登録されていません" />}>
          {(sites) => (
            <div className="hd-table-wrap">
              <table className="hd-table">
                <thead>
                  <tr>
                    <th scope="col">拠点名</th>
                    <th scope="col">住所</th>
                    <th scope="col">公開用の地域名</th>
                    <th scope="col">緯度・経度</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sites.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.name}</strong>
                      </td>
                      <td>{s.address}</td>
                      <td>{s.areaLabel}</td>
                      <td className="hd-mono">
                        {s.location.latitude}, {s.location.longitude}
                      </td>
                      <td>
                        <div className="hd-actions">
                          <Button
                            size="sm"
                            onClick={() =>
                              setEditor({
                                id: s.id,
                                seq: Date.now(),
                                initial: {
                                  name: s.name,
                                  address: s.address,
                                  areaLabel: s.areaLabel,
                                  latitude: String(s.location.latitude),
                                  longitude: String(s.location.longitude),
                                },
                              })
                            }
                          >
                            編集
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setDeleting(s)}>
                            削除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Card>
      <ConfirmDialog
        open={!!deleting}
        title="拠点を削除しますか？"
        description={deleting ? `「${deleting.name}」を削除します。作成済みの案件の住所・位置は変更されません。` : null}
        confirmLabel="削除する"
        tone="danger"
        pending={del.pending}
        error={del.error}
        onClose={() => {
          setDeleting(null);
          del.reset();
        }}
        onConfirm={() => deleting && void del.run(deleting.id)}
      />
    </>
  );
}
