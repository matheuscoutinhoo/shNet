import { readFileSync, writeFileSync } from 'node:fs';
import { SimulationEngine, validateSnapshot, exportPcap, decodePcap, vrrpConfigGroups } from '../../packages/simulation-engine/src/index';
const out='artifacts/factory-audit';
const baseline=JSON.parse(readFileSync(out+'/factory-baseline.shlab.json','utf8'));
const results:any[]=[];
function find(e:SimulationEngine,n:string){return e.state.devices.find(d=>d.hostname===n)!;}
function experiment(id:string,label:string,fn:(e:SimulationEngine)=>any,snapshot=baseline){
 const e=new SimulationEngine(snapshot);e.state.events=[];
 try {const detail=fn(e);results.push({id,label,detail});writeFileSync(out+'/evidence/'+id+'.json',JSON.stringify({detail,events:e.state.events,probes:e.state.probes},null,2));}catch(err){results.push({id,label,error:(err as Error).message});}
}
function http(e:SimulationEngine){const id=e.httpGet(find(e,'PC-ERP').id,'198.51.100.10');e.advanceTo(e.state.clock+2000,100000);return find(e,'PC-ERP').tcpConnections?.find(c=>c.id===id);}
experiment('S31','WAN após falha de FW-A: rota de retorno estática',e=>{e.setDevicePower(find(e,'FW-A').id,false);e.advanceTo(e.state.clock+5000,100000);return http(e);});
experiment('S32','Falha de distribuição DIST-A',e=>{e.setDevicePower(find(e,'DIST-A').id,false);e.advanceTo(e.state.clock+6000,100000);const id=e.ping(find(e,'SCADA').id,'10.20.40.10');e.advanceTo(e.state.clock+31000,100000);const retry=e.ping(find(e,'SCADA').id,'10.20.40.10');e.advanceTo(e.state.clock+1000,100000);return {primary:find(e,'FW-A').vrrp?.groups.map(g=>g.state),backup:find(e,'FW-B').vrrp?.groups.map(g=>g.state),probe:e.state.probes.find(p=>p.id===id),retry:e.state.probes.find(p=>p.id===retry),stp:find(e,'SW-SCADA').interfaces.filter(p=>['p22','p23'].includes(p.id)).map(p=>({port:p.id,state:p.spanningTree}))};});
experiment('S33','Captura PCAP de HTTP',e=>{const id=e.httpGet(find(e,'PC-ERP').id,'10.20.20.10');e.advanceTo(e.state.clock+200,100000);const pcap=exportPcap(e.state);writeFileSync(out+'/evidence/http-mes.pcap',pcap.bytes);return {id,packets:pcap.packets,decoded:decodePcap(pcap.bytes).length,excluded:pcap.excluded.length,reasons:[...new Set(pcap.excluded.map(x=>x.reason))]};});
experiment('S34','Retenção dos eventos após ping e 5 s',e=>{const id=e.ping(find(e,'SCADA').id,'10.20.40.10');e.advanceTo(e.state.clock+200,100000);const immediate=e.state.events.some(ev=>ev.type==='PING_SUCCESS');e.advanceTo(e.state.clock+5000,100000);return {id,immediate,retained:e.state.events.length,successEventRetained:e.state.events.some(ev=>ev.type==='PING_SUCCESS'),probe:e.state.probes.find(p=>p.id===id),pcap:exportPcap(e.state).packets};});
experiment('S35','NTP no segmento de gestão',e=>{e.configureClock(find(e,'NTP-MGMT').id,{offsetMs:0,server:true,stratum:1});e.configureClock(find(e,'ADMIN-REDE').id,{offsetMs:250,server:false,stratum:2});e.configureNtp(find(e,'ADMIN-REDE').id,{enabled:true,servers:['10.20.99.123'],intervalMs:5000});e.advanceTo(e.state.clock+3000,100000);return {ntp:find(e,'ADMIN-REDE').ntp,clock:find(e,'ADMIN-REDE').networkClock};});
experiment('S36','Syslog no segmento de gestão',e=>{e.setSyslogEnabled(find(e,'NMS-SYSLOG').id,true);e.configureSyslog(find(e,'ADMIN-REDE').id,{enabled:true,server:'10.20.99.10',automatic:false,severity:7,facility:23});e.sendSyslog(find(e,'ADMIN-REDE').id,'Teste de evento de manutenção da fábrica');e.advanceTo(e.state.clock+1000,100000);return find(e,'NMS-SYSLOG').syslogServer;});
experiment('S37','Switch L2 com SVI: gerência syslog',e=>{const sw=find(e,'SW-TI');const p=e.addSvi(sw.id,99);Object.assign(p,{ip:'10.20.99.21',prefix:24});sw.gateway='10.20.99.1';const id=e.ping(sw.id,'10.20.99.10');e.advanceTo(e.state.clock+1000,100000);let error;try{e.configureSyslog(sw.id,{enabled:true,server:'10.20.99.10',automatic:false});}catch(err){error=(err as Error).message;}return {ipRouting:sw.ipRouting,probe:e.state.probes.find(p=>p.id===id),syslogError:error};});
const e=new SimulationEngine(baseline),a=find(e,'FW-A'),b=find(e,'FW-B'),dhcp=find(e,'DHCP-DMZ');
// Retain the original baseline as a deliberate availability fault experiment.
for(const vlan of [10,70]) {
 e.configureDhcpRelay(b.id,b.interfaces.find(p=>p.logical?.vlan===vlan)!.id,['10.20.20.67']);
 e.configureDhcpPool(dhcp.id,{name:'BACKUP'+vlan,port:'p0',network:`10.20.${vlan}.0`,prefix:24,start:`10.20.${vlan}.111`,end:`10.20.${vlan}.120`,gateway:`10.20.${vlan}.1`,relayAddress:`10.20.${vlan}.3`,dns:['10.20.20.53'],leaseMs:60000,excluded:[]});
}
for(const [i,fw] of [a,b].entries()) e.configureVrrp(fw.id,{enabled:true,groups:[...vrrpConfigGroups(fw),{port:'p1',vrid:200,vip:'172.20.0.254',priority:i?100:150,advertMs:1000}]});
find(e,'R-WAN-SIMULADA').routes=[{network:'10.20.0.0',prefix:16,nextHop:'172.20.0.254',metric:1}];
const infra=[];
for(const [i,suffix] of ['A','B'].entries()){
 const rack=e.addProfile('rack',{x:1800+i*240,y:250});rack.hostname='RACK-'+suffix;
 const ups=e.addProfile('ups',{x:1800+i*240,y:470});ups.hostname='UPS-'+suffix;
 const loads=['FW-'+suffix,'DIST-'+suffix].map(name=>({device:find(e,name).id,watts:name.startsWith('FW')?100:200,requested:true}));
 e.configureInfrastructure(rack.id,{kind:'rack',units:42,ambientC:25,ventilation:0.8,slots:loads.map((load,j)=>({device:load.device,unit:1+j*3,units:2}))});
 e.configureInfrastructure(ups.id,{kind:'ups',mains:true,capacityWh:1000,maxWatts:1500,chargeWatts:100,efficiency:0.9,loads,remainingWh:1000,lastAt:e.state.clock,output:true});
 infra.push(rack,ups);
}
const patch=e.addProfile('patch-panel',{x:2050,y:90});patch.hostname='PATCH-OT';
e.configureInfrastructure(patch.id,{kind:'patch-panel',pairs:[{a:'p0',b:'p1'}]});
const scada=find(e,'SCADA'),old=e.state.links.find(l=>l.a.device===scada.id || l.b.device===scada.id)!;
const peer=old.a.device===scada.id?old.b:old.a;e.removeLink(old.id);
e.connect({device:scada.id,port:'p0'},{device:patch.id,port:'p0'},'copper',{distance:5});e.connect({device:patch.id,port:'p1'},peer,'copper',{distance:25});
e.state.events=[];e.state.devices.forEach(d=>d.logs=[]);e.advanceTo(e.state.clock+5000,100000);validateSnapshot(e.state);
e.state.notes += '\nVersão revisada: relay DHCP nos dois firewalls com pools disjuntos, VRRP também no trânsito WAN e rota de retorno via VIP, racks/UPS independentes e patch panel OT. Serviços continuam educacionais. Sessões de firewall não são sincronizadas.';
e.state.events=[];e.state.devices.forEach(d=>d.logs=[]);
writeFileSync(out+'/factory-final.shlab.json',JSON.stringify(e.snapshot(),null,2));
const final=e.snapshot();
experiment('S38','DHCP redundante corrigido após falha de FW-A',s=>{s.setDevicePower(find(s,'FW-A').id,false);s.advanceTo(s.state.clock+5000,100000);s.requestDhcp(find(s,'PC-FINANCEIRO').id,'p0');s.advanceTo(s.state.clock+3000,100000);return find(s,'PC-FINANCEIRO').interfaces[0];},final);
experiment('S39','WAN corrigida: nova sessão após failover',s=>{s.setDevicePower(find(s,'FW-A').id,false);s.advanceTo(s.state.clock+5000,100000);return http(s);},final);
experiment('S40','UPS A sem rede elétrica e bateria esgotada',s=>{const ups=find(s,'UPS-A');s.configureInfrastructure(ups.id,{...ups.infrastructure,mains:false,remainingWh:0.1});s.advanceTo(s.state.clock+5000,100000);const id=s.ping(find(s,'SCADA').id,'10.20.40.10');s.advanceTo(s.state.clock+31000,100000);const retry=s.ping(find(s,'SCADA').id,'10.20.40.10');s.advanceTo(s.state.clock+1000,100000);return {ups:ups.infrastructure,primaryPower:find(s,'FW-A').power,distributionPower:find(s,'DIST-A').power,probe:s.state.probes.find(p=>p.id===id),retry:s.state.probes.find(p=>p.id===retry)};},final);
experiment('S41','Patch panel: comunicação SCADA–PLC',s=>{const id=s.ping(find(s,'SCADA').id,'10.20.40.10');s.advanceTo(s.state.clock+1000,100000);return s.state.probes.find(p=>p.id===id);},final);
experiment('S42','Energia: perda das duas UPS',s=>{for(const name of ['UPS-A','UPS-B']){const ups=find(s,name);s.configureInfrastructure(ups.id,{...ups.infrastructure,mains:false,remainingWh:0});}const id=s.ping(find(s,'SCADA').id,'10.20.40.10');s.advanceTo(s.state.clock+31000,100000);return s.state.probes.find(p=>p.id===id);},final);
writeFileSync(out+'/extended-results.json',JSON.stringify({finalDevices:final.devices.length,finalLinks:final.links.length,results},null,2));console.log(JSON.stringify({finalDevices:final.devices.length,finalLinks:final.links.length,results},null,2));
