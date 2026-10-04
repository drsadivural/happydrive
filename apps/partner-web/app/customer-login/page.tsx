'use client';
import Link from 'next/link';
import { GoogleSignIn } from '@/components/google-sign-in';
import { useState, useSyncExternalStore } from 'react';
import { postAuth } from '@happydrive/web-ui/client/api';
import { COOKIE_PREFIX } from '@/lib/config';

const subscribe=()=>()=>{};
export default function CustomerLogin() {
  const ready=useSyncExternalStore(subscribe,()=>true,()=>false);
  const linking=ready && new URLSearchParams(window.location.search).get('link')==='phone';
  const [phone,setPhone]=useState('');const [code,setCode]=useState('');const [sent,setSent]=useState(false);
  const [pending,setPending]=useState(false);const [error,setError]=useState('');const [resendAt,setResendAt]=useState(0);
  async function submit(e:React.FormEvent) {
    e.preventDefault();setPending(true);setError('');
    try {
      if (sent) {
        await postAuth(COOKIE_PREFIX,linking?'/api/auth/phone/link':'/api/auth/otp/verify',{phone,code});
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign('/marketplace');
      } else {
        const r=await postAuth<{resendAfterSeconds:number}>(COOKIE_PREFIX,'/api/auth/otp/request',{phone});
        setSent(true);setResendAt(Date.now()+r.resendAfterSeconds*1000);
      }
    } catch(e) { setError(e instanceof Error?e.message:'接続を確認して再試行してください'); }
    finally {setPending(false);}
  }
  return <main className="hd-container" style={{maxWidth:480,padding:'64px 24px'}}>
    <p className="hd-muted">HappyDrive</p><h1>暮らしの支援を、もっと身近に。</h1>
    <p>{linking?'現在のアカウントの電話番号を確認します。':'Gmail・Google、または電話番号でログイン・新規登録できます。'}</p>
    {!linking && <GoogleSignIn />}
    <form onSubmit={submit} className="hd-stack">
      <label>電話番号<input className="hd-input" type="tel" autoComplete="tel" required value={phone} disabled={!ready || sent || pending} onChange={e=>setPhone(e.target.value.replace(/[ -]/g,''))} placeholder="09012345678" /></label>
      {sent && <label>SMSの6桁の確認コード<input className="hd-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={e=>setCode(e.target.value)} /></label>}
      {error && <p role="alert">{error}</p>}
      <button className="hd-button" disabled={!ready || pending}>{pending?'確認中…':sent?'ログイン':'確認コードを送信'}</button>
      {sent && <button type="button" className="hd-button" disabled={!ready || pending} onClick={()=>{if(Date.now()<resendAt){setError('再送信まで少しお待ちください');return;}setSent(false);setCode('');}}>番号の変更・再送信</button>}
    </form><p><Link href="/login">供給者・企業のログイン</Link></p>
  </main>;
}
