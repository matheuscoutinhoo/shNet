import { mkdir, writeFile } from 'node:fs/promises';
import { SimulationEngine, SimulationRunner } from '../packages/simulation-engine/src/runtime';
import { capacityTopology } from './capacity-topology';
import { ENGINE_CONTRACT_VERSION } from '../packages/simulation-engine/src/version';
import { engineSourceHash } from './engine-build';
const output = process.env.SHLAB_AUDIT_OUTPUT ?? 'artifacts/capacity-and-services-2026-10-14';
const sizes = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [100, 500, 2000];
const rows = [];
const sourceHash = engineSourceHash();
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
await mkdir(output, { recursive: true });
for (const size of sizes) {
  const topology = capacityTopology(size),
    warm = new SimulationEngine(topology.snapshot);
  const warmStarted = performance.now();
  let warmEvents = 0,
    fresh = true,
    loggedAt = warmStarted;
  do {
    warmEvents += warm.advanceTo(35000, 10000, 100, fresh);
    fresh = false;
    if (performance.now() - loggedAt >= 5000) {
      console.log(
        `Enterprise ${size}: aquecimento ${warm.state.clock.toFixed(0)}/35000 ms, ${warmEvents} eventos.`
      );
      loggedAt = performance.now();
    }
    if (warmEvents > 500000 || performance.now() - warmStarted > 600000)
      throw new Error(
        `Enterprise ${size}: aquecimento excedeu orçamento, clock=${warm.state.clock}, eventos=${warmEvents}.`
      );
  } while (warm.state.clock < 35000 || (warm.state.queue[0]?.at ?? Infinity) <= 35000);
  if (warm.state.clock < 35000) throw new Error('Aquecimento incompleto.');
  const warmWallMs = performance.now() - warmStarted;
  const snapshot = warm.snapshot(),
    clients = topology.clients.slice(0, Math.min(20, topology.clients.length));
  await writeFile(`${output}/enterprise-${size}.shlab.json`, JSON.stringify(snapshot));
  const trials = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    console.log(`Enterprise ${size}: repetição ${repeat + 1}/3`);
    global.gc?.();
    const runner = new SimulationRunner(snapshot),
      slices: number[] = [],
      deltas: number[] = [];
    const initial = runner.engine.state.clock,
      started = performance.now();
    const requests: { source: string; id: string }[] = [];
    const request = (source: string, target = '10.60.40.10') =>
      requests.push({ source, id: runner.engine.httpGet(source, target) });
    const received = () =>
      requests.filter(({ source, id }) =>
        runner.engine
          .device(source)
          .tcpConnections?.find((c) => c.id === id)
          ?.received.includes('200 OK')
      ).length;
    let sent = 0,
      events = 0;
    const advance = (target: number) => {
      let count = 0;
      do {
        const at = performance.now(),
          delta = runner.advanceUntil(target, 100);
        slices.push(performance.now() - at);
        deltas.push(Buffer.byteLength(JSON.stringify(delta)));
        events += delta.processed;
        if (++count > 20000) throw new Error('Carga excedeu limite de processamento.');
      } while (
        runner.engine.state.clock < target ||
        (runner.engine.state.queue[0]?.at ?? Infinity) <= target
      );
    };
    for (let round = 1; round <= 6; round++) {
      for (const id of clients) {
        runner.engine.lookupDns(id, 'erp.enterprise.test');
        request(id);
        sent++;
      }
      request(runner.engine.state.devices.find((d) => d.hostname === 'TENANT-A-CLIENT')!.id, '10.80.100.100');
      sent++;
      advance(initial + round * 1000);
    }
    const responses = received();
    if (responses !== sent) throw new Error(`Enterprise ${size}: ${responses}/${sent} respostas.`);
    const dnsResponses = clients.reduce(
      (count, id) =>
        count + (runner.engine.device(id).dnsQueries?.filter((q) => q.status === 'success').length ?? 0),
      0
    );
    if (dnsResponses !== clients.length * 6) throw new Error('DNS não completou a carga concorrente.');
    const normalSlices = slices.length,
      elapsedMs = performance.now() - started,
      beforeFailover = responses;
    runner.engine.setDevicePower(runner.engine.state.devices.find((d) => d.hostname === 'FW-A')!.id, false);
    advance(initial + 12000);
    for (const id of clients) request(id);
    advance(initial + 14000);
    const afterFailover = received();
    if (afterFailover - beforeFailover !== clients.length)
      throw new Error('HTTP não recuperou após perda do gateway.');
    trials.push({
      elapsedMs,
      virtualMs: 6000,
      realtimeRatio: 6000 / elapsedMs,
      concurrentClients: clients.length,
      sent,
      responses,
      dnsResponses,
      failoverResponses: afterFailover - beforeFailover,
      failoverObservation:
        '20 novas requisições após 6 s virtuais de espera; respostas verificadas até 8 s após a falha. Não mede o primeiro instante de recuperação.',
      events,
      p95NormalChunkMs: percentile(slices.slice(0, normalSlices), 0.95),
      p95FailoverChunkMs: percentile(slices.slice(normalSlices), 0.95),
      maxChunkMs: Math.max(...slices),
      p95DeltaBytes: percentile(deltas, 0.95),
      heapMiB: process.memoryUsage().heapUsed / 1048576,
    });
  }
  rows.push({ devices: size, clients: topology.clients.length, warmEvents, warmWallMs, trials });
  console.log(JSON.stringify(rows.at(-1)));
}
await writeFile(
  `${output}/enterprise-capacity.json`,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      engineContract: ENGINE_CONTRACT_VERSION,
      engineSourceHash: sourceHash,
      platform: process.platform,
      repeats: 3,
      workerBudgetMs: 100,
      workload:
        'Campus ampliado sobre enterprise/DC nativo: RSTP, VRRP, firewall/state sync, DNS, BGP/EVPN e HTTP concorrente entre campus e ERP/tenant; perda de FW-A após carga normal.',
      limits:
        'Node local/CI, budget 100 ms do modo realtime da aplicação; inclui delta e serialização JSON. Aquecimento fora da medição; não certifica SLA de produção, heap de navegador ou ausência de SPOFs nos ramos de acesso.',
      passed: true,
      results: rows,
    },
    null,
    2
  )
);
