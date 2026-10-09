import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  TerminalSession,
} from '../packages/simulation-engine/src';
function lab() {
  const e = new SimulationEngine(makeTemplate('mpls')),
    pc = e.state.devices.find((d) => d.hostname === 'CE-A')!,
    r1 = e.state.devices.find((d) => d.hostname === 'PE-A')!,
    r2 = e.state.devices.find((d) => d.hostname === 'P-CORE')!,
    r3 = e.state.devices.find((d) => d.hostname === 'PE-B')!;
  return { e, pc, r1, r2, r3 };
}
describe('MPLS estático encaminha pelo label', () => {
  it('QoS classifica MPLS TC e marca o label sem alterar a entrega', () => {
    const { e, pc, r1 } = lab();
    e.configureQos(r1.id, 'p1', {
      enabled: true,
      rateMbps: 1,
      queueLimit: 16,
      scheduler: 'priority',
      classes: [{ name: 'LABEL', protocol: 'mpls', tc: 0, priority: 7, weight: 2, markTc: 7 }],
    });
    const id = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(1000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    expect(
      e.state.events.some(
        (v) => v.type === 'FRAME_SENT' && v.device === r1.id && v.frame?.mpls?.labels[0].tc === 7
      )
    ).toBe(true);
    expect(r1.interfaces[1].qos?.stats[0].dequeued).toBeGreaterThan(0);
    validateSnapshot(e.snapshot());
  });
  it('FEC push, LFIB swap/pop transportam ping e HTTP nas duas direções', () => {
    const { e, pc } = lab();
    const ping = e.ping(pc.id, '10.2.0.20'),
      tcp = e.httpGet(pc.id, '10.2.0.20');
    e.advanceTo(1000);
    expect(e.state.probes.find((p) => p.id === ping)?.status).toBe('success');
    expect(pc.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('labels MPLS');
    expect(e.state.events.some((v) => v.type === 'MPLS_PUSH')).toBe(true);
    expect(e.state.events.some((v) => v.type === 'MPLS_SWAP')).toBe(true);
    expect(e.state.events.some((v) => v.type === 'MPLS_POP')).toBe(true);
    const labels = e.state.events
      .filter((v) => v.type === 'FRAME_SENT' && v.frame?.mpls)
      .map((v) => v.frame!.mpls!.labels[0].value);
    expect(labels).toContain(100);
    expect(labels).toContain(200);
    validateSnapshot(e.snapshot());
  });
  it('label desconhecido e MTU impedem entrega; TTL gera erro ICMP relacionado', () => {
    const { e, pc, r2, r1 } = lab();
    const ttl = e.ping(pc.id, '10.2.0.20', 2);
    e.advanceTo(100);
    expect(e.state.probes.find((p) => p.id === ttl)?.status).toBe('time-exceeded');
    r2.mpls!.lfib = r2.mpls!.lfib.filter((f) => f.incoming !== 100);
    const missing = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(30100);
    expect(e.state.probes.find((p) => p.id === missing)?.status).toBe('timeout');
    expect(e.state.events.some((v) => v.reason.includes('sem LFIB'))).toBe(true);
    r1.interfaces[1].mtu = 80;
    const mtu = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(60200);
    expect(e.state.probes.find((p) => p.id === mtu)?.status).toBe('timeout');
    expect(e.state.events.some((v) => v.reason.includes('MTU'))).toBe(true);
  });
  it('pilha de labels e pop em trânsito preservam label interno', () => {
    const { e, pc, r1, r2, r3 } = lab();
    r1.mpls!.ingress[0].labels = [100, 500];
    r2.mpls!.lfib[0] = { incoming: 100, operation: 'pop', port: 'p1', nextHop: '198.51.100.2' };
    r3.mpls!.lfib = [{ incoming: 500, operation: 'pop' }];
    const id = e.ping(pc.id, '10.2.0.20');
    e.advanceTo(1000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    expect(
      e.state.events.some(
        (v) => v.type === 'FRAME_SENT' && v.device === r2.id && v.frame?.mpls?.labels[0].value === 500
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('restaura labels aguardando ARP e recusa tamanho adulterado; CLI aplica LFIB', () => {
    const { e, pc, r1, r2 } = lab();
    e.ping(pc.id, '10.2.0.20');
    for (let n = 0; n < 100 && !r1.pending.some((p) => p.mpls); n++) e.step();
    const pending = e.snapshot(),
      restored = new SimulationEngine(pending);
    e.advanceTo(1000);
    restored.advanceTo(1000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const bad = structuredClone(pending);
    bad.devices.find((d) => d.id === r1.id)!.pending.find((p) => p.mpls)!.mpls!.bytes++;
    expect(() => validateSnapshot(bad)).toThrow(/ARP\/MPLS/);
    const cli = new TerminalSession(e, r2.id);
    cli.execute('enable');
    cli.execute('configure terminal');
    expect(
      cli.execute(
        'mpls lfib {"incoming":100,"operation":"swap","outgoing":[200],"port":"p1","nextHop":"198.51.100.2"}'
      )
    ).not.toMatch(/^%/);
    expect(cli.execute('show mpls forwarding-table')).toContain('200');
  });
});
