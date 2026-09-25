import type { AppContext, AuthUser } from '../context.js';
import { forbidden, notFound } from '../lib/errors.js';

export type OrgRole = 'owner' | 'manager' | 'reviewer';

export const isAdmin = (u: AuthUser) => u.roles.some((r) => r.startsWith('admin_'));

export type AdminCapability = 'read' | 'support' | 'operate';
const ADMIN_CAPS: Record<string, AdminCapability[]> = {
  admin_operator: ['read', 'support', 'operate'],
  admin_support: ['read', 'support'],
  admin_auditor: ['read'],
};

export function requireAdmin(u: AuthUser, cap: AdminCapability): void {
  if (!u.roles.some((r) => ADMIN_CAPS[r]?.includes(cap))) throw forbidden();
}

export function requireWorker(u: AuthUser): void {
  if (!u.roles.includes('worker')) throw forbidden('ドライバーアカウントでのみ利用できます');
}

/**
 * Organisation boundary: returns the caller's role in the org or throws 404 (not 403) so that
 * the existence of other organisations' resources is not revealed.
 */
export async function requireOrgRole(ctx: AppContext, u: AuthUser, orgId: string, allowed: OrgRole[]): Promise<OrgRole> {
  const r = await ctx.db.query<{ role: OrgRole }>('SELECT role FROM organization_members WHERE org_id = $1 AND user_id = $2', [orgId, u.id]);
  const role = r.rows[0]?.role;
  if (!role) throw notFound();
  if (!allowed.includes(role)) throw forbidden();
  return role;
}

export const ORG_ALL: OrgRole[] = ['owner', 'manager', 'reviewer'];
export const ORG_EDITORS: OrgRole[] = ['owner', 'manager'];
export const ORG_OWNER: OrgRole[] = ['owner'];
