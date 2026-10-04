import { CSRF_HEADER, readCsrfToken } from '@happydrive/web-ui/client/api';
import { COOKIE_PREFIX } from './config';

export const requestStatuses:Record<string,string>={open:'供給者を探しています',accepted:'受諾済み',en_route:'移動中',arrived:'到着',in_progress:'作業中',awaiting_customer_confirmation:'完了確認待ち',completed:'完了',cancelled:'キャンセル',disputed:'サポート対応中',resolved_completed:'完了として解決',resolved_cancelled:'取消として解決'};
export const nextStatuses:Record<string,string>={accepted:'en_route',en_route:'arrived',arrived:'in_progress',in_progress:'awaiting_customer_confirmation'};
export type Service={id:string;name:string;category:string;description:string;areaCodes:string[];durationMinutes:number;pricePolicy:string;supplierName?:string;status?:string};
export type RequestSummary={id:string;title:string;status?:string;serviceName:string;areaCode:string;startsAt:string;endsAt:string};
export type RequestDetail=RequestSummary&{status:string;customerId:string;staffId:string|null;details:string;address:string;supplierName:string|null};
export type MarketplaceAccount={userId:string;profile:{familyName:string;givenName:string}|null;roles:string[];suppliers:{id:string;legalName:string;role:string;reviewStatus:string}[];subscription:{planCode:string;status:string;trialEndsAt:string|null}|null};
export async function marketplaceFetch<T>(path:string,method='GET',body?:unknown,key?:string):Promise<T>{
  const res=await fetch('/api/hd/marketplace'+path,{method,credentials:'same-origin',cache:'no-store',headers:method==='GET'?{}:{'content-type':'application/json',[CSRF_HEADER]:readCsrfToken(COOKIE_PREFIX)??'','idempotency-key':key??crypto.randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await res.json();if(!res.ok)throw new Error(data.message??'通信に失敗しました');return data as T;
}
