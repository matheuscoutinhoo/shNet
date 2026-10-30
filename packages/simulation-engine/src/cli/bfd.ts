import type {Device,NetworkInterface} from '../model';
import {bfdTemplatesSchema} from '../protocols/bfd-model';
import {configureBfd,refreshBfdTemplates} from '../protocols/bfd';
import {ALL_MODES,currentPort,type CommandRegistry} from './registry';
import {registerKeyChainCommands} from './key-chain';
function template(d:Device,name?:string){const t=d.bfdTemplates?.find(t=>t.name===name);if(!t)throw new Error('Select a BFD template.');return t;}
export function registerBfdCommands(r:CommandRegistry){
 registerKeyChainCommands(r);
 r.register({pattern:/^(no )?bfd-template single-hop ([\w-]{1,32})$/i,modes:['config'],run:(m,_e,d,c)=>{d.bfdTemplates??=[];if(m[1]){if(d.interfaces.some(p=>p.bfd?.template===m[2]))throw new Error('BFD template is applied to an interface.');d.bfdTemplates=d.bfdTemplates.filter(t=>t.name!==m[2]);return;}if(!d.bfdTemplates.some(t=>t.name===m[2]))d.bfdTemplates.push(bfdTemplatesSchema.element.parse({name:m[2]}));c.mode='bfd-template';c.name=m[2];}});
 r.register({pattern:/^interval min-tx (\d+) min-rx (\d+) multiplier (\d+)$/i,modes:['bfd-template'],run:(m,e,d,c)=>{Object.assign(template(d,c.name),{intervalMs:Number(m[1]),minRxMs:Number(m[2]),multiplier:Number(m[3])});refreshBfdTemplates(e,d);}});
 r.register({pattern:/^(no )?authentication(?: (md5|meticulous-md5|sha-1|meticulous-sha-1) keychain ([\w-]{1,32}))?$/i,modes:['bfd-template'],run:(m,e,d,c)=>{const t=template(d,c.name);if(m[1])delete t.authentication;else {if(!m[2]||!m[3])throw new Error('Specify BFD authentication type and keychain.');t.authentication={type:m[2].toLowerCase() as NonNullable<typeof t.authentication>['type'],keyChain:m[3]};}refreshBfdTemplates(e,d);}});
 r.register({pattern:/^bfd template ([\w-]{1,32})$/i,modes:['interface'],run:(m,e,d,c)=>{const p=currentPort(d,c),t=template(d,m[1]);configureBfd(e,d,p,{...t,template:t.name,ospf:p.bfd?.ospf??false});}});
 r.register({pattern:/^no bfd template(?: ([\w-]{1,32}))?$/i,modes:['interface'],run:(m,e,d,c)=>{const p=currentPort(d,c);if(m[1]&&p.bfd?.template!==m[1])return;configureBfd(e,d,p,{intervalMs:750,minRxMs:750,multiplier:3,ospf:p.bfd?.ospf??false});}});
 r.register({pattern:/^bfd interval (\d+) min_rx (\d+) multiplier (\d+)$/i,modes:['interface'],run:(m,e,d,c)=>{const p=currentPort(d,c);if(p.bfd?.template)throw new Error('Remove the applied BFD template before configuring legacy timers.');configureBfd(e,d,p,{intervalMs:Number(m[1]),minRxMs:Number(m[2]),multiplier:Number(m[3])});}});
 r.register({pattern:/^no bfd interval$/i,modes:['interface'],run:(_m,e,d,c)=>{const p=currentPort(d,c);if(p.bfd?.template)throw new Error('Remove the applied BFD template before changing legacy timers.');configureBfd(e,d,p,{intervalMs:750,minRxMs:750,multiplier:3,ospf:p.bfd?.ospf??false});}});
 r.register({pattern:/^(no )?ip ospf bfd$/i,modes:['interface'],run:(m,e,d,c)=>{const p=currentPort(d,c);configureBfd(e,d,p,{...(p.bfd??{intervalMs:750,minRxMs:750,multiplier:3}),ospf:!m[1]});}});
 r.register({pattern:/^show bfd neighbors(?: details)?$/i,modes:ALL_MODES,run:(_m,e,d)=>d.interfaces.flatMap(p=>p.bfd?.sessions.map(s=>`${p.name} ${s.ip} ${s.state} local ${s.my} remote ${s.remote}, clients ${s.clients.join(',')}, detection ${s.deadline===undefined?'-':Math.max(0,s.deadline-e.state.clock).toFixed(3)} ms${p.bfd?.authentication?', authenticated '+p.bfd.authentication.type:''}`)??[]).join('\n')||'No BFD neighbors.'});
}
export function bfdTemplateRunningConfig(d:Device){return (d.bfdTemplates??[]).flatMap(t=>['bfd-template single-hop '+t.name,` interval min-tx ${t.intervalMs} min-rx ${t.minRxMs} multiplier ${t.multiplier}`,...(t.authentication?[` authentication ${t.authentication.type} keychain ${t.authentication.keyChain}`]:[]),'exit']);}
export function bfdInterfaceRunningConfig(p:NetworkInterface){const b=p.bfd;return b?[...(b.template?[' bfd template '+b.template]:[` bfd interval ${b.intervalMs} min_rx ${b.minRxMs} multiplier ${b.multiplier}`]),...(b.ospf?[' ip ospf bfd']:[])]:[];}
