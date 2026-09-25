import 'server-only';
import { createAuthHandlers } from '@happydrive/web-ui/bff/auth-handlers';
import { SESSION } from '@/lib/session';

export const auth = createAuthHandlers({ session: SESSION });
