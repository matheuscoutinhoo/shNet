import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  telemetryConfig,
  ntpConfig,
} from '../packages/simulation-engine/src';
function lab() {
  const e = new SimulationEngine(makeTemplate('routed')),
    pc = e.state.devices[0],
    router = e.state.devices.find((d) => d.type === 'router')!,
    server = e.state.devices.find((d) => d.type === 'server')!;
  e.configureCollector(server.id, { enabled: true, key: 'telemetry-key' });
  e.configureTelemetry(router.id, {
    enabled: true,
    collector: server.interfaces[0].ip,
    key: 'telemetry-key',
    intervalMs: 1000,
    sensors: ['interfaces', 'routes', 'tcp', 'qos', 'aaa'],
  });
  e.configureClock(server.id, { offsetMs: 0, server: true, stratum: 1 });
  e.configureClock(pc.id, { offsetMs: 300, server: false, stratum: 1 });
  e.configureNtp(pc.id, { enabled: true, servers: [server.interfaces[0].ip], intervalMs: 5000 });
  return { e, pc, router, server };
}
describe('telemetria periódica e sincronização NTP', () => {
  it('coletor recebe sensores reais em UDP respeitando MTU, timestamps e counters', () => {
    const { e, pc, router, server } = lab();
    const ping = e.ping(pc.id, server.interfaces[0].ip!);
    e.advanceTo(4000);
    expect(e.state.probes.find((p) => p.id === ping)?.status).toBe('success');
    expect(server.telemetryCollector?.received).toBeGreaterThan(3);
    const values = server.telemetryCollector!.records.flatMap((r) => r.message.metrics);
    expect(values.some((v) => v.path === '/interfaces/p0/rx' && v.value > 0)).toBe(true);
    expect(values.some((v) => v.path === '/routing/static/count' && v.value === router.routes.length)).toBe(
      true
    );
    expect(
      e.state.events.some(
        (ev) =>
          ev.frame?.packet?.protocol === 'UDP' &&
          ev.frame.packet.payload.protocol === 'TELEMETRY' &&
          ev.frame.packet.destinationPort === 57500
      )
    ).toBe(true);
    expect(router.telemetry?.sequence).toBe(server.telemetryCollector?.received);
    validateSnapshot(e.snapshot());
  });
  it('NTP calcula offset/RTT com quatro timestamps e corrige relógio sem alterar a simulação', () => {
    const { e, pc } = lab();
    e.advanceTo(1000);
    expect(pc.ntp?.synchronized).toBe(true);
    expect(pc.ntp?.stratum).toBe(2);
    expect(Math.abs(pc.networkClock!.offsetMs)).toBeLessThan(0.001);
    expect(pc.ntp?.samples[0].offsetMs).toBeCloseTo(-300, 2);
    expect(pc.ntp?.samples[0].delayMs).toBeGreaterThan(0);
    expect(e.state.clock).toBe(1000);
    expect(
      e.state.events.some(
        (ev) =>
          ev.frame?.packet?.protocol === 'UDP' &&
          ev.frame.packet.payload.protocol === 'NTP' &&
          ev.frame.packet.sourcePort === 123
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('NTP faz failover quando peer silencia e snapshots preservam consultas/amostras', () => {
    const { e, pc, server } = lab();
    e.configureNtp(pc.id, { ...ntpConfig(pc), servers: ['192.168.20.99', server.interfaces[0].ip!] });
    e.advanceTo(1);
    const restored = new SimulationEngine(JSON.parse(JSON.stringify(e.snapshot())));
    e.advanceTo(6000);
    restored.advanceTo(6000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(pc.ntp?.failures).toBe(1);
    expect(pc.ntp?.synchronized).toBe(true);
    expect(pc.ntp?.index).toBe(1);
    const bad = e.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'ntp-tick');
    expect(() => validateSnapshot(bad)).toThrow('NTP');
  });
  it('shared secret/replay de telemetria são recusados e ACL bloqueia datagramas reais', () => {
    const { e, router, server } = lab();
    e.configureTelemetry(router.id, { ...telemetryConfig(router), key: 'wrong-secret' });
    e.advanceTo(1000);
    expect(server.telemetryCollector?.received).toBe(0);
    expect(server.telemetryCollector?.rejected).toBeGreaterThan(0);
    e.configureTelemetry(router.id, { ...telemetryConfig(router), key: 'telemetry-key' });
    e.advanceTo(2200);
    const record = server.telemetryCollector!.records[0],
      count = server.telemetryCollector!.received;
    const packet = {
      protocol: 'UDP' as const,
      src: record.source,
      dst: server.interfaces[0].ip!,
      sourcePort: 57501,
      destinationPort: 57500,
      ttl: 64,
      bytes: 28 + new TextEncoder().encode(JSON.stringify(record.message)).length,
      payload: { protocol: 'TELEMETRY' as const, message: record.message },
    };
    e.sendIp(router.id, packet);
    e.advanceTo(2500);
    expect(server.telemetryCollector?.received).toBe(count);
    expect(e.state.events.some((ev) => ev.reason.includes('replay/ordem antiga'))).toBe(true);
    e.configureAcl(router.id, { name: 'BLOCK-TELEMETRY', rules: [] });
    e.bindAcl(router.id, 'p1', 'out', 'BLOCK-TELEMETRY');
    e.advanceTo(4000);
    expect(server.telemetryCollector?.received).toBe(count);
    validateSnapshot(e.snapshot());
  });
  it('telemetria com MTU reduzida é dividida em datagramas e alterações falsas são rejeitadas', () => {
    const { e, router, server } = lab();
    router.interfaces[1].mtu = 576;
    e.advanceTo(1000);
    expect(server.telemetryCollector?.received).toBeGreaterThan(2);
    expect(
      e.state.events
        .filter(
          (ev) => ev.frame?.packet?.protocol === 'UDP' && ev.frame.packet.payload.protocol === 'TELEMETRY'
        )
        .every((ev) => ev.frame!.packet!.bytes <= 576)
    ).toBe(true);
    const bad = e.snapshot();
    bad.devices.find((d) => d.id === server.id)!.telemetryCollector!.records[0].message.metrics[0].value =
      9999;
    expect(() => validateSnapshot(bad)).toThrow('Coletor');
  });
});
