import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  vxlanConfig,
} from '../packages/simulation-engine/src';
function lab(template: 'vxlan' | 'evpn' = 'vxlan') {
  const e = new SimulationEngine(makeTemplate(template)),
    a = e.state.devices.find((d) => d.hostname === 'VTEP-A')!,
    b = e.state.devices.find((d) => d.hostname === 'VTEP-B')!,
    pc = e.state.devices.find((d) => d.hostname === 'VM-A')!,
    server = e.state.devices.find((d) => d.hostname === 'VM-B')!,
    x = a.interfaces.find((p) => p.vxlan)!,
    y = b.interfaces.find((p) => p.vxlan)!;
  return { e, a, b, pc, server, x, y };
}
describe('VXLAN e EVPN encaminham Ethernet por underlay IP', () => {
  it('movimento físico de uma VM anuncia MAC/IP com sequência maior no novo VTEP', () => {
    const { e, a, b, pc, x, y } = lab('evpn');
    e.advanceTo(2000);
    e.ping(pc.id, '10.50.0.20');
    e.advanceTo(5000);
    const old = y.vxlan!.routes.find((r) => r.mac === pc.interfaces[0].mac)!;
    expect(old.ip).toBe('10.50.0.10');
    e.removeLink(e.state.links.find((l) => [l.a, l.b].some((end) => end.device === pc.id))!.id);
    b.interfaces[2].accessVlan = 20;
    e.connect({ device: pc.id, port: 'p0' }, { device: b.id, port: 'p2' });
    const ping = e.ping(pc.id, '10.50.0.20');
    e.advanceTo(8000);
    expect(e.state.probes.find((p) => p.id === ping)?.status).toBe('success');
    const moved = x.vxlan!.routes.find((r) => r.mac === pc.interfaces[0].mac)!;
    expect(moved.sequence).toBeGreaterThan(old.sequence);
    expect(moved.ip).toBe('10.50.0.10');
    expect(moved.nextHop).toBe('198.51.100.2');
    expect(a.bgp?.peers[0].state).toBe('Established');
    validateSnapshot(e.snapshot());
  });
  it('ARP, ICMP e HTTP atravessam VLANs locais distintas no mesmo VNI', () => {
    const { e, pc, a, b, x, y } = lab();
    const id = e.ping(pc.id, '10.50.0.20'),
      tcp = e.httpGet(pc.id, '10.50.0.20');
    e.advanceTo(2000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    expect(pc.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('overlay VXLAN');
    expect(x.vxlan?.sent).toBeGreaterThan(0);
    expect(y.vxlan?.received).toBeGreaterThan(0);
    expect(a.macTable.some((m) => m.vlan === 10 && m.port === x.id)).toBe(true);
    expect(b.macTable.some((m) => m.vlan === 20 && m.port === y.id)).toBe(true);
    expect(
      e.state.events.some(
        (v) =>
          v.type === 'FRAME_SENT' &&
          v.frame?.packet?.protocol === 'UDP' &&
          v.frame.packet.destinationPort === 4789
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('VNI diferente impede broadcast/dados e MTU do underlay impede encapsulamento', () => {
    const { e, b, pc, y, a } = lab();
    e.configureVxlan(b.id, { ...vxlanConfig(y), enabled: false });
    e.configureVxlan(b.id, { ...vxlanConfig(y), vni: 20020, vlan: 30, enabled: true });
    b.interfaces[0].accessVlan = 30;
    const failed = e.ping(pc.id, '10.50.0.20');
    e.advanceTo(31000);
    expect(e.state.probes.find((p) => p.id === failed)?.status).toBe('timeout');
    expect(e.state.events.some((v) => v.reason.includes('VNI/peer/underlay'))).toBe(true);
    e.configureVxlan(b.id, { ...vxlanConfig(y), enabled: true });
    b.interfaces[0].accessVlan = 20;
    a.interfaces[1].mtu = 64;
    const mtu = e.ping(pc.id, '10.50.0.20');
    e.advanceTo(62000);
    expect(e.state.probes.find((p) => p.id === mtu)?.status).toBe('timeout');
    expect(e.state.events.some((v) => v.reason.includes('MTU'))).toBe(true);
  });
  it('IPv6 NDP e Echo atravessam o overlay sem alterar Hop Limit', () => {
    const { e, pc, server } = lab();
    for (const [d, ip] of [
      [pc, '2001:db8:50::10'],
      [server, '2001:db8:50::20'],
    ] as const)
      e.configureIpv6(d.id, 'p0', { auto: false, addresses: [{ ip, prefix: 64 }] });
    e.advanceTo(4000);
    const id = e.ping6(pc.id, '2001:db8:50::20', 1);
    e.advanceTo(5000);
    expect(e.state.probes6?.find((p) => p.id === id)?.status).toBe('success');
    validateSnapshot(e.snapshot());
  });
  it('EVPN negocia BGP, anuncia MACs/RT e usa RIB em vez de flooding desconhecido', () => {
    const { e, a, b, pc, x, y, server } = lab('evpn');
    e.advanceTo(2000);
    expect(a.bgp?.peers[0].state).toBe('Established');
    e.ping(pc.id, '10.50.0.20');
    e.advanceTo(5000);
    expect(
      x.vxlan?.routes.some((r) => r.mac === server.interfaces[0].mac && r.nextHop === '198.51.100.2')
    ).toBe(true);
    expect(
      y.vxlan?.routes.some((r) => r.mac === pc.interfaces[0].mac && r.routeTarget === '65000:10010')
    ).toBe(true);
    a.macTable = [];
    b.macTable = [];
    x.vxlan!.learned = [];
    y.vxlan!.learned = [];
    const start = e.state.events.length;
    const tcp = e.httpGet(pc.id, '10.50.0.20');
    e.advanceTo(5500);
    expect(pc.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('overlay VXLAN');
    expect(
      e.state.events
        .slice(start)
        .filter(
          (v) => v.device === a.id && v.type === 'FRAME_FLOODED' && v.frame?.dst === server.interfaces[0].mac
        )
    ).toHaveLength(0);
    expect(e.state.events.some((v) => v.type === 'EVPN_INSTALL')).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('route target impede importação e fim de sessão retira MACs de controle', () => {
    const { e, a, b, pc, x, y } = lab('evpn');
    e.configureVxlan(b.id, { ...vxlanConfig(y), routeTarget: '65000:999' });
    e.advanceTo(2000);
    e.ping(pc.id, '10.50.0.20');
    e.advanceTo(5000);
    expect(x.vxlan?.routes).toHaveLength(0);
    e.configureVxlan(b.id, { ...vxlanConfig(y), routeTarget: '65000:10010' });
    e.advanceTo(12000);
    e.ping(pc.id, '10.50.0.20');
    e.advanceTo(15000);
    expect(x.vxlan?.routes.length).toBeGreaterThan(0);
    a.interfaces[1].adminUp = false;
    e.advanceTo(16000);
    expect(x.vxlan?.routes).toHaveLength(0);
    expect(a.bgp?.peers[0].state).not.toBe('Established');
    validateSnapshot(e.snapshot());
  });
  it('restaura BGP e UDP pendentes, recusa referências e não conecta porta virtual', () => {
    const { e, a, b, pc, x, y } = lab('evpn');
    e.advanceTo(2000);
    e.ping(pc.id, '10.50.0.20');
    const restored = new SimulationEngine(JSON.parse(JSON.stringify(e.snapshot())));
    e.advanceTo(5000);
    restored.advanceTo(5000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(() => e.connect({ device: a.id, port: x.id }, { device: b.id, port: y.id })).toThrow(/físicas/);
    const bad = e.snapshot();
    bad.devices.find((d) => d.id === a.id)!.interfaces.find((p) => p.vxlan)!.vxlan!.underlay = x.id;
    expect(() => validateSnapshot(bad)).toThrow(/VXLAN/);
  });
});
