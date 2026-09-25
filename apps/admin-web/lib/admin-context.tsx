'use client';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { components } from '@happydrive/contracts';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { ErrorState, LoadingState } from '@happydrive/web-ui/components';
import { api, unwrap } from './api';
import { ADMIN_ROLES, WRITE_ROLES } from './config';

type Me = components['schemas']['User'];

export interface AdminContextValue {
  me: Me;
  /** 変更操作が可能（operator / support） */
  canWrite: boolean;
  /** 監査ロールのみ（閲覧専用） */
  readOnly: boolean;
  isOperator: boolean;
}

const Ctx = createContext<AdminContextValue | null>(null);

export function hasAdminRole(roles: readonly string[] | undefined): boolean {
  return !!roles?.some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
}
export function canWriteWith(roles: readonly string[] | undefined): boolean {
  return !!roles?.some((r) => (WRITE_ROLES as readonly string[]).includes(r));
}

export function AdminProvider({ children, forbidden }: { children: ReactNode; forbidden: ReactNode }) {
  const q = useQuery('me', () => unwrap(api.GET('/me')));
  const value = useMemo<AdminContextValue | null>(() => {
    if (!q.data) return null;
    const canWrite = canWriteWith(q.data.roles);
    return { me: q.data, canWrite, readOnly: !canWrite, isOperator: !!q.data.roles?.includes('admin_operator') };
  }, [q.data]);
  if (!q.data) {
    if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
    return <LoadingState label="権限を確認しています…" />;
  }
  if (!hasAdminRole(q.data.roles)) return <>{forbidden}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin(): AdminContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAdmin must be used inside AdminProvider');
  return v;
}
