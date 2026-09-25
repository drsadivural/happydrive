import type { Metadata } from 'next';
import { LoginFlow } from '@happydrive/web-ui/components';
import { APP_NAME, COOKIE_PREFIX, HOME_PATH } from '@/lib/config';

export const metadata: Metadata = { title: 'ログイン' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const sp = await searchParams;
  const expired = sp.reason === 'expired';
  return (
    <LoginFlow
      cookiePrefix={COOKIE_PREFIX}
      appName={APP_NAME}
      mode="login"
      defaultNext={HOME_PATH}
      signupHref="/signup"
      notice={expired ? 'ログインの有効期限が切れました。再度ログインしてください。' : undefined}
    />
  );
}
