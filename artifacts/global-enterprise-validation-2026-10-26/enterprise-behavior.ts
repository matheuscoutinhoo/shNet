import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {SimulationEngine,TerminalSession,validateSnapshot,preflight,exportPcap,ENGINE_CONTRACT_VERSION} from '../../packages/simulation-engine/src';
import {engineSourceHash} from '../../scripts/engine-build';
const out='artifacts/global-enterprise-validation-2026-10-26',json=(name:string,v:unknown)=>writeFileSync(`${out}/${name}.json`,JSON.stringify(v,null,2));
const e=new SimulationEngine(JSON.parse(readFileSync(out+'/global-enterprise.shlab.json','utf8'))),codes=['NYC','SAO','LON','FRA','SIN','SYD'];
const find=(s:SimulationEngine,name:string)=>s.state.devices.find(d=>d.hostname===name)!;
const workaround=[];
for(const code of codes)for(const side of ['A','B']){const d=find(e,`${code}-CORE-${side}`),t=new TerminalSession(e,d.id);for(const command of ['enable','conf t','spanning-tree mode rapid-pvst',`spanning-tree vlan 10,20,99 priority ${side==='A'?4096:8192}`,'end']){const response=t.execute(command);workaround.push({device:d.hostname,command,response});if(response.startsWith('%'))throw new Error(response);}console.log('reapplied rapid-pvst',d.hostname);}
json('workaround-transcript',workaround);json('global-enterprise-workaround.shlab',e.snapshot());
function advance(s:SimulationEngine,ms:number,budget=90000){const start=performance.now(),target=s.state.clock+ms;let processed=0,next=10000;while(s.state.clock<target&&performance.now()-start<budget){processed+=s.advanceTo(target,20000,100);if(performance.now()-start>next){console.log('advance',s.state.clock,Math.round(performance.now()-start),s.state.queue.length);next+=10000;}}if(s.state.clock<target)throw new Error(`Virtual time stalled at ${s.state.clock}, target ${target}, queue ${s.state.queue.length}`);return {wallMs:Math.round(performance.now()-start),processed};}
const convergence=advance(e,65000);console.log('converged',convergence);json('global-enterprise-converged.shlab',e.snapshot());
const base=e.snapshot(),results:any[]=[];
function result(id:string,name:string,expected:unknown,observed:unknown,start:number){const r={id,name,expected,observed,status:JSON.stringify(expected)===JSON.stringify(observed)?'pass':'fail',wallMs:Math.round(performance.now()-start)};results.push(r);json('behavior-results',{contract:ENGINE_CONTRACT_VERSION,sourceHash:engineSourceHash(),convergence,results,passed:results.filter(r=>r.status==='pass').length,failed:results.filter(r=>r.status==='fail').length});console.log(id,r.status);}
function matrix(s:SimulationEngine,guest=false){const probes=[];for(const a of codes)for(const [j,b]of codes.entries())if(a!==b)probes.push(s.ping(find(s,a+(guest?'-GUEST':'-USER')).id,`10.${j+1}.10.10`));advance(s,6000);return probes.map(id=>s.state.probes.find(p=>p.id===id)?.status);}
let start=performance.now();result('DATA-01','All 30 ordered cross-site corporate ICMP paths',Array(30).fill('success'),matrix(e),start);
start=performance.now();result('SEC-01','All 30 guest-to-corporate cross-site ICMP paths denied',Array(30).fill(false),matrix(e,true).map(s=>s==='success'),start);
start=performance.now();const requests=codes.map(c=>{const source=find(e,c+'-USER').id;return {source,id:e.httpGet(source,'10.1.10.80')};});advance(e,6000);result('APP-01','Six sites retrieve NYC corporate HTTP application',Array(6).fill(true),requests.map(r=>e.device(r.source).tcpConnections?.find(c=>c.id===r.id)?.received.includes('Global enterprise NYC')??false),start);
start=performance.now();for(const c of codes)e.lookupDns(find(e,c+'-USER').id,'nyc.corp.test');advance(e,6000);result('DNS-01','Six sites resolve corporate DNS',Array(6).fill('success'),codes.map(c=>find(e,c+'-USER').dnsQueries?.at(-1)?.status),start);
start=performance.now();for(const c of codes)e.requestDhcp(find(e,c+'-DHCP').id,'p0');advance(e,8000);result('DHCP-01','Central DHCP relay acquires leases in all six sites',Array(6).fill('bound'),codes.map(c=>find(e,c+'-DHCP').interfaces[0].dhcp?.status),start);
start=performance.now();result('CTRL-01','All six HSRP corporate groups have one active and one standby',Array(6).fill(['ACTIVE','STANDBY']),codes.map(c=>['A','B'].map(side=>find(e,`${c}-CORE-${side}`).hsrp?.groups.find(g=>g.group===10)?.state).sort()),start);
start=performance.now();result('CTRL-02','Every non-passive OSPF interface has a Full neighbor',true,e.state.devices.filter(d=>d.ospf).every(d=>d.ospf!.interfaces.filter(p=>!p.passive).every(p=>d.ospf!.neighbors.some(n=>n.port===p.port&&n.state==='Full'))),start);
const faults=[
 ['HA-01','NYC primary HSRP/core power failure',(s:SimulationEngine)=>s.setDevicePower(find(s,'NYC-CORE-A').id,false),16000],
 ['HA-02','All six primary WAN handoff links lost',(s:SimulationEngine)=>{for(const code of codes)s.setPort(find(s,code+'-WAN-A').id,'p0',false);},50000],
 ['HA-03','Whole primary WAN provider lost',(s:SimulationEngine)=>s.setDevicePower(find(s,'WAN-PROVIDER-A').id,false),50000],
 ['HA-04','London primary WAN edge power failure',(s:SimulationEngine)=>s.setDevicePower(find(s,'LON-WAN-A').id,false),50000],
 ['HA-05','Sydney single access-to-core uplink lost',(s:SimulationEngine)=>s.setPort(find(s,'SYD-ACCESS-A').id,'p20',false),16000],
] as const;
for(const [id,name,fail,settle]of faults){start=performance.now();const s=new SimulationEngine(base);fail(s);advance(s,settle);result(id,name+'; all 30 corporate ICMP paths recover',Array(30).fill('success'),matrix(s),start);json(id.toLowerCase()+'-state',{clock:s.state.clock,probes:s.state.probes,events:s.state.events.filter(ev=>/DROP|HSRP|OSPF|STP/.test(ev.type)||/HSRP|OSPF|STP/.test(ev.reason)).slice(-150)});validateSnapshot(s.snapshot());}
start=performance.now();const isolated=new SimulationEngine(base);for(const side of ['A','B'])isolated.setDevicePower(find(isolated,'SYD-WAN-'+side).id,false);advance(isolated,50000);const remote=isolated.ping(find(isolated,'SYD-USER').id,'10.1.10.80'),local=isolated.ping(find(isolated,'SYD-USER').id,'10.6.10.80');advance(isolated,6000);result('NEG-01','Total Sydney WAN outage blocks remote but preserves local traffic',[false,'success'],[isolated.state.probes.find(p=>p.id===remote)?.status==='success',isolated.state.probes.find(p=>p.id===local)?.status],start);
start=performance.now();const restored=new SimulationEngine(JSON.parse(JSON.stringify(base)));advance(restored,6000);result('PERSIST-01','Converged snapshot restores all cross-site paths',Array(30).fill('success'),matrix(restored),start);
json('preflight',preflight(e.snapshot()));
const capture=exportPcap(e.snapshot());writeFileSync(out+'/sample-traffic.pcap',capture.bytes);json('capture-summary',{...capture,bytes:capture.bytes.length});
json('global-enterprise-tested.shlab',e.snapshot());
// Avoid stale object references after rejected atomic commands.
const startup=[];for(const id of e.state.devices.filter(d=>d.bootManaged).map(d=>d.id)){const d=e.device(id),t=new TerminalSession(e,id);t.execute('enable');const response=t.execute('write memory');startup.push({device:d.hostname,response});}json('startup-save',startup);
json('operational-state',e.state.devices.filter(d=>d.ospf).map(d=>{const t=new TerminalSession(e,d.id);t.execute('enable');return {device:d.hostname,routes:t.execute('show ip route'),ospf:t.execute('show ip ospf neighbor'),hsrp:d.hsrp?t.execute('show standby brief'):undefined};}));
console.log('AUDIT_DONE',results.filter(r=>r.status==='pass').length,results.filter(r=>r.status==='fail').length);
