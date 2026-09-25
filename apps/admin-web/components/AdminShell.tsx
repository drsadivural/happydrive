'use client';
import { useState, type ReactNode } from 'react';
import { postAuth } from '@happydrive/web-ui/client/api';
import { userRoleLabel } from '@happydrive/web-ui/labels';
import { Alert, AppShell, Button, StatusPill, type NavItem } from '@happydrive/web-ui/components';
import { AdminProvider, useAdmin } from '@/lib/admin-context';
import { COOKIE_PREFIX } from '@/lib/config';

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'ダッシュボード' },
  { href: '/users', label: '利用者審査' },
  { href: '/organizations', label: '組織審査' },
  { href: '/jobs', label: '案件審査' },
  { href: '/assignments', label: '業務監視・紛争' },
  { href: '/reports', label: '通報' },
  { href: '/support', label: '問い合わせ' },
  { href: '/payouts', label: '振込' },
  { href: '/reconciliation', label: '決済照合' },
  { href: '/audit', label: '監査ログ' },
  { href: '/matching', label: 'マッチング監査' },
  { href: '/deletion-requests', label: '削除要求' },
];

async function logout() {
  try {
    await postAuth(COOKIE_PREFIX, '/api/auth/logout', {});
  } finally {
    // クライアント状態を残さないよう完全に再読み込みする
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/login');
  }
}

function LogoutButton() {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      loading={pending}
      onClick={() => {
        setPending(true);
        void logout();
      }}
    >
      ログアウト
    </Button>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { me, readOnly } = useAdmin();
  return (
    <AppShell
      brandSub="運営管理"
      nav={NAV}
      contextBar={
        <div className="hd-row">
          <strong>{me.displayName}</strong>
          {(me.roles ?? [])
            .filter((r) => r.startsWith('admin_'))
            .map((r) => (
              <StatusPill key={r} status={userRoleLabel(r)} soft />
            ))}
        </div>
      }
      sidebarFooter={
        <>
          <span>{me.displayName}</span>
          <LogoutButton />
        </>
      }
    >
      {readOnly ? (
        <Alert tone="blue" title="閲覧専用（監査ロール）">
          このアカウントでは審査・裁定・振込などの変更操作は表示されません。
        </Alert>
      ) : null}
      {children}
    </AppShell>
  );
}

function Forbidden() {
  return (
    <div className="hd-auth">
      <div className="hd-auth-card">
        <section className="hd-card hd-stack">
          <h1 style={{ fontSize: 22 }}>権限がありません</h1>
          <p style={{ margin: 0 }}>このアカウントには運営管理（運営・サポート・監査）の権限がありません。</p>
          <LogoutButton />
        </section>
      </div>
    </div>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <AdminProvider forbidden={<Forbidden />}>
      <Shell>{children}</Shell>
    </AdminProvider>
  );
}
