import { describe, expect, it } from 'vitest';
import { SimulationEngine, validateSnapshot } from '../packages/simulation-engine/src';
describe('Serial, console e PoE', () => {
  it('roteia ICMP em HDLC serial, inclui tempo do clock e recusa FCS adulterado', () => {
    const e = new SimulationEngine(),
      a = e.addDevice('router'),
      b = e.addDevice('router');
    const pa = e.addHardwarePort(a.id, 'serial', { role: 'DCE', clockRate: 64000, encapsulation: 'hdlc' }),
      pb = e.addHardwarePort(b.id, 'serial');
    Object.assign(pa, { ip: '10.0.0.1', prefix: 30 });
    Object.assign(pb, { ip: '10.0.0.2', prefix: 30 });
    e.connect({ device: a.id, port: pa.id }, { device: b.id, port: pb.id }, 'serial');
    const id = e.ping(a.id, '10.0.0.2');
    e.advanceTo(100);
    expect(e.state.probes.find((p) => p.id === id)).toMatchObject({ status: 'success' });
    expect(e.state.probes[0].rtt).toBeGreaterThan(20);
    expect(a.arpTable).toHaveLength(0);
    expect(e.state.events.some((v) => v.frame?.wan?.encapsulation === 'hdlc')).toBe(true);
    validateSnapshot(e.snapshot());
    e.ping(a.id, '10.0.0.2');
    const q = e.state.queue.find((q) => q.action.kind === 'deliver' && q.action.frame.wan)!;
    if (q.action.kind === 'deliver') q.action.frame.wan!.fcs ^= 1;
    e.advanceTo(200);
    expect(b.dropped).toBeGreaterThan(0);
    expect(e.state.events.some((v) => v.reason.includes('FCS inválido'))).toBe(true);
  });
  it('console executa CLI sem IP, preserva contexto e depende do baud/enlace', () => {
    const e = new SimulationEngine(),
      pc = e.addDevice('pc'),
      r = e.addDevice('router'),
      a = e.addHardwarePort(pc.id, 'console'),
      b = e.addHardwarePort(r.id, 'console');
    const l = e.connect({ device: pc.id, port: a.id }, { device: r.id, port: b.id }, 'console');
    for (const command of ['enable', 'conf t', 'hostname R-CONSOLE'])
      expect(e.consoleCommand(pc.id, l.id, command)).toBe('OK');
    expect(r.hostname).toBe('R-CONSOLE');
    validateSnapshot(e.snapshot());
    const resumed = new SimulationEngine(e.snapshot());
    expect(resumed.consoleCommand(pc.id, l.id, 'hostname R-RESTORED')).toBe('OK');
    expect(resumed.device(r.id).hostname).toBe('R-RESTORED');
    b.console!.baud = '115200';
    expect(() => e.consoleCommand(pc.id, l.id, 'show interfaces')).toThrow(/baud/);
    b.console!.baud = '9600';
    e.removeLink(l.id);
    expect(r.consoleSessions).toHaveLength(0);
    validateSnapshot(e.snapshot());
  });
  it('PoE prioriza portas por orçamento e desliga/reacende PDs ao alterar potência ou cabo', () => {
    const e = new SimulationEngine(),
      sw = e.addDevice('switch'),
      phone = e.addDevice('pc'),
      ap = e.addDevice('server');
    e.configurePoe(sw.id, {
      enabled: true,
      budget: 15.4,
      ports: [
        { port: 'p0', enabled: true, standard: 'af', priority: 10 },
        { port: 'p1', enabled: true, standard: 'af', priority: 1 },
      ],
    });
    for (const d of [phone, ap]) e.configurePoe(d.id, undefined, { required: true, class: 3, watts: 10 });
    const first = e.connect({ device: sw.id, port: 'p0' }, { device: phone.id, port: 'p0' });
    e.connect({ device: sw.id, port: 'p1' }, { device: ap.id, port: 'p0' });
    expect(phone.power).toBe(false);
    expect(ap.power).toBe(true);
    expect(sw.poeSupply!.allocations[0].device).toBe(ap.id);
    validateSnapshot(e.snapshot());
    e.configurePoe(sw.id, { enabled: true, budget: 30.8, ports: sw.poeSupply!.ports });
    expect(phone.power).toBe(true);
    const restored = new SimulationEngine(e.snapshot());
    expect(restored.device(phone.id).power).toBe(true);
    e.setDevicePower(sw.id, false);
    expect(phone.power).toBe(false);
    expect(ap.power).toBe(false);
    e.setDevicePower(sw.id, true);
    expect(phone.power).toBe(true);
    e.removeLink(first.id);
    expect(phone.power).toBe(false);
    expect(ap.power).toBe(true);
    validateSnapshot(e.snapshot());
  });
});
