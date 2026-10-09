import { mkdir, writeFile } from 'node:fs/promises';
import { SimulationEngine, SimulationRunner, validateSnapshot } from '../packages/simulation-engine/src';
const sizes = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [100, 500, 1250, 2000];
const results = [];
for (const size of sizes) {
  if (!Number.isInteger(size) || size < 12 || size > 2000) throw new Error('Use 12..2000 equipamentos.');
  const start = performance.now(),
    e = new SimulationEngine(),
    switchCount = Math.ceil(size / 6),
    switches = Array.from({ length: switchCount }, (_, i) =>
      e.addDevice('switch', { x: (i % 32) * 240, y: Math.floor(i / 32) * 200 })
    ),
    hosts = [];
  for (let i = 1; i < switches.length; i++)
    e.connect(
      { device: switches[i].id, port: 'p0' },
      { device: switches[Math.floor((i - 1) / 2)].id, port: i % 2 ? 'p1' : 'p2' }
    );
  for (let i = 0; i < size - switchCount; i++) {
    const d = e.addDevice('pc', { x: (i % 32) * 240, y: 2000 + Math.floor(i / 32) * 200 });
    Object.assign(d.interfaces[0], { ip: `10.20.${Math.floor((i + 1) / 256)}.${(i + 1) % 256}`, prefix: 16 });
    e.configureSystem(d.id, {
      enabled: true,
      capacityPps: 100000,
      memoryLimitKiB: 65536,
      ambientC: 22,
      thermalLimitC: 85,
    });
    e.connect(
      { device: d.id, port: 'p0' },
      { device: switches[Math.floor(i / 5)].id, port: 'p' + (3 + (i % 5)) }
    );
    hosts.push(d);
  }
  const buildMs = performance.now() - start,
    snapshot = e.snapshot(),
    check = performance.now();
  validateSnapshot(snapshot);
  const validateMs = performance.now() - check;
  e.ping(hosts[0].id, hosts.at(-1)!.interfaces[0].ip!);
  if (size === 2000) {
    await mkdir('.data/benchmarks', { recursive: true });
    await writeFile('.data/benchmarks/topology2000.json', JSON.stringify(e.snapshot()));
  }
  const runner = new SimulationRunner(e.snapshot()),
    run = performance.now();
  let events = 0,
    chunks = 0,
    maxChunkMs = 0;
  while (runner.engine.state.queue.length) {
    const at = performance.now(),
      delta = runner.step(200, 20);
    maxChunkMs = Math.max(maxChunkMs, performance.now() - at);
    events += delta.processed;
    chunks++;
    if (chunks > 5000) throw new Error('Benchmark excedeu orçamento.');
  }
  const simulationMs = performance.now() - run,
    result = {
      devices: size,
      links: e.state.links.length,
      buildMs: Math.round(buildMs),
      validateMs: Math.round(validateMs),
      simulationMs: Math.round(simulationMs),
      events,
      chunks,
      maxChunkMs: Math.round(maxChunkMs),
      status: runner.engine.state.probes[0].status,
      snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
    };
  if (result.status !== 'success') throw new Error('Ping do benchmark falhou.');
  results.push(result);
  process.stdout.write(JSON.stringify(result) + '\n');
}
await mkdir('benchmarks', { recursive: true });
await writeFile(
  'benchmarks/scale.json',
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      generatedAt: new Date().toISOString(),
      scenario:
        'Árvore L2, recursos habilitados nos hosts, um ARP/ICMP entre extremos; execução em lotes/deltas.',
      results,
    },
    null,
    2
  ) + '\n'
);
