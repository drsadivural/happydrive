'use client';
import QRCode from 'qrcode';
import {useEffect,useState} from 'react';
export function QrCode({value,label}:{value:string;label:string}){
 const [image,setImage]=useState<{value:string;url:string}|null>(null);
 useEffect(()=>{let active=true;QRCode.toDataURL(value,{errorCorrectionLevel:'M',margin:4,width:360}).then(url=>{if(active)setImage({value,url});}).catch(()=>{if(active)setImage(null);});return()=>{active=false;};},[value]);
 // eslint-disable-next-line @next/next/no-img-element
 return image?.value===value?<img src={image.url} alt={label} width={280} height={280} style={{maxWidth:'100%',height:'auto'}}/>:<p role="status">QRを作成しています…</p>;
}
