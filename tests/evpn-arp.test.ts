import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  vxlanConfig,
  TerminalSession,
  BROADCAST,
  type Frame,
} from '../packages/simulation-engine/src';
import { replyEvpnArp } from '../packages/simulation-engine/src/protocols/evpn-arp';
import { encodeBgp, bgpByteString } from '../packages/simulation-engine/src/protocols/bgp-codec';

function lab() {
  const e = new SimulationEngine(makeTemplate('evpn'));
  const a = e.state.devices.find((d) => d.hostname === 'VTEP-A')!;
  const b = e.state.devices.find((d) => d.hostname === 'VTEP-B')!;
  const pc = e.state.devices.find((d) => d.hostname === 'VM-A')!;
  const server = e.state.devices.find((d) => d.hostname === 'VM-B')!;
  const port = a.interfaces.find((p) => p.vxlan)!;
  e.configureVxlan(a.id, { ...vxlanConfig(port), peerPolicy: 'evpn', proxyArp: true });
  const remote = b.interfaces.find((p) => p.vxlan)!;
  e.configureVxlan(b.id, { ...vxlanConfig(remote), peerPolicy: 'evpn' });
  e.advanceTo(4000);
  e.ping(pc.id, '10.50.0.20');
  e.advanceTo(6000);
  expect(port.vxlan!.routes.some((r) => r.ip === '10.50.0.20')).toBe(true);
  pc.arpTable = [];
  return { e, a, b, pc, server, port };
}
describe('Supressão ARP EVPN por bindings recebidos', () => {
  it('responde localmente com a MAC real aprendida e preserva ping/HTTP pelo overlay', () => {
    const { e, a, pc, server } = lab();
    const start = e.state.clock,
      ping = e.ping(pc.id, '10.50.0.20');
    e.advanceTo(start + 1000);
    expect(e.state.probes.find((p) => p.id === ping)?.status).toBe('success');
    expect(pc.arpTable.find((r) => r.ip === '10.50.0.20')?.mac).toBe(server.interfaces[0].mac);
    const events = e.state.events.filter((event) => event.time >= start && event.device === a.id);
    expect(events.some((event) => event.type === 'EVPN_ARP_REPLIED')).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'VXLAN_ENCAP' &&
          event.frame?.arp?.kind === 'request' &&
          event.frame.arp.targetIp === '10.50.0.20'
      )
    ).toBe(false);
    const tcp = e.httpGet(pc.id, '10.50.0.20');
    e.advanceTo(start + 2000);
    expect(pc.tcpConnections!.find((c) => c.id === tcp)?.received).toContain('overlay VXLAN');
    validateSnapshot(e.snapshot());
  });
  it('não responde por IP desconhecido e mantém a descoberta normal no overlay', () => {
    const { e, a, pc } = lab();
    const start = e.state.clock;
    e.ping(pc.id, '10.50.0.99');
    e.advanceTo(start + 1000);
    expect(
      e.state.events.some(
        (event) => event.time >= start && event.device === a.id && event.type === 'EVPN_ARP_REPLIED'
      )
    ).toBe(false);
    expect(
      e.state.events.some(
        (event) =>
          event.time >= start &&
          event.device === a.id &&
          event.type === 'VXLAN_ENCAP' &&
          event.frame?.arp?.targetIp === '10.50.0.99'
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('exige IMET, sessão e caminho underlay operacionais para usar o binding', () => {
    for (const failure of ['member', 'underlay'] as const) {
      const { e, a, pc, port } = lab();
      const start = e.state.clock;
      if (failure === 'member') port.vxlan!.members = [];
      else e.setPort(a.id, 'p1', false);
      e.ping(pc.id, '10.50.0.20');
      e.advanceTo(start + 500);
      expect(
        e.state.events.some(
          (event) => event.time >= start && event.device === a.id && event.type === 'EVPN_ARP_REPLIED'
        )
      ).toBe(false);
      validateSnapshot(e.snapshot());
    }
  });
  it('não mascara probes, ARP gratuito, atualização unicast ou ingresso de outro VTEP', () => {
    const { e, a, pc, port } = lab();
    const frame: Frame = {
      src: pc.interfaces[0].mac,
      dst: BROADCAST,
      etherType: 'ARP',
      hops: 64,
      arp: {
        kind: 'request',
        senderIp: '10.50.0.10',
        senderMac: pc.interfaces[0].mac,
        targetIp: '10.50.0.20',
      },
    };
    const input = a.interfaces[0];
    expect(replyEvpnArp(e, a, input, { ...frame, arp: { ...frame.arp!, senderIp: '0.0.0.0' } }, 10)).toBe(
      false
    );
    expect(replyEvpnArp(e, a, input, { ...frame, arp: { ...frame.arp!, senderIp: '10.50.0.20' } }, 10)).toBe(
      false
    );
    expect(replyEvpnArp(e, a, input, { ...frame, dst: '02:01:02:03:04:05' }, 10)).toBe(false);
    expect(replyEvpnArp(e, a, port, frame, 10)).toBe(false);
    expect(replyEvpnArp(e, a, input, frame, 20)).toBe(false);
  });
  it('preserva a descoberta normal diante de bindings ambíguos de IP/MAC', () => {
    const { e, a, b, pc, port } = lab();
    const binding = port.vxlan!.routes.find((r) => r.ip === '10.50.0.20')!;
    const { peer: _, learnedAt: __, ...path } = binding;
    const frames = encodeBgp({
      type: 'UPDATE',
      announcements: [],
      withdrawn: [],
      evpnAnnouncements: [{ ...path, mac: '02:01:02:03:04:05', asPath: [b.bgp!.asn] }],
    });
    e.writeTcp(b.id, b.bgp!.peers[0].connection!, frames.map(bgpByteString).join(''));
    e.advanceTo(6500);
    expect(port.vxlan!.routes.filter((r) => r.ip === '10.50.0.20')).toHaveLength(2);
    const start = e.state.clock;
    e.ping(pc.id, '10.50.0.20');
    e.advanceTo(start + 1000);
    expect(
      e.state.events.some(
        (event) => event.time >= start && event.device === a.id && event.type === 'EVPN_ARP_REPLIED'
      )
    ).toBe(false);
    validateSnapshot(e.snapshot());
  });
  it('RT divergente e retirada da sessão deixam de autorizar respostas locais', () => {
    const { e, a, b, pc } = lab();
    const remote = b.interfaces.find((p) => p.vxlan)!;
    e.configureVxlan(b.id, { ...vxlanConfig(remote), routeTarget: '65000:999' });
    e.advanceTo(10000);
    const start = e.state.clock;
    e.ping(pc.id, '10.50.0.20');
    e.advanceTo(start + 1000);
    expect(
      e.state.events.some(
        (event) => event.time >= start && event.device === a.id && event.type === 'EVPN_ARP_REPLIED'
      )
    ).toBe(false);
    validateSnapshot(e.snapshot());
  });
  it('restaura uma resposta pendente, conserva configuração e recusa proxy sem EVPN estrito', () => {
    const { e, a, pc, port } = lab();
    e.ping(pc.id, '10.50.0.20');
    e.advanceTo(6002);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(8000);
    restored.advanceTo(8000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const cli = new TerminalSession(e, a.id);
    cli.execute('enable');
    expect(cli.execute('show running-config')).toContain('"proxyArp":true');
    const before = e.snapshot();
    expect(() =>
      e.configureVxlan(a.id, { ...vxlanConfig(port), proxyArp: true, peerPolicy: 'static' })
    ).toThrow();
    expect(e.snapshot()).toEqual(before);
    const invalid = e.snapshot();
    invalid.devices.find((d) => d.id === a.id)!.interfaces.find((p) => p.vxlan)!.vxlan!.evpn = false;
    expect(() => validateSnapshot(invalid)).toThrow();
  });
});
