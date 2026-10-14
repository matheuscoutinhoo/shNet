import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  type Device,
} from '../packages/simulation-engine/src';

export function capacityTopology(size: number) {
  if (!Number.isInteger(size) || size < 60 || size > 2000) throw new Error('Use 60..2000 equipamentos.');
  const e = new SimulationEngine(makeTemplate('enterprise-datacenter'));
  const byName = (name: string) => e.state.devices.find((d) => d.hostname === name)!;
  const cores = [byName('CORE-A'), byName('CORE-B')],
    fws = [byName('FW-A'), byName('FW-B')];
  const vlan = 110,
    allowed = [1, 10, 20, 30, 40, 99, vlan];
  const trunk = (d: Device, port: string) => {
    Object.assign(
      d.interfaces.find((p) => p.id === port)!,
      { mode: 'trunk', nativeVlan: 1, allowedVlans: allowed }
    );
  };
  const cable = (a: Device, ap: string, b: Device, bp: string) => {
    for (const [d, id] of [
      [a, ap],
      [b, bp],
    ] as const)
      Object.assign(
        d.interfaces.find((p) => p.id === id)!,
        { media: 'rj45', transceiver: undefined, speed: 1000 }
      );
    e.connect({ device: a.id, port: ap }, { device: b.id, port: bp });
  };
  for (const core of cores) {
    core.vlans.push({ id: vlan, name: 'CAPACITY' });
    for (const p of core.interfaces.filter((p) => p.mode === 'trunk')) p.allowedVlans = allowed;
  }
  for (const [i, fw] of fws.entries()) {
    const port = e.addSubinterface(fw.id, 'p0', vlan);
    Object.assign(port, { ip: `10.61.0.${i + 2}`, prefix: 16 });
    const groups = fw.vrrp!.groups.map(({ port, vrid, vip, priority, advertMs }) => ({
      port,
      vrid,
      vip,
      priority,
      advertMs,
    }));
    e.configureVrrp(fw.id, {
      enabled: true,
      groups: [
        ...groups,
        { port: port.id, vrid: vlan, vip: '10.61.0.1', priority: i ? 100 : 150, advertMs: 1000 },
      ],
    });
    const policy = structuredClone(fw.firewall!.zonePolicy!);
    policy.zones.find((z) => z.name === 'USERS')!.ports.push(port.id);
    e.configureFirewall(fw.id, { ...fw.firewall!, zonePolicy: policy });
  }
  const pair = fws[0].stateSync!;
  e.configureStateSyncPair(fws[0].id, fws[1].id, {
    portA: pair.port,
    portB: fws[1].stateSync!.port,
    mappings: [
      ...pair.portMap.map((p) => ({ a: p.local, b: p.remote })),
      { a: fws[0].interfaces.at(-1)!.id, b: fws[1].interfaces.at(-1)!.id },
    ],
  });
  byName('EDGE-WAN').routes.push({ network: '10.61.0.0', prefix: 16, nextHop: '172.31.0.254', metric: 1 });
  const count = Math.ceil((size - e.state.devices.length) / 19);
  const access: Device[] = [];
  for (let i = 0; i < count; i++) {
    const sw = e.addProfile('access', { x: (i % 10) * 360, y: 1600 + Math.floor(i / 10) * 350 });
    sw.hostname = `CAPACITY-SW-${i + 1}`;
    sw.vlans.push({ id: vlan, name: 'CAPACITY' });
    for (const p of sw.interfaces) p.accessVlan = vlan;
    trunk(sw, 'p20');
    if (i === 0) {
      trunk(sw, 'p21');
      for (const [j, core] of cores.entries()) {
        trunk(core, 'p6');
        cable(sw, `p${20 + j}`, core, 'p6');
      }
    } else {
      const parent = access[Math.floor((i - 1) / 2)],
        port = i % 2 ? 'p18' : 'p19';
      trunk(parent, port);
      cable(sw, 'p20', parent, port);
    }
    access.push(sw);
  }
  const clients: string[] = [];
  while (e.state.devices.length < size) {
    const i = clients.length,
      sw = access[Math.floor(i / 18)],
      port = `p${i % 18}`;
    const host = e.addProfile('desktop', {
      x: sw.position.x + (i % 6) * 50,
      y: sw.position.y + 120 + Math.floor((i % 18) / 6) * 60,
    });
    host.hostname = `CAPACITY-PC-${i + 1}`;
    const address = i + 10;
    Object.assign(host.interfaces[0], {
      ip: `10.61.${Math.floor(address / 256)}.${address % 256}`,
      prefix: 16,
    });
    host.gateway = '10.61.0.1';
    e.setDnsServers(host.id, 'p0', ['10.60.30.53']);
    cable(host, 'p0', sw, port);
    e.setSpanningTreePort(sw.id, port, { edge: true });
    clients.push(host.id);
  }
  // Provision ports before starting STP; avoid an artificial construction storm.
  for (const sw of access) e.configureSpanningTree(sw.id, 'rstp', 32768);
  return { snapshot: validateSnapshot(e.snapshot()), clients };
}
