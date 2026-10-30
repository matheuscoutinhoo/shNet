import {lacpPduSchema,type LacpPdu} from '../protocols/lacp-model';
import {concat,hex,u16,need,view} from './binary';
const zero='00:00:00:00:00:00';
function identity(p:LacpPdu['actor']|undefined,type:number,state:number){
 if(p&&p.portNumber===undefined)throw new Error('Legacy LACP identity lacks numeric port metadata.');
 return concat(new Uint8Array([type,20]),u16(p?.systemPriority??32768),hex((p?.system??zero).replaceAll(':','')),u16(p?.key??0),u16(p?.portPriority??32768),u16(p?.portNumber??0),new Uint8Array([state,0,0,0]));
}
/** IEEE 802.1AX LACPDU, including Slow Protocols subtype/version. */
export function encodeLacp(input:LacpPdu){const p=lacpPduSchema.parse(input);if(p.actor.state===undefined)throw new Error('Legacy LACP identity lacks state metadata.');return concat(new Uint8Array([1,1]),identity(p.actor,1,p.actor.state),identity(p.partner,2,p.partner?.state??0),new Uint8Array([3,16,0,0]),new Uint8Array(12),new Uint8Array(52));}
export function decodeLacp(b:Uint8Array){
 need(b,0,110);if(b.length!==110||b[0]!==1||b[1]!==1||b[2]!==1||b[3]!==20||b[22]!==2||b[23]!==20||b[42]!==3||b[43]!==16||b[58]!==0||b[59]!==0)throw new Error('Invalid LACPDU TLV header or length.');const v=view(b),part=(at:number)=>({systemPriority:v.getUint16(at+2),system:[...b.subarray(at+4,at+10)].map(n=>n.toString(16).padStart(2,'0')).join(':'),key:v.getUint16(at+10),portPriority:v.getUint16(at+12),portNumber:v.getUint16(at+14),state:b[at+16]});return {version:1,actor:part(2),partner:part(22),collectorMaxDelay:v.getUint16(44)};
}
