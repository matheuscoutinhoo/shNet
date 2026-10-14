import { mkdir, writeFile } from 'node:fs/promises';
import {
  SimulationEngine,
  SimulationRunner,
  makeTemplate,
  validateSnapshot,
  layoutTopology,
} from '../packages/simulation-engine/src';
const out = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/application-stability-2026-10-13';
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const results = [];
for (const size of [38, 100, 500, 2000]) {
  let source;
  if (size === 38) {
    const e = new SimulationEngine(makeTemplate('enterprise-datacenter'));
    e.advanceTo(35000, 200000);
    source = e.snapshot();
  } else {
    const e = new SimulationEngine(),
      count = Math.ceil(size / 6),
      switches = [];
    for (let i = 0; i < count; i++) switches.push(e.addDevice('switch', { x: i * 20, y: 0 }));
    for (let i = 1; i < count; i++)
      e.connect(
        { device: switches[i].id, port: 'p0' },
        { device: switches[Math.floor((i - 1) / 2)].id, port: i % 2 ? 'p1' : 'p2' }
      );
    for (let i = 0; i < size - count; i++) {
      const host = e.addDevice('pc');
      Object.assign(host.interfaces[0], {
        ip: `10.20.${Math.floor((i + 1) / 256)}.${(i + 1) % 256}`,
        prefix: 16,
      });
      e.configureSystem(host.id, {
        enabled: true,
        capacityPps: 100000,
        memoryLimitKiB: 65536,
        ambientC: 22,
        thermalLimitC: 85,
      });
      e.connect(
        { device: host.id, port: 'p0' },
        { device: switches[Math.floor(i / 5)].id, port: 'p' + (3 + (i % 5)) }
      );
    }
    source = e.snapshot();
  }
  const trials = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed,
      validation = performance.now();
    validateSnapshot(source);
    const validateMs = performance.now() - validation;
    const layoutAt = performance.now();
    const layout = layoutTopology(source);
    const layoutMs = performance.now() - layoutAt;
    if (layout.snapshot.devices.length !== size) throw new Error('Layout perdeu equipamento.');
    const runner = new SimulationRunner(source),
      chunks = [],
      bytes = [],
      started = performance.now(),
      initial = runner.engine.state.clock;
    let processed = 0,
      sent = 0;
    let complete: number;
    for (let step = 0; step < 6; step++) {
      const e = runner.engine,
        target = initial + (step + 1) * 500;
      if (size === 38) {
        for (const [hostname, address] of [
          ['USER-PC', '10.60.40.10'],
          ['TENANT-A-CLIENT', '10.80.100.100'],
        ]) {
          e.httpGet(e.state.devices.find((d) => d.hostname === hostname)!.id, address);
          sent++;
        }
      } else {
        const hosts = e.state.devices.filter((d) => d.type === 'pc');
        e.ping(hosts[0].id, hosts.at(-1)!.interfaces[0].ip!);
        sent++;
      }
      let slices = 0;
      do {
        const at = performance.now(),
          delta = runner.advanceUntil(target, 20);
        chunks.push(performance.now() - at);
        bytes.push(Buffer.byteLength(JSON.stringify(delta)));
        processed += delta.processed;
        if (++slices > 10000) throw new Error('Benchmark excedeu o orçamento.');
      } while (
        runner.engine.state.clock < target ||
        (runner.engine.state.queue[0]?.at ?? Infinity) <= target
      );
    }
    if (size === 38)
      complete = runner.engine.state.devices
        .filter((d) => ['USER-PC', 'TENANT-A-CLIENT'].includes(d.hostname))
        .reduce(
          (n, d) => n + (d.tcpConnections?.filter((c) => c.received.includes('200 OK')).length ?? 0),
          0
        );
    else complete = runner.engine.state.probes.filter((p) => p.status === 'success').length;
    if (complete < sent) throw new Error(`Carga ${size}: ${complete}/${sent} respostas.`);
    trials.push({
      validateMs,
      layoutMs,
      wallMs: performance.now() - started,
      simulatedMs: 3000,
      realtimeRatio: 3000 / (performance.now() - started),
      chunks: chunks.length,
      p95ChunkMs: percentile(chunks, 0.95),
      maxChunkMs: Math.max(...chunks),
      p95DeltaBytes: percentile(bytes, 0.95),
      processed,
      responses: complete,
      sent,
      snapshotBytes: Buffer.byteLength(JSON.stringify(runner.engine.state)),
      captureDropped: runner.engine.state.capture?.dropped ?? 0,
      heapBeforeMiB: heapBefore / 1048576,
      heapDuringMiB: process.memoryUsage().heapUsed / 1048576,
    });
  }
  const row = {
    devices: size,
    workload:
      size === 38
        ? 'Enterprise/DC nativo: controle BGP/EVPN/VRRP + HTTP ERP/LB; aquecimento fora da medição'
        : 'Árvore L2 com capacidade de hosts e seis ICMP entre extremos; não equivale a fabric enterprise',
    trials,
  };
  results.push(row);
  process.stdout.write(JSON.stringify(row) + '\n');
}
await mkdir(out, { recursive: true });
await writeFile(
  out + '/performance.json',
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      generatedAt: new Date().toISOString(),
      repeats: 3,
      workerBudgetMs: 20,
      gcAvailable: Boolean(global.gc),
      limitations:
        'Processo Node local; inclui custo de delta. Não certifica SLA de produção nem heap do navegador. Executar sem regressão concorrente.',
      results,
    },
    null,
    2
  )
);
