import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SimulationEngine, addCanvasItem, validateSnapshot, makeTemplate, exportPcap, decodePcap } from '../../packages/simulation-engine/src/index';
import type { Device } from '../../packages/simulation-engine/src/model';

const out = 'artifacts/factory-audit';
mkdirSync(out + '/evidence', { recursive: true });
const e = new SimulationEngine();
const named: Record<string, Device> = {};
function dev(profile: string, name: string, x: number, y: number) {
  const d = e.addProfile(profile, { x, y }); d.hostname = name; named[name] = d; return d;
}
function addr(d: Device, ip: string, port = 'p0', prefix = 24) {
  Object.assign(d.interfaces.find(p => p.id === port)!, { ip, prefix });
}
function cable(a: Device, ap: string, b: Device, bp: string, distance = 35) {
  const pa = a.interfaces.find(p => p.id === ap)!, pb = b.interfaces.find(p => p.id === bp)!;
  pa.speed = pb.speed = 1000;
  return e.connect({ device: a.id, port: ap }, { device: b.id, port: bp }, 'copper', { distance });
}
const segments = [
  { vlan: 10, label: 'TI CORPORATIVA', key: 'TI', x: 0, y: 800 },
  { vlan: 20, label: 'DMZ / SERVIÇOS', key: 'DMZ', x: 780, y: 800 },
  { vlan: 30, label: 'SUPERVISÃO OT', key: 'SCADA', x: 1560, y: 800 },
  { vlan: 40, label: 'CÉLULA A', key: 'A', x: 0, y: 1350 },
  { vlan: 50, label: 'CÉLULA B', key: 'B', x: 780, y: 1350 },
  { vlan: 60, label: 'CFTV', key: 'CCTV', x: 1560, y: 1350 },
  { vlan: 70, label: 'WI-FI VISITANTES', key: 'WIFI', x: 0, y: 1900 },
  { vlan: 99, label: 'GERENCIAMENTO', key: 'MGMT', x: 780, y: 1900 },
];
const distA = dev('distribution', 'DIST-A', 760, 430);
const distB = dev('distribution', 'DIST-B', 1240, 430);
distA.ipRouting = distB.ipRouting = false;
const primary = dev('firewall', 'FW-A', 760, 220);
const backup = dev('firewall', 'FW-B', 1240, 220);
const access: Record<string, Device> = {};
for (const [i, s] of segments.entries()) {
  addCanvasItem(e, { kind: 'region', text: `${s.label} · VLAN ${s.vlan} · 10.20.${s.vlan}.0/24`, position: { x: s.x - 30, y: s.y - 70 }, width: 750, height: 510, color: ['A','B','SCADA'].includes(s.key) ? 'lime' : 'cyan' });
  const sw = dev(['A','B'].includes(s.key) ? 'industrial' : 'access', 'SW-' + s.key, s.x + 240, s.y);
  access[s.key] = sw;
  sw.vlans = segments.map(v => ({ id: v.vlan, name: v.key }));
  for (const p of sw.interfaces) { p.accessVlan = s.vlan; p.speed = 1000; }
  const uplinks = sw.profile === 'industrial' ? ['p6', 'p7'] : ['p22', 'p23'];
  for (const [n, dist] of [distA, distB].entries()) {
    const dp = dist.interfaces[i], sp = sw.interfaces.find(p => p.id === uplinks[n])!;
    for (const p of [dp, sp]) Object.assign(p, { mode: 'trunk', nativeVlan: 1, allowedVlans: [1,...segments.map(v => v.vlan)] });
    cable(dist, dp.id, sw, sp.id, 70);
  }
  e.configureSpanningTree(sw.id, 'rstp', 32768);
}
for (const [n, dist] of [distA, distB].entries()) {
  dist.vlans = segments.map(s => ({ id: s.vlan, name: s.key }));
  e.configureSpanningTree(dist.id, 'rstp', n ? 4096 : 0);
}
for (const [n, dist] of [primary, backup].entries()) {
  for (const s of segments) {
    const p = e.addSubinterface(dist.id, 'p0', s.vlan); addr(dist, `10.20.${s.vlan}.${n + 2}`, p.id);
  }
  e.configureVrrp(dist.id, { enabled: true, groups: segments.map(s => ({ port: dist.interfaces.find(p => p.logical?.vlan === s.vlan)!.id, vrid: s.vlan, vip: `10.20.${s.vlan}.1`, priority: n ? 100 : 150, advertMs: 1000 })) });
}
for (const dist of [distA, distB]) for (const i of [19,20]) Object.assign(dist.interfaces[i], { mode: 'trunk', nativeVlan: 1, allowedVlans: [1,...segments.map(s => s.vlan)] });
cable(distA, 'p20', distB, 'p20', 10);
cable(primary,'p0',distA,'p19'); cable(backup,'p0',distB,'p19');
e.setSpanningTreePort(distA.id,'p19',{edge:true}); e.setSpanningTreePort(distB.id,'p19',{edge:true});
const hostPorts: Record<string, number> = {};
function host(profile: string, name: string, key: string, suffix: number, col: number) {
  const s = segments.find(s => s.key === key)!;
  const d = dev(profile, name, s.x + col * 230, s.y + 210);
  if(d.type!=='switch') { addr(d, `10.20.${s.vlan}.${suffix}`); d.gateway = `10.20.${s.vlan}.1`; }
  cable(d, 'p0', access[key], 'p' + (hostPorts[key] ?? 0)); hostPorts[key] = (hostPorts[key] ?? 0) + 1;
  for (const dist of [primary, backup]) e.setSpanningTreePort(access[key].id, 'p' + (hostPorts[key] - 1), { edge: true });
  return d;
}
host('desktop','PC-ERP','TI',10,0); host('desktop','PC-FINANCEIRO','TI',11,1); host('printer','IMP-EXPEDICAO','TI',20,2);
host('web','MES-DMZ','DMZ',10,0); host('dns','DNS-DMZ','DMZ',53,1); host('dhcp','DHCP-DMZ','DMZ',67,2);
host('server','SCADA','SCADA',10,0); host('desktop','ENG-OT','SCADA',11,1); host('mqtt','BROKER-OT','SCADA',20,2);
host('server','PLC-A','A',10,0); host('desktop','HMI-A','A',11,1); host('iot','SENSOR-A','A',20,2);
host('server','PLC-B','B',10,0); host('desktop','HMI-B','B',11,1); host('iot','SENSOR-B','B',20,2);
host('server','NVR','CCTV',10,0); host('iot','CAM-01','CCTV',11,1); host('iot','CAM-02','CCTV',12,2);
const ap = host('ap','AP-ARMAZEM','WIFI',2,0);
const visitor = dev('laptop','NOTEBOOK-VISITANTE',260,2150);
const radio = { ssid:'Fabrica-Visitantes', security:'wpa2-psk', key:'Factory-Guest-Test', band:'2.4', channel:1, txPower:20, noise:-95, attenuation:0, enabled:true };
e.configureWireless(ap.id,{...radio,role:'ap'}); e.configureWireless(visitor.id,{...radio,role:'client'});
addr(visitor,'10.20.70.10','wlan0'); visitor.gateway = '10.20.70.1';
host('syslog','NMS-SYSLOG','MGMT',10,0); host('ntp','NTP-MGMT','MGMT',123,1); host('desktop','ADMIN-REDE','MGMT',11,2);
const wan = dev('edge','R-WAN-SIMULADA',1000,20), remote = dev('web','SUPORTE-EXTERNO',1510,20);
addr(primary,'172.20.0.2','p1'); addr(backup,'172.20.0.3','p1'); addr(wan,'172.20.0.1'); addr(wan,'198.51.100.1','p1'); addr(remote,'198.51.100.10'); remote.gateway='198.51.100.1';
const wansw = dev('switch-l2','SW-WAN',500,20); cable(primary,'p1',wansw,'p0'); cable(backup,'p1',wansw,'p1'); cable(wan,'p0',wansw,'p2'); cable(wan,'p1',remote,'p0');
for (const dist of [primary,backup]) dist.routes.push({network:'0.0.0.0',prefix:0,nextHop:'172.20.0.1',metric:1});
wan.routes.push({network:'10.20.0.0',prefix:16,nextHop:'172.20.0.2',metric:1});
for (const name of ['MES-DMZ','SCADA','NVR','SUPORTE-EXTERNO']) e.configureTcpService(named[name].id,{kind:'http',port:80,enabled:true,body:name+' - serviço de teste'});
for (const name of ['PLC-A','PLC-B']) e.configureTcpService(named[name].id,{kind:'echo',port:502,enabled:true,body:''});
e.configureBroker(named['BROKER-OT'].id,{enabled:true,port:1883});
e.configureDnsRecord(named['DNS-DMZ'].id,{name:'mes.fabrica.test',type:'A',value:'10.20.20.10',ttl:60});
e.setDnsEnabled(named['DNS-DMZ'].id,true);
for (const d of Object.values(named).filter(d => ['pc','server'].includes(d.type))) {
  const p=d.interfaces.find(p=>p.ip); if (p) e.setDnsServers(d.id,p.id,['10.20.20.53']);
}
for (const vlan of [10,70]) {
  e.configureDhcpPool(named['DHCP-DMZ'].id,{name:'VLAN'+vlan,port:'p0',network:`10.20.${vlan}.0`,prefix:24,start:`10.20.${vlan}.100`,end:`10.20.${vlan}.110`,gateway:`10.20.${vlan}.1`,relayAddress:`10.20.${vlan}.2`,dns:['10.20.20.53'],leaseMs:60000,excluded:[]});
  e.configureDhcpRelay(primary.id,primary.interfaces.find(p=>p.logical?.vlan===vlan)!.id,['10.20.20.67']);
}
e.setDhcpEnabled(named['DHCP-DMZ'].id,true);
for (const d of [primary,backup,named['SCADA']]) e.configureSnmpAgent(d.id,{enabled:true,community:'factory-test'});
const zones = segments.map(s => ({name:s.key,ports:[primary.interfaces.find(p=>p.logical?.vlan===s.vlan)!.id]}));
zones.push({name:'WAN',ports:['p1']});
const rules: any[] = []; let sequence=10;
function rule(from:string,to:string,protocol:string,destinationPort?:number,action='inspect') {rules.push({sequence,from,to,protocol,action,...(destinationPort?{destinationPort}:{})});sequence+=10;}
for (const s of segments) if (s.key!=='DMZ') { rule(s.key,'DMZ','UDP',53); rule(s.key,'DMZ','TCP',53); rule(s.key,'DMZ','TCP',80); }
for (const key of ['A','B']) { rule('SCADA',key,'ICMP'); rule('SCADA',key,'TCP',502); rule(key,'SCADA','TCP',1883); rule(key,'SCADA','ICMP'); }
rule('TI','WAN','TCP',80); rule('MGMT','WAN','ip',undefined,'permit');
for (const s of segments) if(s.key!=='MGMT') rule('MGMT',s.key,'ip',undefined,'inspect');
for (const dist of [primary,backup]) e.configureFirewall(dist.id,{enabled:true,protocols:['TCP','UDP','ICMP'],trustedPorts:[],zonePolicy:{zones:zones.map(z=>({...z,ports:z.name==='WAN'?['p1']:[dist.interfaces.find(p=>p.logical?.vlan===segments.find(s=>s.key===z.name)!.vlan)!.id]})),rules}});
addCanvasItem(e,{kind:'note',text:'FÁBRICA · 8 VLANs · RSTP + VRRP\nPLC: endpoint TCP/502 echo (sem Modbus)\nSCADA/MES/NVR: HTTP de teste\nWAN: simulada, sem Internet real',position:{x:0,y:270},width:680,height:220,color:'blue'});
e.state.notes='Auditoria 13/10/2026. Representação de rede industrial: TI, DMZ, OT, células A/B, CFTV, visitantes, gerenciamento. PLCs usam TCP echo/502; não modelam lógica industrial. DIST-A/B: RSTP; FW-A/B: VRRP e firewall stateful. Regras negam tráfego interzona não autorizado. Uplinks cobre <=100 m. NMS/NTP e câmera são representações de funções; serviço deve ser validado por cenário. WAN não tem redundância física do ISP. DHCP relay inicialmente no primário: risco documentado de disponibilidade.';
e.state.background='dark';
const buildStart=performance.now(); e.advanceTo(6000,100000);
validateSnapshot(e.state);
writeFileSync(out+'/factory-baseline.shlab.json',JSON.stringify(e.snapshot(),null,2));
writeFileSync(out+'/inventory.json',JSON.stringify(Object.values(named).map(d=>({name:d.hostname,id:d.id,profile:d.profile,addresses:d.interfaces.filter(p=>p.ip).map(p=>({port:p.id,ip:p.ip})),gateway:d.gateway})),null,2));
const base=e.snapshot(); const results:any[]=[];
function run(id:string,label:string,fn:(s:SimulationEngine)=>unknown) {
 const s=new SimulationEngine(base),t=performance.now();
 const observed:any[]=[]; const orig=s.emit.bind(s);
 s.emit=((...args:any[])=>{const result=(orig as any)(...args);const ev=s.state.events.at(-1)!;if(!ev.type.startsWith('BPDU') && !['MAC_LEARNED','FRAME_FLOODED'].includes(ev.type) && !(ev.frame?.packet?.protocol==='VRRP') && !ev.type.startsWith('VRRP_ADVERT') && !(ev.type==='PACKET_DROPPED' && ev.message?.includes('Nenhuma porta de saída encaminha'))) observed.push(structuredClone(ev));return result;}) as any;
 try{const detail=fn(s);results.push({id,label,wallMs:Math.round(performance.now()-t),detail});writeFileSync(out+'/evidence/'+id+'.json',JSON.stringify({result:results.at(-1),events:observed,probes:s.state.probes},null,2));}
 catch(err){results.push({id,label,error:(err as Error).message});}
}
function ping(s:SimulationEngine,source:string,target:string) {const p=s.ping(named[source].id,target);s.advanceTo(s.state.clock+31000,100000);return s.state.probes.find(x=>x.id===p);}
function http(s:SimulationEngine,source:string,target:string,port=80){const c=s.httpGet(named[source].id,target,port);s.advanceTo(s.state.clock+45000,100000);return s.device(named[source].id).tcpConnections?.find(x=>x.id===c);}
run('S01','HMI-A para PLC-A local',s=>ping(s,'HMI-A','10.20.40.10'));
run('S02','SCADA para PLC-A autorizado',s=>ping(s,'SCADA','10.20.40.10'));
run('S03','SCADA para PLC-B autorizado',s=>ping(s,'SCADA','10.20.50.10'));
run('S04','TI para PLC-A bloqueado',s=>ping(s,'PC-ERP','10.20.40.10'));
run('S05','Célula A para B bloqueada',s=>ping(s,'HMI-A','10.20.50.10'));
run('S06','TI para MES HTTP',s=>http(s,'PC-ERP','10.20.20.10'));
run('S07','Visitante para PLC bloqueado',s=>ping(s,'NOTEBOOK-VISITANTE','10.20.40.10'));
run('S08','Visitante para MES HTTP',s=>http(s,'NOTEBOOK-VISITANTE','10.20.20.10'));
run('S09','DNS DMZ',s=>{s.lookupDns(named['PC-ERP'].id,'mes.fabrica.test');s.advanceTo(s.state.clock+11000,100000);return s.device(named['PC-ERP'].id).dnsQueries;});
run('S10','DHCP por relay',s=>{s.requestDhcp(named['PC-FINANCEIRO'].id,'p0');s.advanceTo(s.state.clock+12000,100000);return s.device(named['PC-FINANCEIRO'].id).interfaces[0];});
run('S11','MQTT sensor e assinante SCADA',s=>{s.connectIot(named['SENSOR-A'].id,'10.20.30.20');s.connectIot(named['SCADA'].id,'10.20.30.20');s.advanceTo(s.state.clock+2000,100000);s.subscribeIot(named['SCADA'].id,'fabrica/+/temperatura');s.advanceTo(s.state.clock+500,100000);s.publishIot(named['SENSOR-A'].id,'fabrica/A/temperatura','72.5',true);s.advanceTo(s.state.clock+1000,100000);return {sensor:s.device(named['SENSOR-A'].id).iot,scada:s.device(named['SCADA'].id).iot};});
run('S12','Falha do uplink principal célula A',s=>{s.setPort(access.A.id,'p6',false);s.advanceTo(s.state.clock+5000,100000);return ping(s,'SCADA','10.20.40.10');});
run('S13','Falha total de FW-A / VRRP',s=>{s.setDevicePower(primary.id,false);s.advanceTo(s.state.clock+5000,100000);return {groups:s.device(backup.id).vrrp?.groups,probe:ping(s,'SCADA','10.20.40.10')};});
run('S14','Dois uplinks célula A desligados',s=>{s.setPort(access.A.id,'p6',false);s.setPort(access.A.id,'p7',false);s.advanceTo(s.state.clock+5000,100000);return ping(s,'SCADA','10.20.40.10');});
run('S15','Restaurar uplink após isolamento',s=>{s.setPort(access.A.id,'p6',false);s.setPort(access.A.id,'p7',false);s.advanceTo(s.state.clock+5000,100000);const outage=ping(s,'SCADA','10.20.40.10');s.setPort(access.A.id,'p6',true);s.advanceTo(s.state.clock+5000,100000);return {outage,recovery:ping(s,'SCADA','10.20.40.10')};});
run('S16','DNS desligado e cache limpo',s=>{s.setDnsEnabled(named['DNS-DMZ'].id,false);s.clearDnsCache(named['PC-ERP'].id);s.lookupDns(named['PC-ERP'].id,'mes.fabrica.test');s.advanceTo(s.state.clock+11000,100000);return s.device(named['PC-ERP'].id).dnsQueries;});
run('S17','HTTP MES desligado',s=>{s.configureTcpService(named['MES-DMZ'].id,{kind:'http',port:80,enabled:false,body:''});return http(s,'PC-ERP','10.20.20.10');});
run('S18','Persistência com ping pendente',s=>{const p=s.ping(named['SCADA'].id,'10.20.40.10');s.step();const restored=new SimulationEngine(JSON.parse(JSON.stringify(s.snapshot())));restored.advanceTo(restored.state.clock+5500,100000);return restored.state.probes.find(x=>x.id===p);});
run('S19','DHCP após perda do primário',s=>{s.setDevicePower(primary.id,false);s.advanceTo(s.state.clock+5000,100000);s.requestDhcp(named['PC-FINANCEIRO'].id,'p0');s.advanceTo(s.state.clock+15000,100000);return s.device(named['PC-FINANCEIRO'].id).interfaces[0];});
run('S20','Cabeamento cobre 150 m',s=>{const l=s.state.links.find(l=>l.a.device===named['PLC-A'].id)!;l.distance=150;return ping(s,'HMI-A','10.20.40.10');});
run('S21','CFTV local NVR',s=>http(s,'CAM-01','10.20.60.10'));
run('S22','CFTV para OT bloqueado',s=>ping(s,'CAM-01','10.20.40.10'));
run('S23','NMS consulta SNMP SCADA',s=>{s.querySnmp(named['NMS-SYSLOG'].id,'10.20.30.10','factory-test',['1.3.6.1.2.1.1.5.0'],'get');s.advanceTo(s.state.clock+11000,100000);return s.device(named['NMS-SYSLOG'].id).snmpQueries;});
run('S24','Wi-Fi chave incorreta',s=>{s.configureWireless(visitor.id,{...radio,role:'client',key:'Wrong-Key-Test'});s.advanceTo(s.state.clock+12000,100000);return {wireless:s.device(visitor.id).wireless,probe:ping(s,'NOTEBOOK-VISITANTE','10.20.70.1')};});
run('S25','MTU / DF 2000 bytes',s=>{const p=s.ping(named['HMI-A'].id,'10.20.40.10',64,undefined,2000,true);s.advanceTo(s.state.clock+5500,100000);return s.state.probes.find(x=>x.id===p);});
run('S26','TI para suporte WAN HTTP',s=>http(s,'PC-ERP','198.51.100.10'));
run('S27','SCADA para PLC TCP/502 echo',s=>{const c=s.openTcp(named['SCADA'].id,'10.20.40.10',502,'read-register-test',true);s.advanceTo(s.state.clock+45000,100000);return s.device(named['SCADA'].id).tcpConnections?.find(x=>x.id===c);});
run('S28','TI para PLC TCP/502 bloqueado',s=>{const c=s.openTcp(named['PC-ERP'].id,'10.20.40.10',502,'unauthorized',true);s.advanceTo(s.state.clock+45000,100000);return s.device(named['PC-ERP'].id).tcpConnections?.find(x=>x.id===c);});
run('S29','Snapshot restaura estado convergido',s=>{const snap=s.snapshot();validateSnapshot(snap);return {devices:snap.devices.length,links:snap.links.length,clock:snap.clock,queue:snap.queue.length};});
run('S30','VRRP retorno / preempção',s=>{s.setDevicePower(primary.id,false);s.advanceTo(s.state.clock+5000,100000);const failover=s.device(backup.id).vrrp?.groups.map(g=>g.state);s.setDevicePower(primary.id,true);s.advanceTo(s.state.clock+5000,100000);return {failover,primary:s.device(primary.id).vrrp?.groups.map(g=>g.state),probe:ping(s,'SCADA','10.20.40.10')};});
// Protocol templates isolate failures from the factory configuration.
for (const name of ['lacp','vrrp','ospf','qos','vpn']) {
 const t=performance.now();try{const s=new SimulationEngine(makeTemplate(name));s.advanceTo(s.state.clock+5000,100000);results.push({id:'T-'+name,label:'Controle template '+name,wallMs:Math.round(performance.now()-t),detail:{devices:s.state.devices.length,events:s.state.events.length}});}catch(err){results.push({id:'T-'+name,error:(err as Error).message});}
}
writeFileSync(out+'/scenario-results.json',JSON.stringify({date:'2026-10-13',devices:base.devices.length,links:base.links.length,buildMs:Math.round(performance.now()-buildStart),results},null,2));
console.log(JSON.stringify({devices:base.devices.length,links:base.links.length,results:results.map(r=>({id:r.id,error:r.error,detail:r.detail}))},null,2));
