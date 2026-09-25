import { createApiProxy } from '@happydrive/web-ui/bff/proxy-handler';
import { PARTNER_API_RULES } from '@/lib/allowlist';
import { SESSION } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, PATCH, DELETE } = createApiProxy({ rules: PARTNER_API_RULES, session: SESSION });
