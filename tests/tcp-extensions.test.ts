import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  validateSnapshot,
  tcpBytes,
  tcpOptionBytes,
  makeTemplate,
  type TcpPacket,
} from '../packages/simulation-engine/src';
import { receiveTcp } from '../packages/simulation-engine/src/protocols/tcp';
import { makeTcpPacket } from '../packages/simulation-engine/src/protocols/tcp-wire';
import { receiveTcpMtu } from '../packages/simulation-engine/src/protocols/tcp-pmtud';
const settings = { sack: true, ecn: true, timestamps: true, pmtud: true, mss: 536 };
function network(peer = true) {
  const e = new SimulationEngine(),
    pc = e.addDevice('pc'),
    srv = e.addDevice('server');
  Object.assign(pc.interfaces[0], { ip: '10.0.0.10', prefix: 24 });
  Object.assign(srv.interfaces[0], { ip: '10.0.0.20', prefix: 24 });
  e.connect({ device: pc.id, port: 'p0' }, { device: srv.id, port: 'p0' });
  e.configureTcpSettings(pc.id, settings);
  if (peer) e.configureTcpSettings(srv.id, settings);
  e.configureTcpService(srv.id, { enabled: true, kind: 'echo', port: 7 });
  e.openTcp(pc.id, '10.0.0.20', 7);
  e.advanceTo(5000);
  return { e, pc, srv, c: pc.tcpConnections![0], s: srv.tcpConnections![0] };
}
function packets(e: SimulationEngine) {
  return e.state.events.flatMap((event) =>
    event.type === 'FRAME_SENT' && event.frame?.packet?.protocol === 'TCP' ? [event.frame.packet] : []
  );
}
function until(e: SimulationEngine, condition: () => boolean) {
  for (let i = 0; i < 1500 && !condition(); i++) {
    expect(e.step()).toBe(true);
    validateSnapshot(e.snapshot());
  }
  expect(condition()).toBe(true);
}
describe('Extensões TCP interoperáveis no modelo', () => {
  it('negocia ECN através de PAT e firewall stateful sem rejeitar o SYN e preserva a sessão', () => {
    const e = new SimulationEngine(makeTemplate('tcp')),
      pc = e.state.devices.find((d) => d.type === 'pc')!,
      server = e.state.devices.find((d) => d.type === 'server')!,
      router = e.state.devices.find((d) => d.firewall)!;
    for (const d of [pc, server]) e.configureTcpSettings(d.id, { ...settings, mss: 1460 });
    e.httpGet(pc.id, '192.168.20.10');
    until(e, () => !!router.firewall!.sessions.length);
    const restored = new SimulationEngine(e.snapshot());
    restored.advanceTo(3000);
    e.advanceTo(3000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(pc.tcpConnections![0].received).toContain('HTTP/1.1 200 OK');
    expect(pc.tcpConnections![0].extensions).toMatchObject({ sack: true, ecn: true, timestamps: true });
    expect(router.firewall!.dropped).toBe(0);
    expect(router.nat!.bindings.some((b) => b.protocol === 'TCP')).toBe(true);
  });
  it('negocia opções somente com suporte do peer e mantém tamanhos e restauração determinísticos', () => {
    const { e, pc, c, s } = network();
    expect(c.extensions).toMatchObject({ sack: true, ecn: true, timestamps: true });
    expect(s.extensions).toMatchObject({ sack: true, ecn: true, timestamps: true });
    const syn = packets(e).find((p) => p.flags.includes('SYN') && !p.flags.includes('ACK'))!;
    expect(syn.flags).toContain('ECE');
    expect(syn.flags).toContain('CWR');
    expect(syn.ecn).toBeUndefined();
    expect(syn.options).toMatchObject({ mss: 536, sackPermitted: true });
    expect(syn.bytes).toBe(56);
    const text = 'TCP 🌐 '.repeat(250);
    e.writeTcp(pc.id, c.id, text);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(9000);
    restored.advanceTo(9000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(c.received).toBe(text);
    expect(
      packets(e)
        .filter((p) => p.data)
        .every((p) => p.bytes === 40 + tcpOptionBytes(p.options) + tcpBytes(p.data))
    ).toBe(true);
    const old = network(false);
    expect(old.c.extensions).toMatchObject({ sack: false, ecn: false, timestamps: false });
    old.e.writeTcp(old.pc.id, old.c.id, 'legacy');
    old.e.advanceTo(6000);
    expect(old.c.received).toBe('legacy');
    validateSnapshot(old.e.snapshot());
    const invalid = e.snapshot();
    invalid.devices.find((d) => d.id === pc.id)!.tcpConnections![0].extensions!.local.sack = false;
    expect(() => validateSnapshot(invalid)).toThrow('Negociação');
  });
  it('respeita a MTU local mesmo quando a reação PMTUD está desabilitada', () => {
    const { e, pc, srv } = network();
    pc.interfaces[0].mtu = 576;
    srv.interfaces[0].mtu = 576;
    e.configureTcpSettings(pc.id, { ...settings, mss: 8960, pmtud: false });
    e.configureTcpSettings(srv.id, { ...settings, mss: 8960, pmtud: false });
    const id = e.openTcp(pc.id, '10.0.0.20', 7);
    e.advanceTo(6000);
    const c = pc.tcpConnections!.find((c) => c.id === id)!;
    const text = 'MTU 🌐 '.repeat(200);
    e.writeTcp(pc.id, id, text);
    e.advanceTo(10000);
    expect(c.received).toBe(text);
    expect(
      packets(e)
        .filter((p) => p.traceId === id)
        .every((p) => p.bytes <= 576)
    ).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('recupera perda com MSS jumbo sem ultrapassar os limites da janela', () => {
    const { e, pc, srv } = network();
    pc.interfaces[0].mtu = 9216;
    srv.interfaces[0].mtu = 9216;
    e.configureTcpSettings(pc.id, { ...settings, mss: 8960 });
    e.configureTcpSettings(srv.id, { ...settings, mss: 8960 });
    const id = e.openTcp(pc.id, '10.0.0.20', 7);
    e.advanceTo(6000);
    const c = pc.tcpConnections!.find((c) => c.id === id)!;
    e.writeTcp(pc.id, id, 'j'.repeat(10000));
    e.state.queue = e.state.queue.filter(
      ({ action: a }) =>
        !(
          a.kind === 'deliver' &&
          a.from === pc.id &&
          a.frame.packet?.protocol === 'TCP' &&
          a.frame.packet.traceId === id
        )
    );
    until(e, () => c.retransmissions > 0);
    const restored = new SimulationEngine(e.snapshot());
    restored.advanceTo(15000);
    e.advanceTo(15000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(c.received).toBe('j'.repeat(10000));
  });
  it('SACK identifica blocos recebidos e recupera duas lacunas sem reenviar os segmentos confirmados', () => {
    const { e, pc, c, s } = network();
    e.writeTcp(pc.id, c.id, 'a'.repeat(4500));
    e.advanceTo(6000);
    const sequence = c.sendNext,
      text = 'b'.repeat(5000),
      drop = new Set([sequence, (sequence + 1072) >>> 0]);
    e.writeTcp(pc.id, c.id, text);
    e.state.queue = e.state.queue.filter(
      ({ action: a }) =>
        !(
          a.kind === 'deliver' &&
          a.from === pc.id &&
          a.frame.packet?.protocol === 'TCP' &&
          a.frame.packet.data &&
          drop.has(a.frame.packet.sequence)
        )
    );
    until(e, () => !!c.flow?.flight.some((p) => p.sacked));
    expect(s.flow!.receiveQueue.length).toBeGreaterThan(0);
    expect(packets(e).some((p) => p.options?.sack?.length)).toBe(true);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(10000);
    restored.advanceTo(10000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(c.received).toBe('a'.repeat(4500) + text);
    expect(c.retransmissions).toBe(2);
    validateSnapshot(e.snapshot());
  });
  it('marca CE na fila QoS, recebe ECE, reduz cwnd e confirma CWR em novos dados', () => {
    const { e, pc, c, s } = network();
    e.configureQos(pc.id, 'p0', {
      enabled: true,
      rateMbps: 0.5,
      queueLimit: 32,
      ecnThreshold: 1,
      scheduler: 'priority',
      classes: [],
    });
    e.writeTcp(pc.id, c.id, 'c'.repeat(3500));
    until(e, () => e.state.events.some((v) => v.reason.includes('ECN/ECE')));
    expect(
      c.extensions!.cwr ||
        e.state.events.some((v) => v.type === 'TCP_SENT' && v.device === pc.id && v.reason.includes('CWR'))
    ).toBe(true);
    expect(c.flow!.ssthresh).toBeLessThan(16384);
    e.advanceTo(6500);
    e.writeTcp(pc.id, c.id, 'CWR confirmation');
    e.advanceTo(8000);
    expect(packets(e).some((p) => p.ecn === 3)).toBe(true);
    expect(packets(e).some((p) => !p.flags.includes('SYN') && p.flags.includes('ECE'))).toBe(true);
    expect(packets(e).some((p) => p.data && p.flags.includes('CWR'))).toBe(true);
    expect(s.extensions!.ecnEcho).toBe(false);
    expect(c.received).toBe('c'.repeat(3500) + 'CWR confirmation');
    validateSnapshot(e.snapshot());
  });
  it('PAWS descarta timestamps antigos e não avança a sequência de recepção', () => {
    const { e, pc, c, s } = network(),
      sequence = c.receiveNext,
      packet = makeTcpPacket(s, ['ACK', 'PSH'], 'stale', e.state.clock);
    packet.options!.timestamp!.value = (c.extensions!.timestampRecent! - 1) >>> 0;
    receiveTcp(e, pc, packet);
    expect(c.receiveNext).toBe(sequence);
    expect(c.received).toBe('');
    expect(e.state.events.some((event) => event.reason.includes('PAWS'))).toBe(true);
    validateSnapshot(e.snapshot());
  });
  for (const { family, nat } of [
    { family: 4, nat: '' },
    { family: 4, nat: 'PAT' },
    { family: 4, nat: 'dinâmico' },
    { family: 4, nat: 'estático' },
    { family: 6, nat: '' },
  ])
    it(`PMTUD IPv${family}${nat ? ' com NAT ' + nat + '/firewall' : ''} recebe ICMP real e segmenta na MTU menor sem duplicar UTF-8`, () => {
      const e = new SimulationEngine(),
        pc = e.addDevice('pc'),
        r = e.addDevice('router'),
        srv = e.addDevice('server');
      e.connect({ device: pc.id, port: 'p0' }, { device: r.id, port: 'p0' });
      e.connect({ device: srv.id, port: 'p0' }, { device: r.id, port: 'p1' });
      for (const d of [pc, srv]) e.configureTcpSettings(d.id, { ...settings, mss: 1460 });
      if (family === 4) {
        Object.assign(pc.interfaces[0], { ip: '10.1.0.10', prefix: 24 });
        pc.gateway = '10.1.0.1';
        Object.assign(srv.interfaces[0], { ip: '10.2.0.10', prefix: 24 });
        srv.gateway = '10.2.0.1';
        Object.assign(r.interfaces[0], { ip: '10.1.0.1', prefix: 24 });
        Object.assign(r.interfaces[1], { ip: '10.2.0.1', prefix: 24, mtu: 576 });
        srv.interfaces[0].mtu = 576;
        if (nat) {
          r.interfaces[0].natRole = 'inside';
          r.interfaces[1].natRole = 'outside';
          e.configureNat(r.id, {
            enabled: true,
            statics: nat === 'estático' ? [{ inside: '10.1.0.10', global: '10.2.0.99', outside: 'p1' }] : [],
            pools:
              nat === 'estático'
                ? []
                : [
                    {
                      name: 'PAT',
                      source: { network: '10.1.0.0', prefix: 24 },
                      outside: 'p1',
                      start: nat === 'PAT' ? '10.2.0.1' : '10.2.0.99',
                      end: nat === 'PAT' ? '10.2.0.1' : '10.2.0.99',
                      overload: nat === 'PAT',
                    },
                  ],
          });
          e.configureFirewall(r.id, { enabled: true, trustedPorts: ['p0'] });
          delete srv.gateway;
        }
      } else {
        r.ipv6Routing = true;
        for (const [i, host] of [pc, srv].entries()) {
          e.configureIpv6(r.id, 'p' + i, {
            auto: false,
            addresses: [{ ip: `2001:db8:${i + 1}::1`, prefix: 64 }],
            ra: {
              intervalMs: 3000,
              lifetimeMs: 9000,
              prefixes: [
                {
                  network: `2001:db8:${i + 1}::`,
                  prefix: 64,
                  onLink: true,
                  autonomous: false,
                  validMs: 60000,
                  preferredMs: 30000,
                },
              ],
            },
          });
          e.configureIpv6(host.id, 'p0', {
            auto: true,
            addresses: [{ ip: `2001:db8:${i + 1}::10`, prefix: 64 }],
          });
        }
        r.interfaces[1].mtu = 1280;
        srv.interfaces[0].mtu = 1280;
        e.advanceTo(6000);
      }
      e.configureTcpService(srv.id, { kind: 'echo', enabled: true, port: 7 });
      const data = 'MTU 🌐 '.repeat(380),
        id = e.openTcp(pc.id, family === 4 ? '10.2.0.10' : '2001:db8:2::10', 7, data),
        c = pc.tcpConnections!.find((c) => c.id === id)!;
      const quote: TcpPacket = {
        src: c.localIp,
        dst: c.remoteIp,
        sourcePort: c.localPort,
        destinationPort: c.remotePort,
        sequence: c.sendNext,
        acknowledgment: 0,
        flags: ['ACK'],
        window: 0,
        ttl: 64,
        protocol: 'TCP',
        bytes: 40,
        data: '',
      };
      expect(receiveTcpMtu(e, pc, quote, family === 4 ? 576 : 1280)).toBe(false);
      until(e, () => e.state.events.some((v) => v.reason.includes('PMTUD MTU=')));
      expect(c.extensions!.pathMtu).toBe(family === 4 ? 576 : 1280);
      const restored = new SimulationEngine(e.snapshot());
      const time = e.state.clock + 8000;
      e.advanceTo(time);
      restored.advanceTo(time);
      expect(restored.snapshot()).toEqual(e.snapshot());
      expect(c.received).toBe(data);
      expect(srv.tcpConnections![0].received).toBe(data);
      expect(c.flow!.mss).toBeLessThanOrEqual(family === 4 ? 524 : 1208);
      validateSnapshot(e.snapshot());
    });
});
