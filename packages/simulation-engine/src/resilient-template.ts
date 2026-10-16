import { SimulationEngine } from './core/engine';
import { addProfile } from './devices/profiles';
import { addCanvasItem } from './canvas';
import type { Device, Snapshot } from './model';
import type { z } from 'zod';
import { scenarioSchema, type Scenario } from './scenarios-model';
import { configureModbus } from './protocols/modbus';

export type ResilientKind = 'enterprise' | 'factory';
const sides = ['A', 'B'] as const;
const address = (vlan: number, host: number) => `10.70.${vlan}.${host}`;

// These models deliberately keep the original factory/EVPN models intact.
// Redundant campus, routed DC and WAN are one reproducible failure domain here;
// EVPN fabric features continue to have their own control/data-plane exercises.
export function resilientTemplate(kind: ResilientKind): Snapshot {
  const e = new SimulationEngine();
  const segments = [
    { vlan: 10, name: 'USERS' },
    { vlan: 20, name: 'GUEST' },
    { vlan: 30, name: 'SERVICES' },
    { vlan: 40, name: 'CORP' },
    { vlan: 99, name: 'MGMT' },
    ...(kind === 'factory'
      ? [
          { vlan: 11, name: 'CELL-1' },
          { vlan: 12, name: 'CELL-2' },
          { vlan: 13, name: 'CELL-3' },
        ]
      : []),
  ];
  const local: Device[][] = [[], []],
    shared: Device[] = [];
  function device(profile: string, name: string, x: number, y: number, side?: number) {
    const d = addProfile(e, profile, { x, y });
    d.hostname = name;
    if (side === undefined) shared.push(d);
    else local[side].push(d);
    return d;
  }
  function ip(d: Device, port: string, value: string) {
    Object.assign(
      d.interfaces.find((p) => p.id === port)!,
      { ip: value, prefix: 24 }
    );
  }
  function cable(a: Device, ap: string, b: Device, bp: string, edge = false) {
    for (const [d, port] of [
      [a, ap],
      [b, bp],
    ] as const)
      Object.assign(
        d.interfaces.find((p) => p.id === port)!,
        {
          media: 'rj45',
          transceiver: undefined,
          speed: 1000,
        }
      );
    const l = e.connect({ device: a.id, port: ap }, { device: b.id, port: bp });
    if (edge)
      for (const [d, port] of [
        [a, ap],
        [b, bp],
      ] as const)
        if (d.type === 'switch') e.setSpanningTreePort(d.id, port, { edge: true });
    return l;
  }
  const cores = sides.map((s, n) => device('distribution', 'HA-CORE-' + s, 600 + n * 400, 100, n));
  const allowed = [1, 250, ...segments.map((s) => s.vlan)];
  function trunk(d: Device, port: string) {
    Object.assign(
      d.interfaces.find((p) => p.id === port)!,
      {
        mode: 'trunk',
        nativeVlan: 1,
        allowedVlans: allowed,
      }
    );
  }
  for (const [n, core] of cores.entries()) {
    core.vlans = [...segments, { vlan: 250, name: 'WAN' }].map((s) => ({ id: s.vlan, name: s.name }));
    e.configureSpanningTree(core.id, 'rstp', n ? 4096 : 0);
    trunk(core, 'p22');
    trunk(core, 'p23');
  }
  cable(cores[0], 'p22', cores[1], 'p22');
  cable(cores[0], 'p23', cores[1], 'p23');
  for (const core of cores) trunk(core, e.configureLacp(core.id, 1, 'active', ['p22', 'p23']).id);
  const access = new Map<number, Device[]>();
  for (const [index, segment] of segments.entries()) {
    const pair = sides.map((s, n) => {
      const sw = device('access', `HA-ACCESS-${segment.name}-${s}`, index * 420 + n * 180, 450, n);
      sw.vlans = [{ id: segment.vlan, name: segment.name }];
      for (const p of sw.interfaces) p.accessVlan = segment.vlan;
      trunk(sw, 'p23');
      trunk(cores[n], 'p' + index);
      cable(sw, 'p23', cores[n], 'p' + index);
      e.configureSpanningTree(sw.id, 'rstp', 32768);
      return sw;
    });
    access.set(segment.vlan, pair);
    addCanvasItem(e, {
      kind: 'region',
      text: `${segment.name} / VLAN ${segment.vlan} / acesso A/B`,
      position: { x: index * 420 - 30, y: 390 },
      width: 410,
      height: 640,
      color: 'cyan',
    });
  }
  const counts = new Map<number, number>();
  function endpoint(profile: string, name: string, vlan: number, suffix: number) {
    const index = counts.get(vlan) ?? 0,
      segmentIndex = segments.findIndex((s) => s.vlan === vlan);
    const d = device(
      profile,
      name,
      segmentIndex * 420 + (index % 2) * 180,
      650 + Math.floor(index / 2) * 110
    );
    ip(d, 'p0', address(vlan, suffix));
    d.gateway = address(vlan, 1);
    const nic = e.installNic(d.id);
    for (const [n, port] of ['p0', nic.id].entries()) cable(d, port, access.get(vlan)![n], 'p' + index, true);
    const bond = e.configureBond(d.id, 1, ['p0', nic.id], 'p0', { target: address(vlan, 1) });
    counts.set(vlan, index + 1);
    return { d, bond };
  }
  const fws = sides.map((s, n) => device('firewall', 'HA-FW-' + s, 600 + n * 400, -100, n));
  for (const [n, fw] of fws.entries()) {
    trunk(cores[n], 'p18');
    cable(fw, 'p0', cores[n], 'p18', true);
    for (const s of segments) ip(fw, e.addSubinterface(fw.id, 'p0', s.vlan).id, address(s.vlan, n + 2));
    ip(fw, e.addSubinterface(fw.id, 'p0', 250).id, address(250, 2 + n));
    const port = (vlan: number) => fw.interfaces.find((p) => p.logical?.vlan === vlan)!.id;
    e.configureVrrp(fw.id, {
      enabled: true,
      groups: [
        ...segments.map((s) => ({ vlan: s.vlan, vip: address(s.vlan, 1) })),
        { vlan: 250, vip: address(250, 254) },
      ].map((g) => ({
        port: port(g.vlan),
        vip: g.vip,
        vrid: g.vlan,
        priority: n ? 100 : 150,
        advertMs: 250,
      })),
    });
    fw.routes.push({ network: '0.0.0.0', prefix: 0, nextHop: address(250, 1), metric: 1 });
    fw.routes.push({ network: '10.80.100.0', prefix: 24, nextHop: address(250, 253), metric: 1 });
    const zones = [
      ...segments.map((s) => ({ name: s.name, ports: [port(s.vlan)] })),
      { name: 'WAN', ports: [port(250)] },
    ];
    const permitted = segments
      .filter((s) => s.name !== 'GUEST')
      .flatMap((s) =>
        (s.name === 'MGMT' ? [...segments.map((to) => to.name), 'WAN'] : ['SERVICES', 'WAN'])
          .filter((to) => to !== s.name)
          .map((to) => ({ from: s.name, to, protocol: 'ip', action: 'inspect' }))
      );
    if (kind === 'factory')
      for (const s of segments.filter((s) => s.name.startsWith('CELL-')))
        permitted.push({ from: 'CORP', to: s.name, protocol: 'ip', action: 'inspect' });
    e.configureFirewall(fw.id, {
      enabled: true,
      protocols: ['TCP', 'UDP', 'ICMP'],
      trustedPorts: [],
      zonePolicy: {
        zones,
        rules: [
          ...permitted.map((r, i) => ({ ...r, sequence: (i + 1) * 10 })),
          {
            sequence: 990,
            from: 'USERS',
            to: 'CORP',
            protocol: 'TCP',
            destinationPort: 80,
            action: 'inspect',
          },
          {
            sequence: 1000,
            from: 'GUEST',
            to: 'WAN',
            protocol: 'TCP',
            destinationPort: 80,
            action: 'inspect',
          },
        ],
      },
    });
  }
  cable(fws[0], 'p2', fws[1], 'p2');
  e.configureStateSyncPair(fws[0].id, fws[1].id, {
    portA: 'p2',
    portB: 'p2',
    mappings: fws[0].interfaces
      .filter((p) => p.logical)
      .map((p) => ({ a: p.id, b: fws[1].interfaces.find((q) => q.logical?.vlan === p.logical!.vlan)!.id })),
  });
  endpoint('desktop', 'HA-CLIENT', 10, 10);
  endpoint('desktop', 'HA-DHCP-CLIENT', 10, 11);
  endpoint('desktop', 'HA-GUEST', 20, 10);
  endpoint('desktop', 'HA-ADMIN', 99, 10);
  // Services use independently configured content, not an invented copy of runtime state.
  for (const [n, side] of sides.entries()) {
    const { d, bond } = endpoint('server', 'HA-SERVICE-' + side, 30, n + 10);
    e.setDnsEnabled(d.id, true);
    e.configureDnsRecord(d.id, { name: 'app.ha.test', type: 'A', value: address(30, 100), ttl: 30 });
    e.configureTcpService(d.id, { enabled: true, kind: 'http', port: 80, body: 'Aplicação redundante' });
    e.configureClock(d.id, { offsetMs: 0, server: true, stratum: 1 });
    e.setSyslogEnabled(d.id, true);
    e.configureVrrp(d.id, {
      enabled: true,
      groups: [
        {
          port: bond.id,
          vrid: 130,
          vip: address(30, 100),
          priority: n ? 100 : 150,
          advertMs: 250,
          acceptMode: true,
          track: [
            { service: 'http', decrement: 80 },
            { service: 'dns', decrement: 80 },
          ],
        },
      ],
    });
  }
  const corp = endpoint('web', 'HA-ERP', 40, 10).d;
  e.configureTcpService(corp.id, { enabled: true, kind: 'http', port: 80, body: 'ERP simulado' });
  const dhcp = sides.map((s, n) => endpoint('server', 'HA-DHCP-' + s, 30, 67 + n));
  for (const { d, bond } of dhcp)
    e.configureDhcpPool(d.id, {
      name: 'USERS',
      port: bond.id,
      network: address(10, 0),
      prefix: 24,
      start: address(10, 200),
      end: address(10, 220),
      gateway: address(10, 1),
      dns: [address(30, 100)],
      relayAddress: address(10, 2),
      relayAddresses: [address(10, 3)],
      leaseMs: 16000,
      excluded: [],
    });
  const syncPorts = dhcp.map(({ d }) => e.installNic(d.id).id);
  cable(dhcp[0].d, syncPorts[0], dhcp[1].d, syncPorts[1]);
  e.configureDhcpHaPair(dhcp[0].d.id, dhcp[1].d.id, { portA: syncPorts[0], portB: syncPorts[1] });
  for (const fw of fws)
    e.configureDhcpRelay(fw.id, fw.interfaces.find((p) => p.logical?.vlan === 10)!.id, [
      address(30, 67),
      address(30, 68),
    ]);
  // External and DC endpoints have two independent switches and power inputs.
  function remote(prefix: 'WAN' | 'DC', network: string, wanVip: number, physical: number) {
    const switches = sides.map((s, n) => {
      const sw = device(
        'access',
        `HA-${prefix}-ACCESS-${s}`,
        1200 + n * 400,
        prefix === 'WAN' ? -500 : -900,
        n
      );
      e.configureSpanningTree(sw.id, 'rstp', n ? 4096 : 0);
      return sw;
    });
    cable(switches[0], 'p23', switches[1], 'p23');
    const gateways = sides.map((s, n) => {
      const d = device('edge', `HA-${prefix}-GW-${s}`, 600 + n * 400, prefix === 'WAN' ? -500 : -900, n);
      ip(d, 'p0', address(250, physical + n));
      cores[n].interfaces.find((p) => p.id === (prefix === 'WAN' ? 'p19' : 'p20'))!.accessVlan = 250;
      cable(d, 'p0', cores[n], prefix === 'WAN' ? 'p19' : 'p20', true);
      ip(d, 'p1', network + (2 + n));
      cable(d, 'p1', switches[n], 'p0', true);
      e.configureVrrp(d.id, {
        enabled: true,
        groups: [
          {
            port: 'p0',
            vrid: wanVip,
            vip: address(250, wanVip),
            priority: n ? 100 : 150,
            advertMs: 250,
            track: [{ port: 'p1', decrement: 80 }],
          },
          {
            port: 'p1',
            vrid: prefix === 'WAN' ? 201 : 202,
            vip: network + '1',
            priority: n ? 100 : 150,
            advertMs: 250,
            track: [{ port: 'p0', decrement: 80 }],
          },
        ],
      });
      d.routes.push({ network: '10.70.0.0', prefix: 16, nextHop: address(250, 254), metric: 1 });
      return d;
    });
    const d = device('web', 'HA-' + prefix + '-SERVER', 1600, prefix === 'WAN' ? -500 : -900);
    ip(d, 'p0', network + '10');
    d.gateway = network + '1';
    const nic = e.installNic(d.id);
    for (const [n, port] of ['p0', nic.id].entries()) cable(d, port, switches[n], 'p1', true);
    e.configureBond(d.id, 1, ['p0', nic.id], 'p0', { target: network + '1' });
    e.configureTcpService(d.id, { enabled: true, kind: 'http', port: 80, body: prefix + ' disponível' });
    e.configureTcpService(d.id, { enabled: true, kind: 'echo', port: 7777 });
    return gateways;
  }
  remote('WAN', '198.51.100.', 1, 10);
  remote('DC', '10.80.100.', 253, 20);
  if (kind === 'factory')
    for (const [index, vlan] of [11, 12, 13].entries()) {
      const plc = endpoint('plc', 'HA-PLC-' + (index + 1), vlan, 10).d;
      const hmi = endpoint('hmi', 'HA-HMI-' + (index + 1), vlan, 11).d;
      configureModbus(e, plc, {
        enabled: true,
        registers: [500],
        inputRegisters: [300],
        coils: [false],
        discreteInputs: [false],
      });
      e.configurePlcProcess(plc.id, {
        enabled: true,
        initialLevel: 300,
        fillPerSecond: 120,
        drainPerSecond: 30,
      });
      const scada = endpoint('server', 'HA-SCADA-' + (index + 1), 40, 20 + index).d;
      for (const client of [hmi, scada])
        e.configureHmiScan(client.id, {
          enabled: true,
          target: address(vlan, 10),
          intervalMs: 1000,
          deadlineMs: 800,
          missedBeforeAlarm: 3,
          lowAlarm: 100,
          highAlarm: 900,
        });
    }
  if (kind === 'factory') {
    const mes = endpoint('server', 'HA-MES', 40, 50).d;
    e.configureHmiScan(mes.id, {
      enabled: true,
      target: address(11, 10),
      intervalMs: 2000,
      deadlineMs: 800,
      missedBeforeAlarm: 2,
      lowAlarm: 100,
      highAlarm: 900,
    });
  }
  for (const [n, side] of sides.entries()) {
    const ups = device('ups', 'HA-UPS-' + side, 200 + n * 300, -300, n);
    e.setDevicePower(ups.id, true);
    if (ups.infrastructure?.kind !== 'ups') throw new Error('UPS inválida.');
    e.configureInfrastructure(ups.id, {
      ...ups.infrastructure,
      capacityWh: 1000,
      remainingWh: 1000,
      maxWatts: 10000,
      loads: [...shared.filter((d) => !d.infrastructure), ...local[n].filter((d) => d !== ups)].map((d) => ({
        device: d.id,
        watts: 50,
        requested: true,
      })),
    });
    const rack = device('rack', 'HA-RACK-' + side, 200 + n * 300, -800);
    e.configureInfrastructure(rack.id, {
      kind: 'rack',
      units: 42,
      ambientC: 22,
      ventilation: 1,
      slots: [...local[n]].map((d, i) => ({ device: d.id, unit: i + 1, units: 1 })),
    });
  }
  e.state.notes = `${kind === 'factory' ? 'Fábrica, oito VLANs e três células PLC/HMI/SCADA' : 'Campus enterprise, cinco VLANs'}, DC roteado e WAN A/B. Cada endpoint tem bond ativo/backup e alimentação A/B. Acesso, core, FW, WAN e DC-GW independentes por lado; RSTP/LACP, VIPs e tracking de portas, firewall com réplica. Falhas dos presets ocorrem na rede simulada. DNS/HTTP são conteúdo equivalente configurado, logs permanecem locais e sessões de serviço não são replicadas. DHCP replica leases com confirmação; sua promoção ainda exige fencing administrativo. O próprio endpoint/PLC/servidor WAN ou DC permanece único; perder as duas vias interrompe o serviço. Este modelo não acrescenta EVPN/ECMP nem quorum de serviços.`;
  return e.snapshot();
}

export function resilientScenarios(s: Snapshot): Scenario[] {
  const find = (name: string) => s.devices.find((d) => d.hostname === name);
  const client = find('HA-CLIENT'),
    guest = find('HA-GUEST'),
    admin = find('HA-ADMIN');
  if (!client || !guest || !admin || !find('HA-CORE-A') || !find('HA-WAN-GW-B')) return [];
  const common = {
    expect: 'allow' as const,
    maxLossPercent: 40,
    requireFinalSuccess: true,
    maxLatencyMs: 800,
  };
  const flows: z.input<typeof scenarioSchema>['flows'] = [
    {
      ...common,
      name: 'HTTP em VIP de serviços',
      source: client.id,
      target: address(30, 100),
      protocol: 'http',
    },
    {
      ...common,
      name: 'DNS em VIP de serviços',
      source: client.id,
      target: address(30, 100),
      protocol: 'dns',
      dns: { name: 'app.ha.test', expectedAnswers: [address(30, 100)] },
    },
    { ...common, name: 'HTTP na WAN', source: client.id, target: '198.51.100.10', protocol: 'http' },
    { ...common, name: 'HTTP no datacenter', source: client.id, target: '10.80.100.10', protocol: 'http' },
    {
      ...common,
      name: 'NTP em VIP de serviços',
      source: admin.id,
      target: address(30, 100),
      protocol: 'ntp',
      ntp: { maxOffsetMs: 20 },
    },
    {
      ...common,
      name: 'Syslog em VIP de serviços',
      source: admin.id,
      target: address(30, 100),
      protocol: 'syslog',
      syslog: { text: 'Disponibilidade integrada', severity: 6 },
    },
    {
      name: 'Guest isolado dos serviços',
      source: guest.id,
      target: address(30, 100),
      protocol: 'http',
      expect: 'deny',
      denyEvidence: 'policy',
      maxLossPercent: 0,
      requireFinalSuccess: true,
    },
  ];
  const plc = find('HA-PLC-1'),
    scada = find('HA-SCADA-1');
  if (plc && scada)
    flows.push({
      ...common,
      name: 'SCADA lê PLC de outra VLAN',
      source: scada.id,
      target: address(11, 10),
      protocol: 'modbus',
      modbus: { transaction: 1, unit: 1, function: 4, address: 0, quantity: 1 },
    });
  const base = {
    warmupMs: 12000,
    durationMs: 16000,
    intervalMs: 1000,
    deadlineMs: 800,
    flows: flows.filter((f) => f.expect === 'allow'),
    assertions: s.devices
      .filter((d) => d.hmiScan)
      .map((d) => ({
        name: d.hostname + ' comunicando',
        atMs: 14000,
        kind: 'hmi-alarm',
        target: d.id,
        alarm: 'communication',
        expected: false,
      })),
  };
  const scenarios = [
    scenarioSchema.parse({
      ...base,
      name: 'HA integrada — baseline',
      flows: flows.map((f) => ({ ...f, maxLossPercent: 0 })),
      faults: [],
    }),
  ];
  for (const name of [
    'HA-CORE-A',
    'HA-ACCESS-USERS-A',
    'HA-FW-A',
    'HA-WAN-GW-A',
    'HA-DC-GW-A',
    'HA-WAN-ACCESS-A',
    'HA-DC-ACCESS-A',
    'HA-SERVICE-A',
    'HA-UPS-A',
  ]) {
    const d = find(name);
    if (d)
      scenarios.push(
        scenarioSchema.parse({
          ...base,
          name: 'HA integrada — perda de ' + name,
          faults: [{ atMs: 2000, kind: 'device', target: d.id, up: false }],
        })
      );
  }
  const rack = s.devices.find((d) => d.hostname === 'HA-RACK-A' && d.infrastructure?.kind === 'rack');
  if (rack?.infrastructure?.kind === 'rack')
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name: 'HA integrada — perda do rack A',
        faults: rack.infrastructure.slots.map((slot) => ({
          atMs: 2000,
          kind: 'device',
          target: slot.device,
          up: false,
        })),
      })
    );
  const uplink = s.links.find((l) =>
    [l.a, l.b].some((p) => p.device === find('HA-ACCESS-USERS-A')?.id && p.port === 'p23')
  );
  if (uplink)
    scenarios.push(
      scenarioSchema.parse({
        ...base,
        name: 'HA integrada — uplink sem perda de carrier no host',
        faults: [{ atMs: 2000, kind: 'link', target: uplink.id, up: false }],
      })
    );
  scenarios.push(
    scenarioSchema.parse({
      ...base,
      name: 'HA integrada — perda e retorno do core A',
      faults: [
        { atMs: 2000, kind: 'device', target: find('HA-CORE-A')!.id, up: false },
        { atMs: 10000, kind: 'device', target: find('HA-CORE-A')!.id, up: true },
      ],
    })
  );
  return scenarios;
}
