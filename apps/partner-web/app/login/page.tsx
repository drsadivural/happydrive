import { cookies } from 'next/headers';
import { cookieNames } from '@happydrive/web-ui/bff/session';
import { SESSION } from '@/lib/session';
import { GoogleSignIn } from '@/components/google-sign-in';
import type { Metadata } from 'next';
import { LoginFlow } from '@happydrive/web-ui/components';
import { APP_NAME, COOKIE_PREFIX, HOME_PATH } from '@/lib/config';

export const metadata: Metadata = { title: 'ログイン' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const sp = await searchParams;
  const initialMfa=sp.google==='mfa' && !!(await cookies()).get(cookieNames(SESSION).mfa);
  const expired = sp.reason === 'expired';
  return (
    <>
    {!initialMfa && <div className="hd-container" style={{maxWidth:480,paddingTop:24}}><GoogleSignIn /></div>}
    <LoginFlow
      initialMfa={initialMfa}
      cookiePrefix={COOKIE_PREFIX}
      appName={APP_NAME}
      mode="login"
      defaultNext={HOME_PATH}
      signupHref="/signup"
      notice={expired ? 'ログインの有効期限が切れました。再度ログインしてください。' : undefined}
    />
    </>
  );
}
