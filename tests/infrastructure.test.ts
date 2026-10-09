import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  addProfile,
  deviceProfiles,
  validateSnapshot,
} from '../packages/simulation-engine/src';
describe('Infraestrutura física e recursos', () => {
  it('perfis dedicados são válidos e patch panel transmite ARP/ICMP sem aprender MAC', () => {
    for (const profile of deviceProfiles) {
      const engine = new SimulationEngine();
      addProfile(engine, profile.id);
      validateSnapshot(engine.snapshot());
    }
    const e = new SimulationEngine(),
      a = e.addDevice('pc'),
      b = e.addDevice('pc'),
      p = addProfile(e, 'patch-panel');
    Object.assign(a.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
    Object.assign(b.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
    e.connect({ device: a.id, port: 'p0' }, { device: p.id, port: 'p0' });
    e.connect({ device: b.id, port: 'p0' }, { device: p.id, port: 'p12' });
    e.ping(a.id, '10.0.0.2');
    e.advanceTo(100);
    expect(e.state.probes[0].status).toBe('success');
    expect(p.macTable).toHaveLength(0);
    expect(p.arpTable).toHaveLength(0);
    expect(() =>
      e.configureInfrastructure(p.id, {
        kind: 'patch-panel',
        pairs: [
          { a: 'p0', b: 'p1' },
          { a: 'p0', b: 'p2' },
        ],
      })
    ).toThrow(/repetida/);
    validateSnapshot(e.snapshot());
    e.configureInfrastructure(p.id, { kind: 'patch-panel', pairs: [] });
    e.ping(a.id, '10.0.0.2');
    e.advanceTo(31000);
    expect(e.state.probes.at(-1)?.status).toBe('timeout');
  });
  it('UPS esgota bateria, volta pela rede elétrica e preserva cargas desligadas', () => {
    const e = new SimulationEngine(),
      ups = addProfile(e, 'ups'),
      pc = e.addDevice('pc');
    e.configureInfrastructure(ups.id, {
      kind: 'ups',
      mains: false,
      capacityWh: 10,
      remainingWh: 10,
      maxWatts: 100,
      chargeWatts: 20,
      efficiency: 1,
      loads: [{ device: pc.id, watts: 20, requested: true }],
      lastAt: 0,
      output: true,
    });
    e.advanceTo(900000);
    expect(ups.infrastructure).toMatchObject({ remainingWh: 5, output: true });
    expect(pc.power).toBe(true);
    const restored = new SimulationEngine(e.snapshot());
    restored.advanceTo(1800000);
    expect(restored.device(pc.id).power).toBe(false);
    expect(restored.device(ups.id).infrastructure).toMatchObject({ remainingWh: 0, output: false });
    const u = restored.device(ups.id).infrastructure!;
    restored.configureInfrastructure(ups.id, { ...u, mains: true });
    expect(restored.device(pc.id).power).toBe(true);
    restored.setDevicePower(pc.id, false);
    restored.advanceTo(3600000);
    expect(restored.device(pc.id).power).toBe(false);
    expect(restored.device(ups.id).infrastructure).toMatchObject({ remainingWh: 10, output: true });
    validateSnapshot(restored.snapshot());
    expect(() =>
      restored.configureInfrastructure(ups.id, {
        ...restored.device(ups.id).infrastructure,
        loads: [{ device: 'missing', watts: 10, requested: true }],
      })
    ).toThrow(/inexistente/);
  });
  it('rack recusa sobreposição e recursos limitam processamento, memória e temperatura', () => {
    const e = new SimulationEngine(),
      rack = addProfile(e, 'rack'),
      a = e.addDevice('pc'),
      b = e.addDevice('pc');
    const config = {
      kind: 'rack',
      units: 42,
      ambientC: 60,
      ventilation: 0,
      slots: [{ device: a.id, unit: 1, units: 2 }],
    };
    e.configureInfrastructure(rack.id, config);
    expect(() =>
      e.configureInfrastructure(rack.id, {
        ...config,
        slots: [...config.slots, { device: b.id, unit: 2, units: 1 }],
      })
    ).toThrow(/sobrepostas/);
    e.configureSystem(a.id, {
      enabled: true,
      capacityPps: 10,
      memoryLimitKiB: 65536,
      ambientC: 22,
      thermalLimitC: 40,
    });
    Object.assign(a.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
    Object.assign(b.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    e.ping(a.id, '10.0.0.2');
    e.advanceTo(500);
    expect(e.state.probes[0].rtt).toBeGreaterThan(100);
    expect(a.system?.processed).toBeGreaterThan(0);
    expect(a.system?.memoryKiB).toBeGreaterThan(64);
    e.advanceTo(60000);
    expect(a.system?.throttled).toBe(true);
    e.configureSystem(a.id, {
      enabled: true,
      capacityPps: 10,
      memoryLimitKiB: 64,
      ambientC: 22,
      thermalLimitC: 85,
    });
    e.advanceTo(60001);
    e.ping(a.id, '10.0.0.2');
    expect(e.state.events.some((v) => v.reason.includes('Memória do equipamento esgotada'))).toBe(true);
    e.removeDevice(a.id);
    expect(rack.infrastructure).toMatchObject({ slots: [] });
    validateSnapshot(e.snapshot());
  });
});
