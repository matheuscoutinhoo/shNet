import {readFileSync,writeFileSync} from 'node:fs';
import {SimulationEngine,validateSnapshot} from '../../packages/simulation-engine/src';
const out='artifacts/global-enterprise-validation-2026-10-26',e=new SimulationEngine(JSON.parse(readFileSync(out+'/global-enterprise-converged.shlab.json','utf8'))),codes=['NYC','SAO','LON','FRA','SIN','SYD'];
const clients=codes.map(code=>e.state.devices.find(d=>d.hostname===code+'-ADMIN')!);
const messages=clients.map((d,i)=>{e.configureClock(d.id,{offsetMs:1000+i*100,server:false,stratum:1});e.configureNtp(d.id,{enabled:true,servers:['10.1.99.123'],intervalMs:5000});e.configureSyslog(d.id,{enabled:true,server:'10.1.99.14',severity:7,automatic:false});return {device:d.hostname,id:e.sendSyslog(d.id,'Enterprise audit '+d.hostname,6)};});
e.advanceTo(e.state.clock+8000,300000);validateSnapshot(e.snapshot());const collector=e.state.devices.find(d=>d.hostname==='GLOBAL-SYSLOG')!;
const results=clients.map(d=>({device:d.hostname,synchronized:d.ntp?.synchronized,offsetMs:d.networkClock?.offsetMs,receivedSyslog:collector.syslogServer?.entries.some(m=>m.message.hostname===d.hostname&&m.message.text==='Enterprise audit '+d.hostname)}));
writeFileSync(out+'/management-services.json',JSON.stringify({results,messages,passed:results.every(r=>r.synchronized&&Math.abs(r.offsetMs??Infinity)<1&&r.receivedSyslog)},null,2));console.log(JSON.stringify(results));
