import {CSRF_HEADER,readCsrfToken} from '@happydrive/web-ui/client/api';
import {COOKIE_PREFIX} from './config';
export async function appFetch<T>(path:string,method='GET',body?:unknown):Promise<T>{
 const res=await fetch('/api/hd'+path,{method,cache:'no-store',headers:method==='GET'?{}:{'content-type':'application/json',[CSRF_HEADER]:readCsrfToken(COOKIE_PREFIX)??'','idempotency-key':crypto.randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(res.status===204)return undefined as T;
 const data=await res.json();if(!res.ok)throw new Error(data.message??'通信に失敗しました');return data as T;
}
export async function uploadDocument(file:File):Promise<string>{
 if(!['image/jpeg','image/png'].includes(file.type)||file.size>15_000_000||file.size===0)throw new Error('15MB以内のJPEG・PNG画像を選択してください');
 const bytes=await file.arrayBuffer();const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
 const r=await appFetch<{evidenceId:string;uploadUrl:string;uploadHeaders:Record<string,string>}>('/evidence/uploads','POST',{purpose:'identity_document',contentType:file.type,byteSize:file.size,sha256});
 const uploaded=await fetch(r.uploadUrl,{method:'PUT',headers:r.uploadHeaders,body:bytes});if(!uploaded.ok)throw new Error('画像をアップロードできませんでした');
 await appFetch('/evidence/'+r.evidenceId+'/complete','POST',{});return r.evidenceId;
}
