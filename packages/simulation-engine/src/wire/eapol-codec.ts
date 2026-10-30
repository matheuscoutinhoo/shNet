import type {Eapol} from '../protocols/aaa-model';
import {chapChallenge} from '../protocols/aaa-codec';
import {concat,hex,need,text,u16,view} from './binary';
/** IEEE 802.1X EAPOL / RFC 3748 Identity and MD5-Challenge. */
export function encodeEapol(m:Eapol){
 if(m.type==='start'||m.type==='logoff')return new Uint8Array([2,m.type==='start'?1:2,0,0]);
 if(m.identifier===undefined)throw new Error('Legacy EAPOL lacks EAP Identifier metadata.');
 let code:number,data:Uint8Array;
 if(m.type==='identity-request'){code=1;data=new Uint8Array([1]);}
 else if(m.type==='identity-response'){code=2;data=concat(new Uint8Array([1]),text(m.username));}
 else if(m.type==='challenge'){code=1;const challenge=hex(chapChallenge(m.challenge));if(challenge[0]!==m.identifier)throw new Error('MD5-Challenge Identifier does not match the model proof.');data=concat(new Uint8Array([4,16]),challenge);}
 else if(m.type==='response'){code=2;data=concat(new Uint8Array([4,16]),hex(m.proof),text(m.username));}
 else {code=m.type==='success'?3:4;data=new Uint8Array();}
 const p=concat(new Uint8Array([code,m.identifier]),u16(4+data.length),data);return concat(new Uint8Array([2,0]),u16(p.length),p);
}
export function decodeEapol(b:Uint8Array){
 need(b,0,4);const v=view(b),length=v.getUint16(2);if(![1,2,3].includes(b[0]))throw new Error('Unsupported EAPOL version.');need(b,4,length);
 if(b[1]===1||b[1]===2){if(length)throw new Error('EAPOL Start/Logoff must have no body.');return {version:b[0],type:b[1]===1?'start':'logoff'};}
 if(b[1]!==0||length<4)throw new Error('Unsupported EAPOL packet.');const e=b.subarray(4,4+length),ev=view(e);if(ev.getUint16(2)!==length||![1,2,3,4].includes(e[0]))throw new Error('Invalid EAP code/length.');
 if(e[0]>=3){if(length!==4)throw new Error('EAP Success/Failure must have length 4.');return {version:b[0],type:e[0]===3?'success':'failure',identifier:e[1]};}
 need(e,4,1);if(e[4]===1)return {version:b[0],type:e[0]===1?'identity-request':'identity-response',identifier:e[1],identity:new TextDecoder('utf-8',{fatal:true}).decode(e.subarray(5))};
 if(e[4]!==4)throw new Error('Unsupported EAP method.');need(e,5,1);const size=e[5];if(size!==16)throw new Error('Invalid EAP-MD5 value size.');need(e,6,size);return {version:b[0],type:e[0]===1?'challenge':'response',identifier:e[1],value:[...e.subarray(6,6+size)].map(n=>n.toString(16).padStart(2,'0')).join(''),name:new TextDecoder('utf-8',{fatal:true}).decode(e.subarray(6+size))};
}
