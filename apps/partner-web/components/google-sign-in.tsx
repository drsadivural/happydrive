'use client';
import Script from 'next/script';
import { useRef, useState, useSyncExternalStore } from 'react';
import { postAuth } from '@happydrive/web-ui/client/api';
import { COOKIE_PREFIX } from '@/lib/config';

type GoogleIdentity = {
  initialize(options:{client_id:string;nonce:string;auto_select:boolean;callback:(data:{credential:string})=>void}):void;
  renderButton(element:HTMLElement,options:{theme:string;size:string;locale:string;text:string}):void;
};
const hydrationSubscribe=()=>()=>{};
const clientReady=()=>true;
const serverReady=()=>false;
export function GoogleSignIn({link = false}:{link?:boolean}) {
  const ready=useSyncExternalStore(hydrationSubscribe,clientReady,serverReady);
  const target=useRef<HTMLDivElement>(null);const [active,setActive]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [retry,setRetry]=useState(0);
  async function initialize() {
    try {
      const g=(window as unknown as {google?:{accounts:{id:GoogleIdentity}}}).google?.accounts.id;
      if(!g || !target.current) return;
      const c=await postAuth<{clientId:string;nonce:string}>(COOKIE_PREFIX,'/api/auth/google/challenge',{link});
      g.initialize({client_id:c.clientId,nonce:c.nonce,auto_select:false,callback:({credential})=>{
        setBusy(true);setError('');
        void postAuth<{mfaRequired?:boolean}>(COOKIE_PREFIX,'/api/auth/google/verify',{idToken:credential}).then((result)=>{
          window.location.assign(result.mfaRequired?'/login?google=mfa':'/marketplace');
        }).catch((e:unknown)=>{setBusy(false);setError(e instanceof Error?e.message:'Googleログインをもう一度お試しください');});
      }});
      target.current.replaceChildren();g.renderButton(target.current,{theme:'outline',size:'large',locale:'ja',text:link?'continue_with':'signin_with'});
    } catch(e) {setError(e instanceof Error?e.message:'Googleログインを読み込めませんでした');}
  }
  return <section aria-label={link?'Googleアカウントの連携':'Googleでログイン'}>
    {!active && <button type="button" className="hd-button" disabled={!ready} onClick={()=>setActive(true)}>{link?'Googleアカウントを連携':'Gmail・Googleでログイン'}</button>}
    {active && <Script key={retry} src="https://accounts.google.com/gsi/client" onReady={()=>void initialize()} onError={()=>setError('Googleに接続できませんでした。再試行してください。')} />}
    <div ref={target} aria-busy={busy} style={{pointerEvents:busy?'none':undefined}} />
    {busy && <p role="status">確認中…</p>}
    {error && <><p role="alert">{error}</p><button type="button" className="hd-button" onClick={()=>{setError('');setRetry(r=>r+1);}}>再試行</button></>}
  </section>;
}
