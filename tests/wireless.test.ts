import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  wirelessMetrics,
  validateSnapshot,
  defaultDhcpPool,
} from '../packages/simulation-engine/src';
const cfg = (
  role: 'ap' | 'client',
  security: 'open' | 'wpa2-psk' | 'wpa3-sae' = 'wpa2-psk',
  key = 'Wireless-123'
) => ({
  role,
  ssid: 'Campus',
  security,
  ...(security === 'open' ? {} : { key }),
  band: '2.4',
  channel: 1,
  txPower: 20,
  noise: -95,
  attenuation: 0,
  enabled: true,
});
function topology(security: 'open' | 'wpa2-psk' | 'wpa3-sae' = 'wpa2-psk') {
  const e = new SimulationEngine(),
    ap = e.addDevice('switch', { x: 200, y: 200 }),
    pc = e.addDevice('pc', { x: 240, y: 200 }),
    server = e.addDevice('server', { x: 100, y: 200 });
  e.configureWireless(ap.id, cfg('ap', security));
  e.configureWireless(pc.id, cfg('client', security));
  Object.assign(
    pc.interfaces.find((p) => p.id === 'wlan0')!,
    { ip: '10.10.10.10', prefix: 24 }
  );
  Object.assign(server.interfaces[0], { ip: '10.10.10.20', prefix: 24 });
  e.connect({ device: ap.id, port: 'p0' }, { device: server.id, port: 'p0' });
  e.configureTcpService(server.id, { kind: 'http', port: 80, enabled: true, body: 'HTTP pelo rádio' });
  return { e, ap, pc, server };
}
describe('Rádio, autenticação e associação wireless', () => {
  it.each(['open', 'wpa2-psk', 'wpa3-sae'] as const)(
    'negocia %s por PDUs e transporta ping/HTTP pela bridge',
    (security) => {
      const { e, ap, pc, server } = topology(security);
      e.advanceTo(5000);
      expect(pc.wireless?.phase).toBe('associated');
      expect(ap.wireless?.peers[0].phase).toBe('associated');
      const probe = e.ping(pc.id, '10.10.10.20'),
        tcp = e.httpGet(pc.id, '10.10.10.20');
      e.advanceTo(6000);
      expect(e.state.probes.find((p) => p.id === probe)?.status).toBe('success');
      expect(pc.tcpConnections?.find((c) => c.id === tcp)?.received).toContain('HTTP pelo rádio');
      expect(ap.macTable.find((m) => m.mac === pc.interfaces.find((p) => p.id === 'wlan0')!.mac)?.port).toBe(
        'wlan0'
      );
      expect(server.interfaces[0].rx).toBeGreaterThan(0);
      validateSnapshot(e.snapshot());
      const controls = e.state.events.filter((v) => v.type === 'WIFI_SENT').map((v) => v.frame!.wifi!.kind);
      expect(controls).toContain('association-request');
      if (security !== 'open')
        for (const kind of ['key1', 'key2', 'key3', 'key4']) expect(controls).toContain(kind);
      if (security === 'wpa3-sae') {
        expect(controls).toContain('sae-commit');
        expect(controls).toContain('sae-confirm');
      }
    }
  );
  it('credencial incorreta falha e nenhum frame de usuário cruza o rádio', () => {
    const { e, pc, server } = topology();
    e.configureWireless(pc.id, cfg('client', 'wpa2-psk', 'Wrong-Key-123'));
    e.advanceTo(5000);
    expect(pc.wireless?.phase).toBe('failed');
    const id = e.ping(pc.id, '10.10.10.20');
    e.advanceTo(36000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('timeout');
    expect(server.logs.some((l) => l.includes('Echo Request'))).toBe(false);
    expect(e.state.events.some((v) => v.type === 'WIFI_AUTH_FAILED')).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('SSID e canal distintos impedem associação; movimento reduz sinal e desassocia', () => {
    const { e, pc, ap } = topology();
    e.configureWireless(pc.id, { ...cfg('client'), channel: 6 });
    e.advanceTo(5000);
    expect(pc.wireless?.phase).toBe('scanning');
    e.configureWireless(pc.id, { ...cfg('client'), ssid: 'Outra' });
    e.advanceTo(10000);
    expect(pc.wireless?.phase).toBe('scanning');
    e.configureWireless(pc.id, cfg('client'));
    e.advanceTo(15000);
    expect(pc.wireless?.phase).toBe('associated');
    const radio = e.state.links.find((l) => l.cable === 'wireless')!,
      near = wirelessMetrics(e.state, radio).rssi;
    pc.position.x = 1600;
    e.advanceTo(20000);
    expect(wirelessMetrics(e.state, radio).rssi).toBeLessThan(near);
    expect(pc.wireless?.phase).toBe('scanning');
    expect(ap.wireless?.peers).toEqual([]);
    pc.position.x = 240;
    e.advanceTo(25000);
    expect(pc.wireless?.phase).toBe('associated');
    validateSnapshot(e.snapshot());
  });
  it('interferência de canais sobrepostos altera SNR/perda e canal 11 elimina sobreposição com 1', () => {
    const { e, pc } = topology();
    const link = e.state.links.find((l) => l.cable === 'wireless')!,
      baseline = wirelessMetrics(e.state, link);
    const interferer = e.addDevice('switch', { x: 260, y: 200 });
    e.configureWireless(interferer.id, { ...cfg('ap'), ssid: 'Interferente', channel: 2 });
    const crowded = wirelessMetrics(e.state, link);
    expect(crowded.interference).toBeGreaterThan(0);
    expect(crowded.snr).toBeLessThan(baseline.snr);
    expect(crowded.loss).toBeGreaterThan(baseline.loss);
    e.configureWireless(interferer.id, { ...cfg('ap'), ssid: 'Interferente', channel: 11 });
    expect(wirelessMetrics(e.state, link).interference).toBe(0);
    expect(pc.wireless?.role).toBe('client');
    validateSnapshot(e.snapshot());
  });
  it('dois clientes comunicam pelo mesmo rádio do AP sem duplicar broadcast', () => {
    const { e, ap, pc } = topology('open'),
      b = e.addDevice('pc', { x: 260, y: 200 });
    e.configureWireless(b.id, cfg('client', 'open'));
    Object.assign(
      b.interfaces.find((p) => p.id === 'wlan0')!,
      { ip: '10.10.10.30', prefix: 24 }
    );
    e.advanceTo(5000);
    const id = e.ping(pc.id, '10.10.10.30');
    e.advanceTo(6000);
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    expect(ap.wireless?.peers).toHaveLength(2);
    validateSnapshot(e.snapshot());
  });
  it('restaura negociação/estado e rejeita rádio/timer órfãos', () => {
    const { e } = topology();
    e.advanceTo(1001);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(6000);
    restored.advanceTo(6000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    const bad = e.snapshot();
    bad.queue = bad.queue.filter((q) => q.action.kind !== 'wireless-tick');
    expect(() => validateSnapshot(bad)).toThrow('Timer wireless');
    const port = e.snapshot();
    port.devices[0].wireless!.port = 'p0';
    expect(() => validateSnapshot(port)).toThrow('Rádio');
  });
  it('DHCP atribui endereço por broadcast no rádio; NDP e ICMPv6 usam a mesma associação', () => {
    const { e, pc, server } = topology();
    const pool = defaultDhcpPool(server, 'WIFI', 'p0');
    pool.start = '10.10.10.100';
    pool.end = '10.10.10.110';
    e.configureDhcpPool(server.id, pool);
    e.requestDhcp(pc.id, 'wlan0');
    e.advanceTo(10000);
    expect(pc.interfaces.find((p) => p.id === 'wlan0')?.dhcp?.status).toBe('bound');
    expect(pc.interfaces.find((p) => p.id === 'wlan0')?.ip).toBe('10.10.10.100');
    e.configureIpv6(pc.id, 'wlan0', { auto: false, addresses: [{ ip: '2001:db8::10', prefix: 64 }] });
    e.configureIpv6(server.id, 'p0', { auto: false, addresses: [{ ip: '2001:db8::20', prefix: 64 }] });
    e.advanceTo(14000);
    const id = e.ping6(pc.id, '2001:db8::20');
    e.advanceTo(15000);
    expect(e.state.probes6?.find((p) => p.id === id)?.status).toBe('success');
    validateSnapshot(e.snapshot());
  });
  it('CLI oculta a chave nos eventos e configuração exibida; comandos inválidos não alteram estado', () => {
    const e = new SimulationEngine(),
      d = e.addDevice('pc'),
      t = new TerminalSession(e, d.id);
    for (const cmd of [
      'enable',
      'conf t',
      'wireless client ssid Campus security wpa3-sae key Wireless-123 channel 36 band 5',
      'end',
    ])
      expect(t.execute(cmd)).not.toMatch(/^%/);
    expect(t.execute('show wireless radio')).toContain('canal=36');
    expect(t.execute('show running-config')).toContain('key [configured]');
    expect(d.logs.join(' ')).not.toContain('Wireless-123');
    expect(e.state.events.map((v) => v.reason).join(' ')).not.toContain('Wireless-123');
    t.execute('conf t');
    const before = e.snapshot();
    expect(t.execute('wireless client ssid Campus security open channel 99 band 2.4')).toMatch(/^%/);
    expect(e.snapshot()).toEqual(before);
    validateSnapshot(e.snapshot());
  });
  it('roaming usa outro AP compatível após perda de sinal ou queda do AP atual', () => {
    const { e, ap, pc } = topology('open'),
      backup = e.addDevice('switch', { x: 280, y: 200 });
    e.configureWireless(backup.id, { ...cfg('ap', 'open'), channel: 6 });
    e.advanceTo(5000);
    const original = pc.wireless?.association?.bssid;
    expect(original).toBe(ap.interfaces.find((p) => p.id === 'wlan0')?.mac);
    ap.power = false;
    e.configureWireless(backup.id, cfg('ap', 'open'));
    e.advanceTo(10000);
    expect(pc.wireless?.phase).toBe('associated');
    expect(pc.wireless?.association?.bssid).toBe(backup.interfaces.find((p) => p.id === 'wlan0')?.mac);
    e.removeDevice(backup.id);
    e.refreshSpanningTree();
    expect(pc.wireless?.phase).toBe('scanning');
    validateSnapshot(e.snapshot());
  });
  it('cifra dados no enlace, rejeita adulteração/replay e mantém restore de ciphertext pendente', () => {
    const { e, pc } = topology();
    e.advanceTo(5000);
    const id = e.ping(pc.id, '10.10.10.20');
    const item = e.state.queue.find((q) => q.action.kind === 'deliver' && q.action.frame.secure)!;
    expect(item).toBeDefined();
    if (item.action.kind !== 'deliver') throw Error('entrega');
    expect(item.action.frame.packet).toBeUndefined();
    expect(item.action.frame.arp).toBeUndefined();
    expect(item.action.frame.secure?.body).not.toContain('10.10.10.10');
    const replay = structuredClone(item.action),
      bad = structuredClone(item.action);
    bad.frame.secure!.body =
      (bad.frame.secure!.body.startsWith('00') ? 'ff' : '00') + bad.frame.secure!.body.slice(2);
    e.schedule(item.at - e.state.clock + 0.1, replay);
    e.schedule(item.at - e.state.clock + 0.2, bad);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(6000);
    restored.advanceTo(6000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(e.state.probes.find((p) => p.id === id)?.status).toBe('success');
    expect(e.state.events.some((v) => v.reason.includes('Replay wireless recusado'))).toBe(true);
    expect(e.state.events.some((v) => v.reason.includes('Integridade do ciphertext inválida'))).toBe(true);
    validateSnapshot(e.snapshot());
  });
});
