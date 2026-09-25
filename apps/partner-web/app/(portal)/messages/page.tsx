'use client';
import Link from 'next/link';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { formatRangeJst } from '@happydrive/web-ui/format';
import { assignmentStateLabel } from '@happydrive/web-ui/labels';
import { AsyncView, Card, EmptyState, PageHeader, StatusPill } from '@happydrive/web-ui/components';
import { api, unwrap } from '@/lib/api';
import { useCurrentOrg } from '@/lib/org-context';

const HIDDEN_STATES = new Set(['declined', 'expired']);

export default function MessagesPage() {
  const { org } = useCurrentOrg();
  const q = useQuery(`org-assignments:${org.id}:all`, () =>
    unwrap(api.GET('/organizations/{organizationId}/assignments', { params: { path: { organizationId: org.id } } })),
  );
  return (
    <>
      <PageHeader title="メッセージ" description="案件ごとにドライバーと連絡できます。電話番号は互いに公開されません。" />
      <Card>
        <AsyncView
          state={q}
          isEmpty={(items) => items.filter((a) => !HIDDEN_STATES.has(a.state)).length === 0}
          empty={<EmptyState title="メッセージできる案件はありません">ドライバーが受諾した案件ごとにメッセージを送れます。</EmptyState>}
        >
          {(items) => (
            <ul className="hd-stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 0 }}>
              {items
                .filter((a) => !HIDDEN_STATES.has(a.state))
                .sort((a, b) => Date.parse(b.job?.startsAt ?? '') - Date.parse(a.job?.startsAt ?? ''))
                .map((a) => (
                  <li key={a.id} style={{ borderBottom: '1px solid var(--hd-border)' }}>
                    <Link href={`/messages/${a.id}`} className="hd-row" style={{ padding: '14px 4px', textDecoration: 'none', color: 'inherit', justifyContent: 'space-between' }}>
                      <span>
                        <strong>{a.job?.title ?? '案件'}</strong>
                        <span className="hd-muted"> ・ {a.workerDisplayName ?? 'ドライバー'}</span>
                        <div className="hd-small hd-muted">{formatRangeJst(a.job?.startsAt, a.job?.endsAt)}</div>
                      </span>
                      <StatusPill status={assignmentStateLabel(a.state)} soft />
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </AsyncView>
      </Card>
    </>
  );
}
