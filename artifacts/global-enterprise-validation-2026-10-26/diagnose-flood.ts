import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {SimulationEngine,TerminalSession} from '../../packages/simulation-engine/src';
const out='artifacts/global-enterprise-validation-2026-10-26',e=new SimulationEngine(JSON.parse(readFileSync(out+'/global-enterprise.shlab.json','utf8')));
e.advanceTo(30000,300000);writeFileSync(out+'/before-storm.shlab.json',JSON.stringify(e.snapshot()));
const tree=e.state.devices.filter(d=>d.type==='switch').map(d=>{const t=new TerminalSession(e,d.id);t.execute('enable');return {device:d.hostname,output:t.execute('show spanning-tree'),multi:d.multiSpanningTree,ports:d.interfaces.filter(p=>p.spanningTree).map(p=>({name:p.name,id:p.id,mode:p.mode,spanningTree:p.spanningTree}))};});
const start=performance.now();let events=0;while(e.state.clock<32000&&performance.now()-start<5000)events+=e.advanceTo(32000,20000,100);
writeFileSync(out+'/storm-diagnosis.json',JSON.stringify({clock:e.state.clock,wallMs:performance.now()-start,events,queue:e.state.queue.length,tree,recent:e.state.events.slice(-50),queued:e.state.queue.slice(0,30)},null,2));
writeFileSync(out+'/storm-checkpoint.shlab.json',JSON.stringify(e.snapshot()));console.log('STORM',e.state.clock,e.state.queue.length);
