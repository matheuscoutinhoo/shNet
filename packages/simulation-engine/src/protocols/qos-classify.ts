import type {Frame,Device} from '../model';
import {matchingAclRule} from './acl';
import type {z} from 'zod';
import type {qosClassSchema} from './qos-model';
type Rule=z.infer<typeof qosClassSchema>;
export function qosMatches(c:Rule,frame:Frame,d?:Device){
 const packet=frame.packet??frame.ipv6??frame.fragment,protocol=frame.mpls?'MPLS':packet?.protocol==='ICMPv6'?'ICMP':packet?.protocol;
 const match=(m:NonNullable<Rule['matches']>[number])=>(!m.protocol||m.protocol==='any'||m.protocol.toUpperCase()===protocol)&&(!m.destinationPort||(packet&&'destinationPort'in packet&&packet.destinationPort===m.destinationPort))&&(m.dscp===undefined||(packet?.dscp??0)===m.dscp)&&(!m.dscps||m.dscps.includes(packet?.dscp??0))&&(!m.acl||!!d&&!!frame.packet&&matchingAclRule(d,m.acl,frame.packet)?.action==='permit');
 const group=(g:{matches:NonNullable<Rule['matches']>;matchAny?:boolean})=>g.matches.length?(g.matchAny?g.matches.some(match):g.matches.every(match)):false;
 return (c.protocol==='any'||c.protocol.toUpperCase()===protocol)&&(c.tc===undefined||frame.mpls?.labels[0].tc===c.tc)&&(c.destinationPort===undefined||(packet&&'destinationPort'in packet&&packet.destinationPort===c.destinationPort))&&(c.dscp===undefined||(packet?.dscp??0)===c.dscp)&&(c.groups?c.groups.every(g=>!g.matches.length||group(g)):c.matches===undefined||(!c.matches.length?c.name==='class-default':group({matches:c.matches,matchAny:c.matchAny})));
}
export const qosFrameBytes=(f:Frame)=>Math.max(64,(f.packet?.bytes??f.ipv6?.bytes??f.fragment?.bytes??f.mpls?.bytes??28)+18+(f.vlan!==undefined?4:0));
