import {SimulationEngine,makeTemplate} from '../../packages/simulation-engine/src';
const e=new SimulationEngine(makeTemplate('factory'));const d=e.state.devices.find(d=>d.hostname==='PC-FINANCEIRO')!;
const events:unknown[]=[];const emit=e.emit.bind(e);e.emit=(...args)=>{const result=emit(...args);if(args[0].startsWith('DHCP') || args[0]==='FIREWALL_DENY' || (args[0]==='PACKET_DROPPED' && args[3]?.frame?.packet?.protocol==='UDP'))events.push({at:e.state.clock,type:args[0],device:e.device(args[1]).hostname,reason:args[2]});return result;};
e.requestDhcp(d.id,'p0');for(let i=0;i<12;i++){e.advanceTo(e.state.clock+1000,100000);console.log(JSON.stringify({at:e.state.clock,dhcp:d.interfaces[0].dhcp,ip:d.interfaces[0].ip}));}console.log(JSON.stringify(events));
