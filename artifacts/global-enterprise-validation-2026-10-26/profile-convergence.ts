import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {SimulationEngine} from '../../packages/simulation-engine/src';
const out='artifacts/global-enterprise-validation-2026-10-26',e=new SimulationEngine(JSON.parse(readFileSync(out+'/global-enterprise.shlab.json','utf8'))),start=performance.now(),samples:unknown[]=[];
let events=0,next=0;while(e.state.clock<65000&&performance.now()-start<30000){events+=e.advanceTo(65000,20000,100);if(performance.now()-start>=next){const row={wallMs:Math.round(performance.now()-start),clock:e.state.clock,processed:events,queued:e.state.queue.length,firstActions:e.state.queue.slice(0,5).map(a=>({at:a.at,kind:a.action.kind})),eventTypes:Object.fromEntries([...new Set(e.state.events.map(e=>e.type))].map(t=>[t,e.state.events.filter(e=>e.type===t).length]))};samples.push(row);console.log(JSON.stringify(row));next+=5000;}}
writeFileSync(out+'/convergence-profile.json',JSON.stringify(samples,null,2));
