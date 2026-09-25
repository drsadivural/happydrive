'use client';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { components } from '@happydrive/contracts';
import { useQuery } from '@happydrive/web-ui/client/hooks';
import { ErrorState, LoadingState } from '@happydrive/web-ui/components';
import { api, unwrap } from './api';

export type Me = components['schemas']['User'];
export type OrgSummary = NonNullable<Me['organizations']>[number];

interface OrgContextValue {
  me: Me;
  orgs: OrgSummary[];
  /** 選択中の組織（未登録なら null） */
  org: OrgSummary | null;
  isApproved: boolean;
  isOwner: boolean;
  setOrgId: (id: string) => void;
  reloadMe: () => void;
}

const OrgContext = createContext<OrgContextValue | null>(null);
const STORAGE_KEY = 'hdp.selectedOrgId';

function readStoredOrgId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const meQuery = useQuery('me', () => unwrap(api.GET('/me')));
  const [selectedId, setSelectedId] = useState<string | null>(() => (typeof window === 'undefined' ? null : readStoredOrgId()));

  const setOrgId = useCallback((id: string) => {
    setSelectedId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ストレージ不可（プライベートモード等）でも選択は保持される
    }
  }, []);

  const value = useMemo<OrgContextValue | null>(() => {
    const me = meQuery.data;
    if (!me) return null;
    const orgs = me.organizations ?? [];
    const org = orgs.find((o) => o.id === selectedId) ?? orgs[0] ?? null;
    return {
      me,
      orgs,
      org,
      isApproved: org?.reviewStatus === 'approved',
      isOwner: org?.role === 'owner',
      setOrgId,
      reloadMe: meQuery.reload,
    };
  }, [meQuery.data, meQuery.reload, selectedId, setOrgId]);

  if (!value) {
    if (meQuery.error) return <ErrorState error={meQuery.error} onRetry={meQuery.reload} />;
    return <LoadingState label="アカウント情報を読み込み中…" />;
  }
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const v = useContext(OrgContext);
  if (!v) throw new Error('useOrg must be used inside OrgProvider');
  return v;
}

/** 組織が選択されている前提の画面用（未登録時はシェルがオンボーディングへ誘導する） */
export function useCurrentOrg(): OrgContextValue & { org: OrgSummary } {
  const v = useOrg();
  if (!v.org) throw new Error('organization is not selected');
  return v as OrgContextValue & { org: OrgSummary };
}
