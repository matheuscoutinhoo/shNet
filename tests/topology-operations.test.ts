import { describe, it, expect } from 'vitest';
import {
  SimulationEngine,
  makeTemplate,
  groupDevices,
  validateSnapshot,
  applySimulationDelta,
  SimulationRunner,
} from '../packages/simulation-engine/src';
import { cloneTopology } from '../apps/web/src/workspace/cloneTopology';
import { topologyView } from '../apps/web/src/workspace/topologyView';
describe('Clonagem e vistas de topologia', () => {
  it.each(['vrrp', 'bgp', 'ospf', 'lacp', 'vpn', 'sdwan', 'vrf', 'vxlan'] as const)(
    'preserva configuração válida ao clonar o modelo %s',
    (template) => {
      const source = makeTemplate(template),
        p = cloneTopology(
          source,
          source.devices.map((d) => d.id)
        );
      validateSnapshot(p.snapshot);
      expect(p.snapshot.devices).toHaveLength(source.devices.length * 2);
    },
    60000
  );
  it.each(['factory', 'enterprise-datacenter'] as const)(
    'clona modelo completo %s com todos os peers e referências internos',
    (template) => {
      const source = makeTemplate(template),
        p = cloneTopology(
          source,
          source.devices.map((d) => d.id)
        );
      validateSnapshot(p.snapshot);
      expect(p.snapshot.devices).toHaveLength(source.devices.length * 2);
      expect(p.snapshot.devices.slice(0, source.devices.length)).toEqual(validateSnapshot(source).devices);
      expect(p.snapshot.devices.slice(source.devices.length).filter((d) => d.stateSync)).toHaveLength(
        source.devices.filter((d) => d.stateSync).length
      );
    },
    60000
  );
  it('clona uma célula LAN sem colisão, conserva subnets/gateway e não altera a origem', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      source = e.snapshot(),
      original = structuredClone(source);
    const group = groupDevices(
      e,
      e.state.devices.map((d) => d.id)
    );
    const p = cloneTopology(e.snapshot(), [group.id]);
    validateSnapshot(p.snapshot);
    const clones = p.snapshot.devices.filter((d) => !source.devices.some((v) => v.id === d.id));
    expect(clones).toHaveLength(source.devices.length);
    const ips = new Set(source.devices.flatMap((d) => d.interfaces.flatMap((p) => (p.ip ? [p.ip] : []))));
    expect(clones.every((d) => d.interfaces.every((p) => !p.ip || !ips.has(p.ip)))).toBe(true);
    expect(p.snapshot.canvasItems!.at(-1)!.members).toHaveLength(clones.length);
    expect(source).toEqual(original);
    const ping = new SimulationEngine(p.snapshot),
      hosts = clones.filter((d) => d.type === 'pc');
    const id = ping.ping(hosts[0].id, hosts[1].interfaces[0].ip!);
    ping.run();
    expect(ping.state.probes.find((p) => p.id === id)!.status).toBe('success');
  });
  it('conserva alinhamento de políticas mais amplas que a subnet conectada', () => {
    const e = new SimulationEngine(),
      router = e.addDevice('router');
    Object.assign(router.interfaces[0], { ip: '10.20.10.1', prefix: 24 });
    router.routes = [{ network: '10.20.0.0', prefix: 16, nextHop: '10.20.10.2', metric: 1 }];
    const source = e.snapshot(),
      p = cloneTopology(source, [router.id]),
      copy = p.snapshot.devices.at(-1)!;
    expect(copy.routes[0].network).not.toBe(router.routes[0].network);
    expect(copy.interfaces[0].ip!.split('.').slice(0, 2)).toEqual(
      copy.routes[0].network.split('.').slice(0, 2)
    );
    validateSnapshot(p.snapshot);
  });
  it('clona rack e cargas UPS exclusivamente para os equipamentos clonados', () => {
    const e = new SimulationEngine(),
      rack = e.addProfile('rack'),
      ups = e.addProfile('ups'),
      pc = e.addDevice('pc');
    e.configureInfrastructure(rack.id, {
      kind: 'rack',
      units: 42,
      ambientC: 22,
      ventilation: 1,
      slots: [{ device: pc.id, unit: 1, units: 1 }],
    });
    e.configureInfrastructure(ups.id, {
      kind: 'ups',
      mains: true,
      capacityWh: 1000,
      maxWatts: 1000,
      chargeWatts: 100,
      efficiency: 0.9,
      loads: [{ device: pc.id, watts: 100, requested: true }],
      remainingWh: 1000,
      lastAt: 0,
      output: true,
    });
    const p = cloneTopology(e.snapshot(), [rack.id, ups.id]);
    const r = p.snapshot.devices.find((d) => d.hostname === rack.hostname + '-copy')!.infrastructure!;
    const u = p.snapshot.devices.find((d) => d.hostname === ups.hostname + '-copy')!.infrastructure!;
    expect(r.kind).toBe('rack');
    expect(u.kind).toBe('ups');
    if (r.kind === 'rack' && u.kind === 'ups') {
      expect(r.slots[0].device).toBe(u.loads[0].device);
      expect(r.slots[0].device).not.toBe(pc.id);
    }
  });
  it('clona IPv6 e nega alterações parciais ao atingir o limite', () => {
    const e = new SimulationEngine(makeTemplate('ipv6')),
      source = e.snapshot();
    const p = cloneTopology(
      source,
      source.devices.map((d) => d.id)
    );
    validateSnapshot(p.snapshot);
    const old = new Set(
      source.devices.flatMap((d) => d.interfaces.flatMap((p) => p.ipv6?.addresses.map((a) => a.ip) ?? []))
    );
    expect(
      p.snapshot.devices
        .slice(source.devices.length)
        .flatMap((d) =>
          d.interfaces.flatMap((p) => p.ipv6?.addresses.filter((a) => a.origin === 'static') ?? [])
        )
        .every((a) => !old.has(a.ip))
    ).toBe(true);
  });
  it('projeção lógica conserva topologia física e elimina objetos passivos', () => {
    const e = new SimulationEngine(makeTemplate('lan'));
    e.addProfile('rack');
    const before = e.snapshot(),
      p = topologyView(e.state, 'logical');
    expect(p.devices.every((d) => d.infrastructure?.kind !== 'rack')).toBe(true);
    expect(p.links).toHaveLength(e.state.links.length);
    expect(e.snapshot()).toEqual(before);
  });
  it('delta aplica remoção de campos e mudanças de uma porta sem substituir outras', () => {
    const e = new SimulationEngine(makeTemplate('lan')),
      r = new SimulationRunner(e.snapshot()),
      mirror = e.snapshot();
    const d = r.engine.state.devices[0],
      oldOther = mirror.devices.at(-1);
    d.hostname = 'UPDATED';
    delete d.interfaces[0].ip;
    d.interfaces[0].rx++;
    const delta = structuredClone(r.step());
    applySimulationDelta(mirror, delta);
    expect(mirror).toEqual(r.engine.snapshot());
    expect(mirror.devices.at(-1)).toBe(oldOther);
    expect(delta.devices).toHaveLength(0);
    expect(delta.devicePatches?.length).toBeGreaterThan(0);
  });
});
