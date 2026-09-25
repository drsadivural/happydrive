import 'server-only';
import { sessionConfig } from '@happydrive/web-ui/bff/session';
import { COOKIE_PREFIX } from './config';

export const SESSION = sessionConfig(COOKIE_PREFIX);
