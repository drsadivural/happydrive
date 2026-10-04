'use client';
import {useEffect,useRef,useState} from 'react';
import {QrCode} from '@happydrive/web-ui/components';
import {marketplaceFetch as api} from '@/lib/marketplace';
type Token={requestId:string;token:string;expiresAt:string};
export function CompletionConfirmation({requestId}:{requestId:string}){
 const [token,setToken]=useState<Token|null>(null);const [now,setNow]=useState(()=>Date.now());const [busy,setBusy]=useState(false);const [error,setError]=useState('');const key=useRef<string|null>(null);
 useEffect(()=>{const interval=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(interval);},[]);
 const seconds=token?Math.max(0,Math.ceil((Date.parse(token.expiresAt)-now)/1000)):0;
 async function issue(){if(busy)return;setBusy(true);setError('');key.current??=crypto.randomUUID();try{const result=await api<Token>(`/requests/${requestId}/completion-token`,'POST',undefined,key.current);setToken(result);setNow(Date.now());key.current=null;}catch(e){setError(e instanceof Error?e.message:'QRを表示できませんでした');}finally{setBusy(false);}}
 return <section className="mp-card"><h3>作業の完了確認</h3><p>作業内容を確認してから、対面で担当者にQRを提示してください。</p>{token&&seconds>0&&<><QrCode value={JSON.stringify({requestId:token.requestId,token:token.token})} label="担当者に提示する完了確認QR"/><p aria-live="off">有効期限まで {seconds}秒</p></>}{token&&seconds===0&&<p role="status">QRの有効期限が切れました。もう一度表示してください。</p>}{error&&<p role="alert">{error}</p>}<button className="mp-button" disabled={busy} onClick={()=>void issue()}>{token?'完了QRを再発行':'確認して完了QRを表示'}</button></section>;
}
