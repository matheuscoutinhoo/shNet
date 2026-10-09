import { describe, expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot } from '../packages/simulation-engine/src';
import { receiveCapwap } from '../packages/simulation-engine/src/protocols/capwap';
import { wirelessConfig } from '../packages/simulation-engine/src/protocols/wireless';
function setup(key = 'controller-network-key') {
  const e = new SimulationEngine(),
    wlc = e.addDevice('switch', { x: 400, y: 300 }),
    ap = e.addDevice('switch', { x: 80, y: 80 }),
    client = e.addDevice('pc', { x: 85, y: 85 }),
    server = e.addDevice('server');
  Object.assign(wlc.interfaces[0], { mode: 'routed', ip: '192.0.2.1', prefix: 24 });
  Object.assign(ap.interfaces[0], { mode: 'routed', ip: '192.0.2.2', prefix: 24 });
  wlc.vlans.push({ id: 10, name: 'WLAN' });
  wlc.interfaces[1].accessVlan = 10;
  Object.assign(server.interfaces[0], { ip: '10.0.0.20', prefix: 24 });
  e.connect({ device: wlc.id, port: 'p0' }, { device: ap.id, port: 'p0' });
  e.connect({ device: server.id, port: 'p0' }, { device: wlc.id, port: 'p1' });
  const profile = {
    ...wirelessConfig(ap),
    role: 'ap' as const,
    ssid: 'WLC-Campus',
    security: 'wpa2-psk' as const,
    key: 'wireless-campus-key',
    noise: -110,
  };
  e.configureWireless(ap.id, profile);
  e.configureWireless(client.id, { ...profile, role: 'client' });
  Object.assign(
    client.interfaces.find((p) => p.id === 'wlan0')!,
    { ip: '10.0.0.10', prefix: 24 }
  );
  e.configureWlc(wlc.id, {
    enabled: true,
    underlay: 'p0',
    key: 'controller-network-key',
    allowedWtps: [ap.id],
    profiles: [{ name: 'campus', vlan: 10, wireless: profile }],
  });
  e.configureWtp(ap.id, { enabled: true, underlay: 'p0', controller: '192.0.2.1', key, profile: 'campus' });
  e.configureTcpService(server.id, {
    kind: 'http',
    enabled: true,
    port: 80,
    body: 'HTTP centralizado CAPWAP',
  });
  return { e, wlc, ap, client, server };
}
describe('WLC / CAPWAP', () => {
  it('descobre, negocia chaves, configura WLAN, centraliza Ethernet e restaura canal', () => {
    const { e, wlc, ap, client } = setup();
    e.advanceTo(7000);
    expect(ap.wtp!.phase).toBe('RUN');
    expect(wlc.wlc!.sessions[0].phase).toBe('RUN');
    expect(client.wireless!.phase).toBe('associated');
    expect(wlc.interfaces.some((p) => p.capwapPeer === ap.id && p.accessVlan === 10)).toBe(true);
    const id = e.httpGet(client.id, '10.0.0.20');
    e.advanceTo(9000);
    expect(client.tcpConnections!.find((c) => c.id === id)!.received).toContain('HTTP centralizado CAPWAP');
    expect(
      e.state.events.some(
        (v) =>
          v.frame?.packet?.protocol === 'UDP' &&
          v.frame.packet.destinationPort === 5247 &&
          v.frame.packet.payload.protocol === 'CAPWAP'
      )
    ).toBe(true);
    validateSnapshot(e.snapshot());
    const resumed = new SimulationEngine(e.snapshot());
    e.advanceTo(11000);
    resumed.advanceTo(11000);
    expect(resumed.snapshot()).toEqual(e.snapshot());
    wlc.power = false;
    e.advanceTo(18000);
    expect(ap.wtp!.phase).toBe('DISCOVERY');
    expect(ap.wireless!.enabled).toBe(false);
    wlc.power = true;
    e.advanceTo(25000);
    expect(ap.wtp!.phase).toBe('RUN');
    validateSnapshot(e.snapshot());
  });
  it('rejeita um record válido já recebido sem renovar a sessão nem alterar a janela antirreplay', () => {
    const { e, wlc, ap } = setup();
    e.advanceTo(5000);
    const packet = e.state.events.findLast(
      (event) =>
        event.device === wlc.id &&
        event.frame?.packet?.protocol === 'UDP' &&
        event.frame.packet.payload.protocol === 'CAPWAP' &&
        event.frame.packet.payload.message.kind === 'record' &&
        event.frame.packet.src === ap.interfaces[0].ip
    )?.frame?.packet;
    expect(packet?.protocol).toBe('UDP');
    if (packet?.protocol !== 'UDP') throw new Error('CAPWAP record ausente');
    const session = structuredClone(wlc.wlc!.sessions[0]);
    const dropped = wlc.dropped;
    receiveCapwap(e, wlc, structuredClone(packet));
    expect(wlc.dropped).toBe(dropped + 1);
    expect(wlc.wlc!.sessions[0]).toEqual(session);
    expect(e.state.events.at(-1)?.reason).toMatch(/replay/);
    validateSnapshot(e.snapshot());
  });
  it('PSK incorreta impede ativação; record adulterado é descartado', () => {
    const wrong = setup('wrong-controller-key');
    wrong.e.advanceTo(7000);
    expect(wrong.ap.wtp!.phase).toBe('DISCOVERY');
    expect(wrong.wlc.wlc!.sessions).toHaveLength(0);
    const { e, wlc, ap } = setup();
    e.advanceTo(5000);
    let found = false;
    for (let i = 0; i < 150; i++) {
      e.step();
      const q = e.state.queue.find(
        (q) =>
          q.action.kind === 'deliver' &&
          q.action.device === wlc.id &&
          q.action.frame.packet?.protocol === 'UDP' &&
          q.action.frame.packet.payload.protocol === 'CAPWAP' &&
          q.action.frame.packet.payload.message.kind === 'record'
      );
      if (
        q?.action.kind === 'deliver' &&
        q.action.frame.packet?.protocol === 'UDP' &&
        q.action.frame.packet.payload.protocol === 'CAPWAP'
      ) {
        const message = q.action.frame.packet.payload.message;
        message.ciphertext = '00' + message.ciphertext!.slice(2);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    const before = wlc.dropped;
    e.advanceTo(e.state.clock + 100);
    expect(wlc.dropped).toBeGreaterThan(before);
    expect(ap.wtp!.phase).toBe('RUN');
    validateSnapshot(e.snapshot());
    const bad = e.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'capwap-tick');
    expect(() => validateSnapshot(bad)).toThrow(/CAPWAP/);
  });
});
