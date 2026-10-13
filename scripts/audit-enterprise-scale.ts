import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SimulationEngine, validateSnapshot, type Snapshot } from '../packages/simulation-engine/src';
const out = 'artifacts/enterprise-datacenter-audit';
const initial: Snapshot = JSON.parse(readFileSync(out + '/enterprise-datacenter.shlab.json', 'utf8'));
const results = [];
for (const hosts of [0, 24, 48]) {
  const engine = new SimulationEngine(initial),
    leaves = engine.state.devices.filter((d) => d.hostname.startsWith('LEAF-'));
  for (let i = 0; i < hosts; i++) {
    const host = engine.addDevice('pc', { x: 2200 + (i % 3) * 350, y: 1400 + Math.floor(i / 3) * 75 });
    host.hostname = 'VM-SCALE-' + i;
    Object.assign(host.interfaces[0], { ip: '10.80.100.' + (30 + i), prefix: 24, speed: 1000 });
    const leaf = leaves[i % 3],
      port = leaf.interfaces[6 + Math.floor(i / 3)];
    Object.assign(port, { accessVlan: 100, media: 'rj45', transceiver: undefined, speed: 1000 });
    engine.connect({ device: host.id, port: 'p0' }, { device: leaf.id, port: port.id });
  }
  validateSnapshot(engine.snapshot());
  const startMemory = process.memoryUsage().heapUsed,
    start = performance.now();
  const convergenceSteps = engine.advanceTo(15000, 300000);
  const probeStart = engine.state.probes.length;
  const sources = engine.state.devices.filter(
    (d) => d.hostname.startsWith('VM-SCALE-') || d.hostname === 'TENANT-A-CLIENT'
  );
  for (const source of sources) engine.ping(source.id, '10.80.100.11');
  const trafficStart = engine.state.clock,
    steps = engine.advanceTo(trafficStart + 5000, 300000);
  const probes = engine.state.probes.slice(probeStart);
  const snapshot = engine.snapshot();
  validateSnapshot(snapshot);
  results.push({
    devices: snapshot.devices.length,
    links: snapshot.links.length,
    hostsAdded: hosts,
    virtualMs: snapshot.clock,
    wallMs: Math.round(performance.now() - start),
    convergenceSteps,
    trafficSteps: steps,
    probes: probes.length,
    successful: probes.filter((p) => p.status === 'success').length,
    heapDeltaMiB: Math.round((process.memoryUsage().heapUsed - startMemory) / 1048576),
    snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    captureDropped: snapshot.capture?.dropped,
    queue: snapshot.queue.length,
  });
  console.log(JSON.stringify(results.at(-1)));
}
writeFileSync(
  out + '/scale-results.json',
  JSON.stringify(
    {
      method:
        'Amostra local, uma execução por perfil; sem warmup/GC forçado. Heap delta não mede vazamento. Sem certificação de escala de produção.',
      results,
    },
    null,
    2
  )
);
