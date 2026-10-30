import {mkdirSync, writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {SimulationEngine, TerminalSession, validateSnapshot, preflight, addCanvasItem, exportPcap, ENGINE_CONTRACT_VERSION, type Device} from '../../packages/simulation-engine/src';
import {engineSourceHash} from '../../scripts/engine-build';

const out='artifacts/global-enterprise-validation-2026-10-26';
mkdirSync(out,{recursive:true});
const json=(name:string,value:unknown)=>writeFileSync(`${out}/${name}.json`,JSON.stringify(value,null,2));
const e=new SimulationEngine();
const transcript:{device:string;prompt:string;command:string;response:string}[]=[];
const cli=new Map<string,TerminalSession>();
const sites=[['NYC','New York',20],['SAO','Sao Paulo',65],['LON','London',40],['FRA','Frankfurt',45],['SIN','Singapore',110],['SYD','Sydney',140]] as const;
function command(d:Device,line:string,required=true){
  const t=cli.get(d.id)??new TerminalSession(e,d.id);cli.set(d.id,t);
  const prompt=t.prompt,response=t.execute(line);transcript.push({device:d.hostname,prompt,command:line,response});
  if(required&&response.startsWith('%'))throw new Error(`${d.hostname}: ${line}: ${response}`);
  return response;
}
function commands(d:Device,lines:string[]){for(const line of lines)command(d,line);}
function dev(profile:string,name:string,x:number,y:number){
  const d=e.addFactoryProfile(profile,{x,y});e.setDevicePower(d.id,true);
  if(d.bootManaged)commands(d,['enable','configure terminal','hostname '+name]);else d.hostname=name;
  return d;
}
function port(d:Device,id:string){return e.device(d.id).interfaces.find(p=>p.id===id)!;}
function int(d:Device,id:string,lines:string[]){commands(d,['interface '+port(d,id).name,...lines,'exit']);}
function cable(a:Device,ap:string,b:Device,bp:string,latency=0.25){
  for(const [d,id] of [[a,ap],[b,bp]] as const)Object.assign(port(d,id),{media:'rj45',speed:1000,transceiver:undefined});
  const l=e.connect({device:a.id,port:ap},{device:b.id,port:bp});l.latency=latency;return l;
}
function router(d:Device,id:string){commands(d,['router ospf 100','router-id '+id,'exit']);}
function routed(d:Device,p:string,ip:string,area:number,cost=10){int(d,p,[...(d.type==='switch'?['no switchport']:[]),'ip address '+ip+' 255.255.255.252','no shutdown','ip ospf 100 area '+area,'ip ospf network point-to-point','ip ospf cost '+cost]);}
function trunk(d:Device,p:string){int(d,p,['switchport mode trunk','switchport trunk allowed vlan 10,20,99','no shutdown']);}
function vlans(d:Device){for(const [id,name] of [[10,'CORPORATE'],[20,'GUEST'],[99,'MANAGEMENT']] as const)commands(d,['vlan '+id,'name '+name,'exit']);commands(d,['spanning-tree mode rapid-pvst']);}
const providers=['A','B'].map((s,i)=>dev('distribution','WAN-PROVIDER-'+s,1100+i*500,-250));
providers.forEach((d,i)=>{commands(d,['ip routing']);router(d,`172.31.255.${i+1}`);});
routed(providers[0],'p20','172.31.254.1',0,40);routed(providers[1],'p20','172.31.254.2',0,40);cable(providers[0],'p20',providers[1],'p20',35);
const allSites: {code:string;cores:Device[];edges:Device[];access:Device[];hosts:Record<string,Device>;links:string[]}[]=[];
for(const [index,[code,city,delay]] of sites.entries()){
  const n=index+1,x=(index%3)*1250,y=Math.floor(index/3)*1000+150;
  addCanvasItem(e,{kind:'region',text:`${code} | ${city} | area ${n} | 10.${n}.0.0/16`,position:{x:x-60,y:y-70},width:1180,height:900,color:'cyan'});
  const edges=['A','B'].map((s,i)=>dev('router',code+'-WAN-'+s,x+350+i*350,y));
  const cores=['A','B'].map((s,i)=>dev('distribution',code+'-CORE-'+s,x+250+i*450,y+250));
  const access=['A','B'].map((s,i)=>dev('access',code+'-ACCESS-'+s,x+250+i*450,y+470));
  const links:string[]=[];
  edges.forEach((d,i)=>{
    router(d,`172.30.${n}.${i+1}`);
    routed(d,'p0',`172.${20+i}.${n}.2`,0,10+i*20);
    routed(providers[i],'p'+index,`172.${20+i}.${n}.1`,0,10+i*20);
    links.push(cable(d,'p0',providers[i],'p'+index,delay+i*10).id);
  });
  cores.forEach((d,i)=>{
    commands(d,['ip routing']);router(d,`172.29.${n}.${i+1}`);vlans(d);
    commands(d,[`spanning-tree vlan 10,20,99 priority ${i?8192:4096}`]);
    for(const [j,edge] of edges.entries()){
      const subnet=4*(i*2+j),a=`10.${n}.250.${subnet+1}`,b=`10.${n}.250.${subnet+2}`;
      routed(d,'p'+j,a,n,10+j*20);routed(edge,'p'+(i+1),b,n,10+j*20);cable(d,'p'+j,edge,'p'+(i+1));
    }
    for(const v of [10,20,99]){
      commands(d,['interface Vlan'+v,'ip address '+`10.${n}.${v}.${i+2}`+' 255.255.255.0','no shutdown','ip ospf 100 area '+n]);
      // The native router-mode passive-interface gap is probed in a separate engine.
      command(d,'ip ospf passive');
      commands(d,['standby version 2',`standby ${v} ip 10.${n}.${v}.1`,`standby ${v} priority ${i?100:120}`,`standby ${v} preempt`,'exit']);
    }
    commands(d,['ip access-list extended GUEST-IN','10 deny ip any 10.0.0.0 0.255.255.255','20 permit ip any any','exit','interface Vlan20','ip access-group GUEST-IN in','exit']);
  });
  trunk(cores[0],'p2');trunk(cores[1],'p2');cable(cores[0],'p2',cores[1],'p2');
  access.forEach((sw,i)=>{
    vlans(sw);
    for(const [j,core] of cores.entries()){trunk(sw,'p'+(20+j));trunk(core,'p'+(3+i));cable(sw,'p'+(20+j),core,'p'+(3+i));}
  });
  const hosts:Record<string,Device>={};
  for(const [k,[role,vlan,suffix,swIndex,p,profile]] of [
    ['USER',10,10,0,0,'desktop'],['GUEST',20,10,0,1,'desktop'],['ADMIN',99,10,1,0,'desktop'],['DHCP',10,11,1,1,'desktop'],['APP',10,80,1,2,'web']
  ].entries()){
    const d=dev(String(profile),`${code}-${role}`,x+60+k*210,y+700);hosts[String(role)]=d;
    Object.assign(d.interfaces[0],{ip:`10.${n}.${vlan}.${suffix}`,prefix:24});d.gateway=`10.${n}.${vlan}.1`;
    int(access[Number(swIndex)],'p'+p,['switchport mode access','switchport access vlan '+vlan,'spanning-tree portfast','spanning-tree bpduguard enable','no shutdown']);
    cable(d,'p0',access[Number(swIndex)],'p'+p);
    if(role==='APP')e.configureTcpService(d.id,{enabled:true,kind:'http',port:80,body:`Global enterprise ${code} application\n`});
  }
  allSites.push({code,cores,edges,access,hosts,links});
  console.log('configured site',code);
}
const hq=allSites[0],shared:Record<string,Device>={};
for(const [i,[role,profile,suffix]] of [['DNS','dns',53],['DHCP','dhcp',67],['NTP','ntp',123],['SYSLOG','syslog',14]].entries()){
  const d=dev(String(profile),'GLOBAL-'+role,250+i*230,1000);shared[String(role)]=d;
  Object.assign(d.interfaces[0],{ip:`10.1.99.${suffix}`,prefix:24});d.gateway='10.1.99.1';
  int(hq.access[1],'p'+(5+i),['switchport mode access','switchport access vlan 99','spanning-tree portfast','no shutdown']);cable(d,'p0',hq.access[1],'p'+(5+i));
}
e.setDnsEnabled(shared.DNS.id,true);e.setDhcpEnabled(shared.DHCP.id,true);
e.configureClock(shared.NTP.id,{offsetMs:0,server:true,stratum:1});e.setSyslogEnabled(shared.SYSLOG.id,true);
const relayAttempts:unknown[]=[];
for(const [i,s] of allSites.entries()){
  e.configureDnsRecord(shared.DNS.id,{name:s.code.toLowerCase()+'.corp.test',type:'A',value:`10.${i+1}.10.80`,ttl:300});
  for(const h of Object.values(s.hosts))e.setDnsServers(h.id,'p0',['10.1.99.53']);
  // Relay uses distinct real SVI addresses; two server pools match those giaddrs.
  for(const [j,core] of s.cores.entries()){
    command(core,'interface Vlan10');relayAttempts.push({device:core.hostname,response:command(core,'ip helper-address 10.1.99.67',false)});command(core,'exit');
    e.configureDhcpPool(shared.DHCP.id,{name:s.code+'-'+j,port:'p0',network:`10.${i+1}.10.0`,prefix:24,start:`10.${i+1}.10.${150+j*20}`,end:`10.${i+1}.10.${159+j*20}`,gateway:`10.${i+1}.10.1`,relayAddress:`10.${i+1}.10.${j+2}`,dns:['10.1.99.53'],leaseMs:3600000,excluded:[],reservations:[]});
  }
}
json('relay-attempts',relayAttempts);
for(const d of e.state.devices.filter(d=>d.bootManaged)){commands(d,['end']);}
validateSnapshot(e.snapshot());
json('global-enterprise.shlab',e.snapshot());
json('design',{sites:allSites.map((s,i)=>({code:s.code,city:sites[i][1],area:i+1,prefix:`10.${i+1}.0.0/16`,devices:[...s.edges,...s.cores,...s.access,...Object.values(s.hosts)].map(d=>({hostname:d.hostname,profile:d.profile,id:d.id}))})),shared:Object.values(shared).map(d=>({hostname:d.hostname,id:d.id})),devices:e.state.devices.length,links:e.state.links.length,wan:'Two abstract routed private-IP providers, OSPF area 0; not MPLS/SD-WAN emulation',addressing:'RFC1918 site /16, VLAN10 corporate,20 guest,99 management; HSRPv2 .1; core .2/.3',latency:'Illustrative one-way provider access latency 20-140ms, +10ms backup; link cable distance is local handoff only.'});
json('configuration-transcript',transcript);
// Keep regeneration bounded by default. The original unrestricted attempt is opt-in.
if(!process.argv.includes('--run-original'))process.exit(0);
const started=performance.now();e.advanceTo(65000,1000000);console.log('converged',e.state.clock,Math.round(performance.now()-started));
const base=e.snapshot();json('global-enterprise-converged.shlab',base);
const results:{id:string;name:string;expected:unknown;observed:unknown;status:string;wallMs:number}[]=[];
function result(id:string,name:string,expected:unknown,observed:unknown,start:number){results.push({id,name,expected,observed,status:JSON.stringify(expected)===JSON.stringify(observed)?'pass':'fail',wallMs:Math.round(performance.now()-start)});console.log(id,results.at(-1)!.status);}
function matrix(s:SimulationEngine,guest=false){const probes=[];for(const a of allSites)for(const [j,b] of allSites.entries())if(a!==b)probes.push(s.ping(a.hosts[guest?'GUEST':'USER'].id,`10.${j+1}.10.10`));s.advanceTo(s.state.clock+6000,1000000);return probes.map(id=>s.state.probes.find(p=>p.id===id)?.status);}
let start=performance.now();result('DATA-01','All 30 ordered cross-site corporate ICMP paths',Array(30).fill('success'),matrix(e),start);
start=performance.now();result('SEC-01','All 30 guest-to-corporate cross-site ICMP paths denied',Array(30).fill(false),matrix(e,true).map(s=>s==='success'),start);
start=performance.now();const requests=allSites.map(s=>({source:s.hosts.USER.id,id:e.httpGet(s.hosts.USER.id,'10.1.10.80')}));e.advanceTo(e.state.clock+6000,1000000);result('APP-01','Six sites retrieve NYC corporate HTTP application',Array(6).fill(true),requests.map(r=>e.device(r.source).tcpConnections?.find(c=>c.id===r.id)?.received.includes('Global enterprise NYC')??false),start);
start=performance.now();for(const s of allSites)e.lookupDns(s.hosts.USER.id,'nyc.corp.test');e.advanceTo(e.state.clock+6000,1000000);result('DNS-01','Six sites resolve corporate DNS',Array(6).fill('success'),allSites.map(s=>e.device(s.hosts.USER.id).dnsQueries?.at(-1)?.status),start);
start=performance.now();for(const s of allSites)e.requestDhcp(s.hosts.DHCP.id,'p0');e.advanceTo(e.state.clock+8000,1000000);result('DHCP-01','Central DHCP relay acquires leases in all six sites',Array(6).fill('bound'),allSites.map(s=>e.device(s.hosts.DHCP.id).interfaces[0].dhcp?.status),start);
start=performance.now();result('CTRL-01','All six HSRP corporate groups have one active and one standby',Array(6).fill(['ACTIVE','STANDBY']),allSites.map(s=>s.cores.map(d=>e.device(d.id).hsrp?.groups.find(g=>g.group===10)?.state).sort()),start);
start=performance.now();result('CTRL-02','Every configured non-passive OSPF interface has a Full neighbor',true,e.state.devices.filter(d=>d.ospf).every(d=>d.ospf!.interfaces.filter(p=>!p.passive).every(p=>d.ospf!.neighbors.some(n=>n.port===p.port&&n.state==='Full'))),start);
const faults=[
  ['HA-01','NYC primary HSRP/core power failure',(s:SimulationEngine)=>s.setDevicePower(hq.cores[0].id,false),16000],
  ['HA-02','All six primary WAN handoff links lost',(s:SimulationEngine)=>{for(const site of allSites)s.state.links.find(l=>l.id===site.links[0])!.up=false;},50000],
  ['HA-03','Whole primary WAN provider lost',(s:SimulationEngine)=>s.setDevicePower(providers[0].id,false),50000],
  ['HA-04','London primary WAN edge power failure',(s:SimulationEngine)=>s.setDevicePower(allSites[2].edges[0].id,false),50000],
  ['HA-05','Sydney single access-to-core uplink lost',(s:SimulationEngine)=>s.setPort(allSites[5].access[0].id,'p20',false),16000],
] as const;
for(const [id,name,fail,settle] of faults){start=performance.now();const s=new SimulationEngine(base);fail(s);s.advanceTo(s.state.clock+settle,1000000);result(id,name+'; all 30 corporate ICMP paths recover',Array(30).fill('success'),matrix(s),start);json(id.toLowerCase()+'-state',{clock:s.state.clock,hsrp:s.state.devices.filter(d=>d.hsrp).map(d=>({device:d.hostname,groups:d.hsrp!.groups})),probes:s.state.probes,events:s.state.events.filter(ev=>/DROP|HSRP|OSPF|STP/.test(ev.type)||/HSRP|OSPF|STP/.test(ev.reason)).slice(-150)});validateSnapshot(s.snapshot());}
start=performance.now();const isolated=new SimulationEngine(base);for(const d of allSites[5].edges)isolated.setDevicePower(d.id,false);isolated.advanceTo(isolated.state.clock+50000,1000000);const remote=isolated.ping(allSites[5].hosts.USER.id,'10.1.10.80'),local=isolated.ping(allSites[5].hosts.USER.id,'10.6.10.80');isolated.advanceTo(isolated.state.clock+6000,1000000);result('NEG-01','Total Sydney WAN outage blocks remote but preserves local traffic',['timeout','success'],[remote,local].map(id=>isolated.state.probes.find(p=>p.id===id)?.status),start);
start=performance.now();const restored=new SimulationEngine(JSON.parse(JSON.stringify(base)));restored.advanceTo(restored.state.clock+6000,1000000);result('PERSIST-01','Converged snapshot restores all cross-site paths',Array(30).fill('success'),matrix(restored),start);
// Saved device startup is a distinct operation from saving a whole project.
const startup=e.state.devices.filter(d=>d.bootManaged).map(d=>({device:d.hostname,response:command(d,'write memory',false)}));json('startup-save',startup);
json('preflight',preflight(e.snapshot()));
const capture=exportPcap(e.snapshot());writeFileSync(out+'/sample-traffic.pcap',capture.bytes);json('capture-summary',{...capture,bytes:capture.bytes.length,excluded:capture.excluded});
json('operational-state',e.state.devices.filter(d=>d.ospf).map(d=>({device:d.hostname,route:command(d,'show ip route'),ospf:command(d,'show ip ospf neighbor'),hsrp:d.hsrp?command(d,'show standby brief'):undefined})));
json('behavior-results',{contract:ENGINE_CONTRACT_VERSION,sourceHash:engineSourceHash(),clock:e.state.clock,results,passed:results.filter(r=>r.status==='pass').length,failed:results.filter(r=>r.status==='fail').length,startupSaved:startup.filter(r=>!r.response.startsWith('%')).length,startupRejected:startup.filter(r=>r.response.startsWith('%')).length});
json('global-enterprise-tested.shlab',e.snapshot());
console.log('AUDIT_DONE',results.filter(r=>r.status==='pass').length,results.filter(r=>r.status==='fail').length);
