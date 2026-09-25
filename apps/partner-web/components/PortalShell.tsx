'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { postAuth } from '@happydrive/web-ui/client/api';
import { orgReviewLabel } from '@happydrive/web-ui/labels';
import { Alert, AppShell, Button, LoadingState, StatusPill, type NavItem } from '@happydrive/web-ui/components';
import { COOKIE_PREFIX } from '@/lib/config';
import { OrgProvider, useOrg } from '@/lib/org-context';

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'ダッシュボード' },
  { href: '/jobs', label: '案件管理' },
  { href: '/matching', label: '応募・マッチング' },
  { href: '/assignments', label: '実施・検収' },
  { href: '/billing', label: '請求・支払' },
  { href: '/messages', label: 'メッセージ' },
  { href: '/sites', label: '拠点' },
  { href: '/settings', label: '組織・設定' },
];

function LogoutButton() {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      loading={pending}
      onClick={async () => {
        setPending(true);
        try {
          await postAuth(COOKIE_PREFIX, '/api/auth/logout', {});
        } finally {
          // ログアウト後はクライアント状態を残さないよう完全に再読み込みする
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign('/login');
        }
      }}
    >
      ログアウト
    </Button>
  );
}

function OrgSwitcher() {
  const { orgs, org, setOrgId } = useOrg();
  if (!org) return null;
  const status = orgReviewLabel(org.reviewStatus);
  return (
    <div className="hd-row">
      {orgs.length > 1 ? (
        <label className="hd-row">
          <span className="hd-small hd-muted">組織</span>
          <select className="hd-select" style={{ width: 'auto', minWidth: 200 }} value={org.id} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.legalName}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <strong>{org.legalName}</strong>
      )}
      <StatusPill status={status} soft />
    </div>
  );
}

function ReviewBanner() {
  const { org } = useOrg();
  const pathname = usePathname();
  if (!org || org.reviewStatus === 'approved' || pathname === '/onboarding') return null;
  const messages: Record<string, { tone: 'orange' | 'red'; title: string; body: string }> = {
    pending: {
      tone: 'orange',
      title: '組織は運営の審査中です',
      body: '承認されるまで案件の審査申請・公開はできません。拠点の登録や案件の下書き作成は可能です。',
    },
    rejected: {
      tone: 'red',
      title: '組織の登録が却下されました',
      body: '「組織・設定」で却下理由を確認し、登録内容を修正してください（修正後は再審査になります）。',
    },
    suspended: {
      tone: 'red',
      title: '組織は停止中です',
      body: '新しい案件の公開はできません。詳細は運営からの連絡をご確認ください。',
    },
  };
  const m = messages[org.reviewStatus] ?? { tone: 'orange' as const, title: '組織の審査状況を確認してください', body: '' };
  return (
    <Alert tone={m.tone} title={m.title}>
      {m.body}
    </Alert>
  );
}

function ShellBody({ children }: { children: ReactNode }) {
  const { me, org } = useOrg();
  const pathname = usePathname();
  const router = useRouter();
  const needsOnboarding = !org && pathname !== '/onboarding';

  useEffect(() => {
    if (needsOnboarding) router.replace('/onboarding');
  }, [needsOnboarding, router]);

  return (
    <AppShell
      brandSub="企業・自治体ポータル"
      nav={org ? NAV : [{ href: '/onboarding', label: '組織の登録' }]}
      contextBar={<OrgSwitcher />}
      sidebarFooter={
        <>
          <span>{me.displayName}</span>
          <LogoutButton />
        </>
      }
    >
      <ReviewBanner />
      {needsOnboarding ? <LoadingState label="組織の登録画面へ移動しています…" /> : children}
    </AppShell>
  );
}

export function PortalShell({ children }: { children: ReactNode }) {
  return (
    <OrgProvider>
      <ShellBody>{children}</ShellBody>
    </OrgProvider>
  );
}
