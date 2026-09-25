'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { formatDateTimeJst, formatNumber } from '@happydrive/web-ui/format';
import { userRoleLabel, verificationLabel } from '@happydrive/web-ui/labels';
import { AsyncView, Button, Card, EmptyState, PageHeader, StatusPill, Tabs } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';

type Filter = 'pending' | 'unsubmitted' | 'verified' | 'rejected' | 'all';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'pending', label: '審査待ち' },
  { value: 'unsubmitted', label: '未申請' },
  { value: 'verified', label: '確認済み' },
  { value: 'rejected', label: '却下' },
  { value: 'all', label: 'すべて' },
];

export default function UsersPage() {
  const [filter, setFilter] = useState<Filter>('pending');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useQuery(`admin-users:${filter}:${query}`, () =>
    unwrap(
      api.GET('/admin/users', {
        params: { query: { ...(filter === 'all' ? {} : { verificationStatus: filter }), ...(query ? { q: query } : {}) } },
      }),
    ),
  );

  return (
    <>
      <PageHeader title="利用者審査" description="本人確認・資格証の審査、利用停止を行います。" />
      <Card>
        <div className="hd-stack">
          <Tabs label="本人確認の状態" value={filter} onChange={setFilter} options={FILTERS} />
          <form
            className="hd-row"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setQuery(q.trim());
            }}
          >
            <label className="hd-visually-hidden" htmlFor="user-search">
              検索
            </label>
            <input id="user-search" className="hd-input" style={{ maxWidth: 360 }} placeholder="表示名・メールで検索" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit">検索</Button>
          </form>
          <AsyncView state={list} empty={<EmptyState title="該当する利用者はいません" />}>
            {(users) => (
              <div className="hd-table-wrap">
                <table className="hd-table">
                  <thead>
                    <tr>
                      <th scope="col">表示名</th>
                      <th scope="col">ロール</th>
                      <th scope="col">本人確認</th>
                      <th scope="col" className="hd-num">
                        資格確認待ち
                      </th>
                      <th scope="col">連絡先（マスク）</th>
                      <th scope="col">登録日時</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <Link className="hd-row-link" href={`/users/${u.id}`}>
                            {u.displayName}
                          </Link>
                          {u.suspended ? (
                            <div>
                              <StatusPill status={{ label: '利用停止中', tone: 'red' }} soft />
                            </div>
                          ) : null}
                          {u.deleted ? (
                            <div>
                              <StatusPill status={{ label: '削除済み', tone: 'gray' }} soft />
                            </div>
                          ) : null}
                        </td>
                        <td className="hd-small">{u.roles.map((r) => userRoleLabel(r).label).join('、')}</td>
                        <td>
                          <StatusPill status={verificationLabel(u.verificationStatus)} />
                        </td>
                        <td className="hd-num">{formatNumber(u.pendingSkillCount ?? 0)}</td>
                        <td className="hd-small">{u.phoneMasked ?? u.email ?? '—'}</td>
                        <td className="hd-small">{formatDateTimeJst(u.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </div>
      </Card>
    </>
  );
}
