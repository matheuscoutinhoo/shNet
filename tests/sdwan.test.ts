import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  sdwanConfig,
  tunnelConfig,
  validateSnapshot,
  TerminalSession,
} from '../packages/simulation-engine/src';
function lab() {
  const e = new SimulationEngine(makeTemplate('sdwan')),
    a = e.state.devices.find((d) => d.hostname === 'WAN-A')!,
    b = e.state.devices.find((d) => d.hostname === 'WAN-B')!,
    pc = e.state.devices.find((d) => d.hostname === 'LAN-A')!,
    controller = e.state.devices.find((d) => d.hostname === 'WAN-CONTROLLER')!;
  return { e, a, b, pc, controller };
}
describe('SD-WAN usa caminhos e políticas transportados pela rede', () => {
  it('controller entrega política autenticada, WEB prefere Internet e falha usa MPLS', () => {
    const { e, a, pc } = lab();
    e.advanceTo(5000);
    expect(a.sdwan?.receivedPolicies[0]?.name).toBe('WEB');
    expect(a.sdwan?.lastController).toBeDefined();
    const first = e.httpGet(pc.id, '10.2.0.20');
    e.advanceTo(6000);
    expect(pc.tcpConnections?.find((c) => c.id === first)?.received).toContain('overlay sdwan');
    expect(a.sdwan?.selected[0]?.port).toBe('tun1');
    const internet = e.state.links.find((l) => l.a.device === a.id && l.a.port === 'p1')!;
    internet.up = false;
    e.advanceTo(10000);
    const second = e.httpGet(pc.id, '10.2.0.20');
    e.advanceTo(12000);
    expect(pc.tcpConnections?.find((c) => c.id === second)?.received).toContain('overlay sdwan');
    expect(a.sdwan?.selected[0]?.port).toBe('tun2');
    expect(e.state.events.some((v) => v.type === 'SDWAN_PATH' && v.port === 'tun2')).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('SLA filtra RTT medido; política estrita bloqueia e fallback aceita caminho fora do SLA', () => {
    const { e, a, pc, controller } = lab();
    controller.sdwanController!.enabled = false;
    const c = sdwanConfig(a);
    delete c.controller;
    delete c.underlay;
    delete c.key;
    const policy = {
      name: 'ALL',
      match: { destination: { network: '10.2.0.0', prefix: 24 }, protocol: 'ip' },
      prefer: ['mpls', 'internet'],
      maxRtt: 15,
      maxLoss: 0,
      fallback: false,
    };
    e.configureSdwan(a.id, { ...c, policies: [policy] });
    e.advanceTo(6000);
    const first = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(7000);
    expect(e.state.probes.find((p) => p.id === first)?.status).toBe('success');
    expect(a.sdwan?.selected[0]?.port).toBe('tun1');
    e.configureSdwan(a.id, { ...sdwanConfig(a), policies: [{ ...policy, maxRtt: 1 }] });
    const blocked = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(8000);
    expect(e.state.probes.find((p) => p.id === blocked)?.status).toBe('unreachable');
    e.configureSdwan(a.id, { ...sdwanConfig(a), policies: [{ ...policy, maxRtt: 1, fallback: true }] });
    const backup = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(9000);
    expect(e.state.probes.find((p) => p.id === backup)?.status).toBe('success');
    expect(a.sdwan?.selected[0]?.port).toBe('tun2');
    validateSnapshot(e.snapshot());
  });
  it('recusa controller com chave errada e restaura solicitações/políticas em voo', () => {
    const { e, a } = lab();
    e.configureSdwan(a.id, { ...sdwanConfig(a), key: 'Incorrect-Key-123' });
    e.advanceTo(3000);
    expect(a.sdwan?.receivedPolicies).toHaveLength(0);
    e.configureSdwan(a.id, { ...sdwanConfig(a), key: 'Controller-Key-123' });
    e.advanceTo(3001);
    const replay = new SimulationEngine(e.snapshot());
    e.advanceTo(7000);
    replay.advanceTo(7000);
    expect(replay.snapshot()).toEqual(e.snapshot());
    expect(a.sdwan?.receivedPolicies).toHaveLength(1);
    const bad = e.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'sdwan-tick');
    expect(() => validateSnapshot(bad)).toThrow(/Timer SD-WAN/);
  });
  it('CLI configura política e túnel, não divulga chave nos logs e reverte underlay inválido', () => {
    const { e, a } = lab();
    const cli = new TerminalSession(e, a.id);
    cli.execute('enable');
    cli.execute('configure terminal');
    expect(cli.execute('sdwan site LOCAL')).not.toMatch(/^%/);
    const p = a.interfaces.find((p) => p.id === 'tun1')!,
      c = tunnelConfig(p);
    expect(cli.execute('tunnel configure ' + JSON.stringify(c))).not.toMatch(/^%/);
    expect(a.logs.join('\n')).not.toContain(c.key);
    const prior = e.snapshot();
    expect(cli.execute('tunnel configure ' + JSON.stringify({ ...c, underlay: 'tun2' }))).toMatch(/^%/);
    expect(e.snapshot()).toEqual(prior);
    expect(cli.execute('show tunnels')).toContain('Tunnel1');
    expect(cli.execute('show running-config')).toContain('[configured]');
    expect(cli.execute('show running-config')).not.toContain(c.key);
  });
});
