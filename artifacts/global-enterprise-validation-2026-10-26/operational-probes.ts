import {writeFileSync} from 'node:fs';
import {SimulationEngine,TerminalSession,makeTemplate,validateSnapshot} from '../../packages/simulation-engine/src';
const out='artifacts/global-enterprise-validation-2026-10-26';
const e=new SimulationEngine();e.advanceTo(60000);const d=e.addFactoryProfile('router');e.setDevicePower(d.id,true);const t=new TerminalSession(e,d.id);t.execute('enable');
const bootUptime=t.execute('show version');t.execute('reload');t.execute('enable');const reloadUptime=t.execute('show version');
const b=new SimulationEngine(makeTemplate('bgp'));b.advanceTo(15000);const [a,mid,c,client,server]=b.state.devices;
const before={peers:[a,mid,c].map(d=>({device:d.hostname,states:d.bgp!.peers.map(p=>p.state)})),nextHop:a.bgp!.routes.find(r=>r.network==='192.168.20.0')?.nextHop};
const baseline=b.ping(client.id,server.interfaces[0].ip!);b.advanceTo(16000);b.setPort(a.id,'p1',false);b.advanceTo(23000);const recovered=b.ping(client.id,server.interfaces[0].ip!);b.advanceTo(25000);validateSnapshot(b.snapshot());
writeFileSync(out+'/operational-probes.json',JSON.stringify({uptime:{expected:'A newly booted/reloaded device has near-zero uptime despite the lab clock being 60s',bootUptime,reloadUptime},bgp:{before,baseline:b.state.probes.find(p=>p.id===baseline),afterFailureNextHop:a.bgp!.routes.find(r=>r.network==='192.168.20.0')?.nextHop,recovered:b.state.probes.find(p=>p.id===recovered)}},null,2));console.log('Operational probes written');
