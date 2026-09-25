import 'server-only';
import { createAuthHandlers } from '@happydrive/web-ui/bff/auth-handlers';
import { ADMIN_ROLES } from '@/lib/config';
import { SESSION } from '@/lib/session';

/** 運営ロールを持たない利用者にはセッションを発行しない */
export const auth = createAuthHandlers({
  session: SESSION,
  requiredRoles: ADMIN_ROLES,
  requiredRolesMessage: 'このアカウントには運営管理の権限がありません。',
});
