import { readFileSync, writeFileSync } from 'node:fs';
import { SimulationEngine } from '../../packages/simulation-engine/src/index';
const engine = new SimulationEngine(JSON.parse(readFileSync('artifacts/factory-audit/factory-final.shlab.json', 'utf8')));
engine.state.events = [];
engine.state.diagnostics = [];
const device = (name: string) => engine.state.devices.find(d => d.hostname === name)!;
const started = engine.state.clock;
engine.setDevicePower(device('DIST-A').id, false);
const measurements = [];
for (let second = 0; second < 40; second++) {
  engine.advanceTo(started + second * 1000, 100000);
  const id = engine.ping(device('SCADA').id, '10.20.40.10');
  engine.advanceTo(started + second * 1000 + 900, 100000);
  measurements.push({second, probe: engine.state.probes.find(p => p.id === id), ports: engine.state.devices.filter(d => d.type === 'switch').map(d => ({ name: d.hostname, root: d.spanningTree?.root, ports: d.interfaces.filter(p=>p.spanningTree).map(p=>({name:p.name,state:p.spanningTree?.state,role:p.spanningTree?.role,transitionAt:p.spanningTree?.transitionAt})) }))});
}
writeFileSync('artifacts/factory-audit/failover-diagnosis.json',JSON.stringify({measurements,diagnostics:engine.state.diagnostics},null,2));
console.log(JSON.stringify(measurements.map(m=>({second:m.second,status:m.probe?.status,rtt:m.probe?.rtt}))));
