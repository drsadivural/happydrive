import type { Metadata } from 'next';
import { LoginFlow } from '@happydrive/web-ui/components';
import { APP_NAME, COOKIE_PREFIX } from '@/lib/config';

export const metadata: Metadata = { title: '新規登録' };

export default function SignupPage() {
  return <LoginFlow cookiePrefix={COOKIE_PREFIX} appName={APP_NAME} mode="signup" defaultNext="/onboarding" loginHref="/login" />;
}
