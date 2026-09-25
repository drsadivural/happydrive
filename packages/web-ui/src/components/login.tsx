'use client';
import Link from 'next/link';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { postAuth } from '../client/api';
import { safeNextPath } from '../nav';
import { Alert, Button, ErrorAlert, Field } from './ui';

interface Challenge {
  mfaEnrollmentRequired: boolean;
  totpUri: string | null;
}

/** otpauth:// URI から手入力用のシークレットを取り出す */
export function secretFromTotpUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const u = new URL(uri);
    if (u.protocol !== 'otpauth:') return null;
    return u.searchParams.get('secret');
  } catch {
    return null;
  }
}

function formatSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export interface LoginFlowProps {
  cookiePrefix: string;
  appName: string;
  mode: 'login' | 'signup';
  defaultNext: string;
  signupHref?: string;
  loginHref?: string;
  notice?: string;
}

/**
 * メール + パスワード → TOTP（初回は QR 登録）。トークンは BFF が httpOnly Cookie に保存し、この画面には渡らない。
 */
export function LoginFlow({ cookiePrefix, appName, mode, defaultNext, signupHref, loginHref, notice }: LoginFlowProps) {
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const uri = challenge?.totpUri;
    if (!uri) return;
    QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 440 }).then(
      (url) => {
        if (!cancelled) setQr(url);
      },
      () => {
        if (!cancelled) setQr(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [challenge?.totpUri]);

  function validateCredentials(): boolean {
    const errs: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = 'メールアドレスの形式が正しくありません。';
    if (mode === 'signup') {
      if (password.length < 12) errs.password = 'パスワードは12文字以上で入力してください。';
      else if (password.length > 200) errs.password = 'パスワードは200文字以内で入力してください。';
      if (!displayName.trim()) errs.displayName = '担当者名を入力してください。';
      else if (displayName.trim().length > 60) errs.displayName = '担当者名は60文字以内で入力してください。';
    } else if (!password) {
      errs.password = 'パスワードを入力してください。';
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function submitCredentials(e: FormEvent) {
    e.preventDefault();
    if (pending || !validateCredentials()) return;
    setPending(true);
    setError(null);
    try {
      const body = mode === 'signup' ? { email: email.trim(), password, displayName: displayName.trim() } : { email: email.trim(), password };
      const c = await postAuth<Challenge>(cookiePrefix, mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', body);
      setChallenge(c);
      setQr(null);
      setStep('mfa');
      setPassword('');
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!/^[0-9]{6}$/.test(code)) {
      setFieldErrors({ code: '認証アプリに表示された6桁の数字を入力してください。' });
      return;
    }
    setFieldErrors({});
    setPending(true);
    setError(null);
    try {
      await postAuth(cookiePrefix, '/api/auth/mfa', { code });
      const next = safeNextPath(new URLSearchParams(window.location.search).get('next'), defaultNext);
      window.location.assign(next === '/login' || next.startsWith('/login?') ? defaultNext : next);
    } catch (err) {
      setError(err);
      setPending(false);
    }
  }

  const secret = secretFromTotpUri(challenge?.totpUri);

  return (
    <div className="hd-auth">
      <div className="hd-auth-card">
        <div className="hd-auth-brand">
          <div className="hd-brand">HappyDrive</div>
          <div>{appName}</div>
        </div>
        <section className="hd-card">
          {step === 'credentials' ? (
            <form className="hd-form" onSubmit={submitCredentials} noValidate>
              <h1 style={{ fontSize: 22 }}>{mode === 'signup' ? 'アカウント作成' : 'ログイン'}</h1>
              {notice ? <Alert tone="orange">{notice}</Alert> : null}
              {mode === 'signup' ? (
                <Field label="担当者名" required error={fieldErrors.displayName}>
                  {(p) => <input {...p} className="hd-input" autoComplete="name" value={displayName} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} />}
                </Field>
              ) : null}
              <Field label="メールアドレス" required error={fieldErrors.email}>
                {(p) => (
                  <input {...p} className="hd-input" type="email" autoComplete="username" inputMode="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
                )}
              </Field>
              <Field label="パスワード" required error={fieldErrors.password} hint={mode === 'signup' ? '12文字以上' : undefined}>
                {(p) => (
                  <input
                    {...p}
                    className="hd-input"
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    value={password}
                    maxLength={200}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
              <ErrorAlert error={error} title={mode === 'signup' ? '登録できませんでした' : 'ログインできませんでした'} />
              <Button type="submit" variant="primary" loading={pending}>
                {mode === 'signup' ? '登録して二段階認証へ' : '次へ'}
              </Button>
              {mode === 'login' && signupHref ? (
                <p className="hd-small hd-muted" style={{ margin: 0 }}>
                  アカウントをお持ちでない場合は <Link href={signupHref}>新規登録</Link>
                </p>
              ) : null}
              {mode === 'signup' && loginHref ? (
                <p className="hd-small hd-muted" style={{ margin: 0 }}>
                  登録済みの場合は <Link href={loginHref}>ログイン</Link>
                </p>
              ) : null}
            </form>
          ) : (
            <form className="hd-form" onSubmit={submitCode} noValidate>
              <h1 style={{ fontSize: 22 }}>二段階認証</h1>
              {challenge?.mfaEnrollmentRequired ? (
                <>
                  <p style={{ margin: 0 }}>
                    認証アプリ（Google Authenticator、Microsoft Authenticator など）で次のQRコードを読み取り、表示された6桁のコードを入力してください。
                  </p>
                  <div className="hd-qr">
                    {qr ? (
                      // eslint-disable-next-line @next/next/no-img-element -- data URL の QR 画像
                      <img src={qr} alt="二段階認証の登録用QRコード" />
                    ) : (
                      <span className="hd-muted">QRコードを表示できません。下のキーを手入力してください。</span>
                    )}
                  </div>
                  {secret ? (
                    <div>
                      <div className="hd-label">手入力用のキー</div>
                      <div className="hd-mono" aria-label="手入力用のキー">
                        {formatSecret(secret)}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <p style={{ margin: 0 }}>認証アプリに表示されている6桁のコードを入力してください。</p>
              )}
              <Field label="確認コード" required error={fieldErrors.code}>
                {(p) => (
                  <input
                    {...p}
                    className="hd-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                )}
              </Field>
              <ErrorAlert error={error} title="確認できませんでした" />
              <Button type="submit" variant="primary" loading={pending}>
                確認してログイン
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setStep('credentials');
                  setCode('');
                  setChallenge(null);
                  setError(null);
                }}
              >
                最初からやり直す
              </Button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
