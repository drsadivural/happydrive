import type { NextRequest } from 'next/server';
import { auth } from '../handlers';

export const dynamic = 'force-dynamic';

export function POST(req: NextRequest) {
  return auth.logout(req);
}
