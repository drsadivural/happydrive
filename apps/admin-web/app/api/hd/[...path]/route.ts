import { createApiProxy } from '@happydrive/web-ui/bff/proxy-handler';
import { ADMIN_API_RULES } from '@/lib/allowlist';
import { SESSION } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, PATCH, DELETE } = createApiProxy({ rules: ADMIN_API_RULES, session: SESSION });
