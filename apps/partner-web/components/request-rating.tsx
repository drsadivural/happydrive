'use client';
import {useEffect,useState} from 'react';
import {marketplaceFetch as api} from '@/lib/marketplace';
export function RequestRating({requestId,canRate}:{requestId:string;canRate:boolean}){
 const [rating,setRating]=useState<{score:number;comment:string|null}|null>(null);const [score,setScore]=useState(5);const [comment,setComment]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 useEffect(()=>{void api<{rating:typeof rating}>('/requests/'+requestId+'/rating').then(r=>setRating(r.rating)).catch(e=>setError(e.message));},[requestId]);
 return <section><h3>サービスの評価</h3>{error&&<p role="alert">{error}</p>}{rating?<p>{rating.score} / 5 · {rating.comment}</p>:canRate?<form className="hd-stack" onSubmit={async e=>{e.preventDefault();setBusy(true);try{await api('/requests/'+requestId+'/rating','POST',{score,comment});setRating({score,comment});}catch(e){setError(e instanceof Error?e.message:'保存できませんでした');}finally{setBusy(false);}}}><label>評価<select className="hd-select" value={score} onChange={e=>setScore(Number(e.target.value))}>{[5,4,3,2,1].map(n=><option key={n} value={n}>{n} / 5</option>)}</select></label><label>コメント（任意）<textarea className="hd-input" maxLength={1000} value={comment} onChange={e=>setComment(e.target.value)}/></label><button className="mp-button" disabled={busy}>評価を送信</button></form>:<p>評価はまだありません。</p>}</section>;
}
