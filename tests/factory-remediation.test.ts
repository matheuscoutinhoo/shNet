import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  SimulationRunner,
  applySimulationDelta,
  exportPcap,
  decodePcap,
  makeTemplate,
  validateSnapshot,
} from '../packages/simulation-engine/src';

describe('Correções da auditoria de fábrica', () => {
  it('template preserva comunicação após falha da distribuição e da UPS primárias', () => {
    for (const fault of ['distribution', 'power']) {
      const e = new SimulationEngine(makeTemplate('factory'));
      const find = (name: string) => e.state.devices.find((d) => d.hostname === name)!;
      if (fault === 'distribution') e.setDevicePower(find('DIST-A').id, false);
      else {
        const ups = find('UPS-A');
        e.configureInfrastructure(ups.id, { ...ups.infrastructure, mains: false, remainingWh: 0.1 });
      }
      e.advanceTo(e.state.clock + 5000, 100000);
      const id = e.ping(find('SCADA').id, '10.20.40.10');
      e.advanceTo(e.state.clock + 1000, 100000);
      expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
      validateSnapshot(e.snapshot());
    }
  });
  it('template bloqueia visitantes ao MES e mantém DHCP/WAN após perda do firewall primário', () => {
    const e = new SimulationEngine(makeTemplate('factory'));
    const find = (name: string) => e.state.devices.find((d) => d.hostname === name)!;
    const visitor = e.state.devices.find((d) => d.wireless?.role === 'client')!;
    const blocked = e.httpGet(visitor.id, '10.20.20.10');
    e.advanceTo(e.state.clock + 1000, 100000);
    expect(visitor.tcpConnections?.find((c) => c.id === blocked)?.received).not.toContain('200 OK');
    expect(e.state.events.some((ev) => ev.type === 'FIREWALL_DENY')).toBe(true);
    e.setDevicePower(find('FW-A').id, false);
    e.advanceTo(e.state.clock + 5000, 100000);
    e.requestDhcp(find('PC-FINANCEIRO').id, 'p0');
    const wan = e.httpGet(find('PC-ERP').id, '198.51.100.10');
    e.advanceTo(e.state.clock + 3000, 100000);
    expect(find('PC-FINANCEIRO').interfaces[0].ip).toBeDefined();
    expect(find('PC-ERP').tcpConnections?.find((c) => c.id === wan)?.received).toContain('200 OK');
    validateSnapshot(e.snapshot());
  });
  it('avança até o horizonte virtual sem saltar eventos futuros e preserva deltas', () => {
    const source = new SimulationEngine(makeTemplate('lan'));
    source.ping(source.state.devices[0].id, '192.168.10.20');
    const reference = new SimulationEngine(source.snapshot());
    const main = new SimulationEngine(source.snapshot());
    const runner = new SimulationRunner(source.snapshot());
    reference.advanceTo(10000);
    for (let i = 0; i < 100 && runner.engine.state.clock < 10000; i++)
      applySimulationDelta(main.state, structuredClone(runner.advanceUntil(10000, 100)));
    expect(main.snapshot()).toEqual(reference.snapshot());
    expect(main.state.clock).toBe(10000);
    expect(() => runner.advanceUntil(9999)).toThrow();
  });
  it('preserva pacotes e resultado após o histórico visual expirar', () => {
    const e = new SimulationEngine(makeTemplate('lan'));
    const pc = e.state.devices[0];
    e.ping(pc.id, '192.168.10.20');
    e.advanceTo(1000);
    const packets = exportPcap(e.state).packets;
    expect(packets).toBeGreaterThan(0);
    for (let i = 0; i < 1600; i++) e.emit('CONFIG_CHANGED', pc.id, 'Histórico visual');
    expect(e.state.events.some((ev) => ev.type === 'PING_SUCCESS')).toBe(false);
    expect(e.state.diagnostics?.some((ev) => ev.type === 'PING_SUCCESS')).toBe(true);
    expect(decodePcap(exportPcap(e.state).bytes)).toHaveLength(packets);
    const restored = validateSnapshot(e.snapshot());
    expect(exportPcap(restored).packets).toBe(packets);
  });
  it('conserva ida/volta ICMP após 30 segundos de controle da fábrica', () => {
    const e = new SimulationEngine(makeTemplate('factory'));
    const scada = e.state.devices.find((d) => d.hostname === 'SCADA')!;
    const id = e.ping(scada.id, '10.20.40.10');
    e.advanceTo(e.state.clock + 1000, 100000);
    const frames = e.state.capture!.frames.filter((ev) => ev.frame?.packet?.protocol === 'ICMP');
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    e.advanceTo(e.state.clock + 30000, 100000);
    expect(e.state.diagnostics?.some((ev) => ev.type === 'PING_SUCCESS')).toBe(true);
    expect(frames.every((ev) => e.state.capture!.frames.some((f) => f.id === ev.id))).toBe(true);
    expect(exportPcap(e.state).packets).toBeGreaterThan(0);
  }, 60000);
  it('mant?m reten??o por bytes id?ntica no Worker e na interface', () => {
    const e = new SimulationEngine(makeTemplate('lan'));
    e.ping(e.state.devices[0].id, '192.168.10.20');
    e.advanceTo(1000);
    const frame = e.state.capture!.frames[0].frame!;
    const main = new SimulationEngine(e.snapshot());
    const runner = new SimulationRunner(e.snapshot());
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 500; i++)
        runner.engine.emit('FRAME_SENT', e.state.devices[0].id, 'x'.repeat(500), { frame });
      applySimulationDelta(main.state, structuredClone(runner.advanceUntil(runner.engine.state.clock, 100)));
      expect(main.state.capture).toEqual(runner.engine.state.capture);
    }
    expect(main.state.capture!.dropped).toBeGreaterThan(0);
    expect(main.state.capture!.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    validateSnapshot(main.snapshot());
  });
  it('oferece SNMP e syslog em SVI L2 sem habilitar encaminhamento L3', () => {
    const e = new SimulationEngine(makeTemplate('svi'));
    const sw = e.state.devices.find((d) => d.type === 'switch')!;
    sw.ipRouting = false;
    const pc = e.state.devices.find((d) => d.type === 'pc')!;
    e.configureSnmpAgent(sw.id, { enabled: true, community: 'public' });
    e.setSyslogEnabled(sw.id, true);
    e.configureSyslog(pc.id, { enabled: true, server: '192.168.10.1', automatic: false });
    e.sendSyslog(pc.id, 'SVI L2 operacional');
    const query = e.querySnmp(pc.id, '192.168.10.1', 'public', ['1.3.6.1.2.1.1.5.0']);
    e.advanceTo(1000);
    expect(pc.snmpQueries?.find((q) => q.id === query)?.status).toBe('success');
    expect(sw.syslogServer?.entries.some((x) => x.message.text === 'SVI L2 operacional')).toBe(true);
    expect(sw.ipRouting).toBe(false);
    validateSnapshot(e.snapshot());
  });
});
