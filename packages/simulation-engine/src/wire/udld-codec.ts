import {udldMessageSchema} from '../protocols/udld-model';
import type {z} from 'zod';
import {concat,text,u16,u32,need,view} from './binary';
const snap=new Uint8Array([0xaa,0xaa,3,0,0,0x0c,1,0x11]);
// RFC 5171's final odd octet is the LOW octet of its word.
function sum(b:Uint8Array){let n=0;for(let i=0;i<b.length;i+=2)n+=i+1<b.length?(b[i]<<8)|b[i+1]:b[i];while(n>>>16)n=(n&65535)+(n>>>16);return ~n&65535;}
export function encodeUdld(input:z.infer<typeof udldMessageSchema>){
 const m=udldMessageSchema.parse(input);if(m.intervalMs%1000)throw new Error('UDLD message interval must be integral seconds.');const tlv=(t:number,b:Uint8Array)=>concat(u16(t),u16(4+b.length),b),pair=(p:{device:string;port:string})=>concat(u16(text(p.device).length),text(p.device),u16(text(p.port).length),text(p.port));
 const p=concat(new Uint8Array([0x20|{probe:1,echo:2,flush:3}[m.opcode],0,0,0]),tlv(1,text(m.device)),tlv(2,text(m.port)),...(m.opcode==='flush'?[]:[tlv(3,concat(u32(m.echoes.length),...m.echoes.map(pair)))]),tlv(4,new Uint8Array([m.intervalMs/1000])),tlv(6,text(m.device)));view(p).setUint16(2,sum(p));const b=concat(snap,p);if(b.length>1500)throw new Error('UDLD exceeds IEEE 802.3 length.');return {type:b.length,body:b};
}
export function decodeUdld(b:Uint8Array){
 need(b,0,12);if(snap.some((v,i)=>b[i]!==v)||b[8]>>>5!==1||![1,2,3].includes(b[8]&31)||b[9]&0xfc||sum(b.subarray(8)))throw new Error('Invalid UDLD SNAP/header/checksum.');const values=new Map<number,Uint8Array>(),v=view(b);let at=12;while(at<b.length){need(b,at,4);const t=v.getUint16(at),length=v.getUint16(at+2);if(length<4)throw new Error('Invalid UDLD TLV length.');need(b,at,length);if(values.has(t)&&t<=7)throw new Error('Duplicate UDLD TLV.');values.set(t,b.subarray(at+4,at+length));at+=length;}
 const string=(t:number)=>{const p=values.get(t);if(!p?.length||[...p].some(b=>b<32||b>126))throw new Error('Invalid UDLD ASCII identifier.');return new TextDecoder().decode(p);},interval=values.get(4);if(interval?.length!==1||!interval[0])throw new Error('Invalid UDLD message interval.');
 const echoes:{device:string;port:string}[]=[],echo=values.get(3);if((b[8]&31)!==3&&!echo)throw new Error('Missing UDLD Echo TLV.');if(echo){need(echo,0,4);const ev=view(echo),count=ev.getUint32(0);if(count>8)throw new Error('UDLD neighbor capacity exceeded.');let pos=4;for(let i=0;i<count;i++){need(echo,pos,2);const dl=ev.getUint16(pos);pos+=2;need(echo,pos,dl);const device=new TextDecoder('utf-8',{fatal:true}).decode(echo.subarray(pos,pos+dl));pos+=dl;need(echo,pos,2);const pl=ev.getUint16(pos);pos+=2;need(echo,pos,pl);const port=new TextDecoder('utf-8',{fatal:true}).decode(echo.subarray(pos,pos+pl));pos+=pl;if(!dl||!pl)throw new Error('Empty UDLD echo identity.');echoes.push({device,port});}if(pos!==echo.length)throw new Error('Invalid UDLD echo list length.');}
 return {version:1,opcode:['','probe','echo','flush'][b[8]&31],device:string(1),port:string(2),name:values.has(6)?string(6):undefined,intervalMs:interval[0]*1000,echoes};
}
