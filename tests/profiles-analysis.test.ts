import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  deviceProfiles,
  validateSnapshot,
  makeTemplate,
  networkAnalysis,
  TerminalSession,
  linkOperational,
} from '@shlab/engine';
describe('catálogo, mídia e análise', () => {
  it('perfis persistem com capacidades do motor e MACs únicos', () => {
    const e = new SimulationEngine();
    for (const p of deviceProfiles) e.addProfile(p.id);
    const s = validateSnapshot(JSON.parse(JSON.stringify(e.snapshot())));
    expect(s.devices).toHaveLength(deviceProfiles.length);
    expect(
      s.devices
        .find((d) => d.profile === 'core')!
        .interfaces.every((p) => p.media === 'qsfp' && p.speed === 40000)
    ).toBe(true);
    const bad = e.snapshot();
    bad.devices[0].profile = 'unavailable';
    expect(() => validateSnapshot(bad)).toThrow('Perfil');
  });
  it('HTTP atravessa DAC/QSFP e incompatibilidades físicas são rejeitadas', () => {
    const e = new SimulationEngine(),
      a = e.addProfile('distribution'),
      b = e.addProfile('distribution'),
      pc = e.addProfile('desktop'),
      srv = e.addProfile('web');
    Object.assign(pc.interfaces[0], { ip: '192.0.2.10', prefix: 24, speed: 10000 });
    Object.assign(srv.interfaces[0], { ip: '192.0.2.20', prefix: 24, speed: 10000 });
    e.connect({ device: pc.id, port: 'p0' }, { device: a.id, port: 'p0' });
    e.connect({ device: srv.id, port: 'p0' }, { device: b.id, port: 'p0' });
    for (const d of [a, b]) d.interfaces[24].transceiver = 'dac';
    expect(() =>
      e.connect({ device: a.id, port: 'p24' }, { device: b.id, port: 'p24' }, 'dac', { distance: 8 })
    ).toThrow('Distância');
    const link = e.connect({ device: a.id, port: 'p24' }, { device: b.id, port: 'p24' }, 'dac', {
      distance: 7,
    });
    const id = e.httpGet(pc.id, '192.0.2.20');
    e.advanceTo(1000);
    expect(pc.tcpConnections!.find((c) => c.id === id)!.received).toContain('servidor HTTP');
    b.interfaces[24].speed = 100000;
    expect(linkOperational(e.state, link)).toBe(false);
    validateSnapshot(e.snapshot());
    b.interfaces[24].speed = 40000;
    expect(linkOperational(e.state, link)).toBe(true);
    const cli = new TerminalSession(e, a.id);
    for (const c of ['enable', 'conf t', 'interface Fo0/25', 'speed 100000'])
      expect(cli.execute(c)).toBe('OK');
    expect(a.interfaces[24].speed).toBe(100000);
    const s = e.addProfile('switch-l2');
    s.interfaces[8].transceiver = 'dac';
    expect(() =>
      e.connect({ device: a.id, port: 'p25' }, { device: s.id, port: 'p8' }, 'dac', { distance: 1 })
    ).toThrow('Mídia');
  });
  it('serviços de perfil respondem pela rede e análises refletem estado e referências reais', () => {
    const e = new SimulationEngine(),
      pc = e.addProfile('desktop'),
      dns = e.addProfile('dns');
    Object.assign(pc.interfaces[0], { ip: '192.0.2.1', prefix: 24 });
    Object.assign(dns.interfaces[0], { ip: '192.0.2.2', prefix: 24 });
    e.connect({ device: pc.id, port: 'p0' }, { device: dns.id, port: 'p0' });
    e.configureDnsRecord(dns.id, { name: 'catalog.lab', type: 'A', value: '192.0.2.20', ttl: 30 });
    e.setDnsServers(pc.id, 'p0', ['192.0.2.2']);
    const q = e.lookupDns(pc.id, 'catalog.lab');
    e.advanceTo(1000);
    expect(pc.dnsQueries!.find((n) => n.id === q)!.status).toBe('success');
    expect(networkAnalysis(e.state, 'dependencies')[0].values).toContain('equipamento presente');
    const routed = new SimulationEngine(makeTemplate('svi'));
    expect(
      networkAnalysis(routed.state, 'dependencies').some((r) => r.values[1] === 'Gateway do equipamento')
    ).toBe(true);
    const a = new SimulationEngine(makeTemplate('automation'));
    a.advanceTo(2000);
    expect(networkAnalysis(a.state, 'monitoring').some((r) => r.values.includes('sincronizado'))).toBe(true);
    const v = new SimulationEngine(makeTemplate('evpn'));
    v.advanceTo(2000);
    expect(networkAnalysis(v.state, 'protocols').some((r) => r.values.includes('Established'))).toBe(true);
    expect(networkAnalysis(v.state, 'overlays').some((r) => r.values[1] === 'VNI 10010')).toBe(true);
  });
});
