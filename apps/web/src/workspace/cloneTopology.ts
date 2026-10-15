import {
  SimulationEngine,
  validateSnapshot,
  configurationDiff,
  addCanvasItem,
  bgpConfig,
  vrrpConfigGroups,
  ipv6Config,
  ipNumber,
  ipString,
  subnet,
  ipv4Schema,
  canvasPosition,
  wirelessConfig,
  configurationSchemas,
  ipv6Schema,
  ipv6Number,
  ipv6String,
  network6,
  linkLocal6,
  multicast6,
  interfaceId6,
  type Snapshot,
  type Device,
} from '@shlab/engine';
import { duplicateDevice } from './duplicateDevice';

/** Prepare on an isolated engine. No part of a failed clone reaches the editor. */
export function cloneTopology(source: Snapshot, selection: string[]) {
  const e = new SimulationEngine(source),
    chosen = new Set(selection);
  for (const item of source.canvasItems ?? [])
    if (chosen.has(item.id)) for (const id of item.members ?? []) chosen.add(id);
  // A rack selection includes its mounted devices; a UPS includes only loads
  // already selected, so cloning a supply never takes over the original load.
  for (const d of source.devices)
    if (chosen.has(d.id) && d.infrastructure?.kind === 'rack')
      for (const slot of d.infrastructure.slots) chosen.add(slot.device);
  const originals = source.devices.filter((d) => chosen.has(d.id));
  if (!originals.length) throw new Error('Selecione equipamentos, uma célula agrupada ou um rack.');
  if (source.devices.length + originals.length > 2000) throw new Error('O clone excede 2000 equipamentos.');
  const mapping = new Map<string, string>(),
    ports = new Map<string, Map<string, string>>();
  for (const d of originals) {
    const copy = duplicateDevice(e, d);
    mapping.set(d.id, copy.device.id);
    ports.set(d.id, copy.portMapping);
  }
  const networks = originals.flatMap((d) =>
    d.interfaces.flatMap((p) =>
      p.ip && p.prefix !== undefined
        ? [{ start: ipNumber(subnet(p.ip, p.prefix).network), size: 2 ** (32 - p.prefix) }]
        : []
    )
  );
  // Preserve the alignment of policy/route/pool prefixes that contain a
  // selected address, not just the narrower connected interfaces.
  const selectedAddresses = originals.flatMap((d) =>
    d.interfaces.flatMap((p) => (p.ip ? [ipNumber(p.ip)] : []))
  );
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (
      typeof object.network === 'string' &&
      ipv4Schema.safeParse(object.network).success &&
      typeof object.prefix === 'number' &&
      object.prefix > 0 &&
      object.prefix <= 32
    ) {
      const start = ipNumber(subnet(object.network, object.prefix).network),
        size = 2 ** (32 - object.prefix);
      if (selectedAddresses.some((ip) => ip >= start && ip < start + size)) networks.push({ start, size });
    }
    for (const next of Object.values(object)) collect(next);
  };
  originals.forEach(collect);
  const occupied = source.devices.flatMap((d) =>
    d.interfaces.flatMap((p) =>
      p.ip && p.prefix !== undefined
        ? [{ start: ipNumber(subnet(p.ip, p.prefix).network), size: 2 ** (32 - p.prefix) }]
        : []
    )
  );
  const alignment = networks.reduce((size, n) => Math.max(size, n.size), 256);
  let offset = alignment;
  for (; offset < 0x10000000; offset += alignment) {
    if (
      networks.every(
        (n) =>
          n.start + offset + n.size <= 0xe0000000 &&
          n.start + offset > 0x01000000 &&
          occupied.every((o) => n.start + offset + n.size <= o.start || n.start + offset >= o.start + o.size)
      )
    )
      break;
  }
  if (networks.length && offset >= 0x10000000)
    throw new Error('Sem bloco IPv4 livre para preservar os prefixos da seleção.');
  const address = (s: string) => {
    if (!ipv4Schema.safeParse(s).success) return s;
    const n = ipNumber(s);
    return networks.some((b) => n >= b.start && n < b.start + b.size) ? ipString(n + offset) : s;
  };
  const ranges6 = originals.flatMap((d) =>
    d.interfaces.flatMap(
      (p) =>
        p.ipv6?.addresses
          .filter((a) => a.origin === 'static')
          .map((a) => ({
            start: ipv6Number(network6(a.ip, a.prefix)),
            size: 1n << BigInt(128 - a.prefix),
          })) ?? []
    )
  );
  const occupied6 = source.devices.flatMap((d) =>
    d.interfaces.flatMap(
      (p) =>
        p.ipv6?.addresses
          .filter((a) => !linkLocal6(a.ip))
          .map((a) => ({
            start: ipv6Number(network6(a.ip, a.prefix)),
            size: 1n << BigInt(128 - a.prefix),
          })) ?? []
    )
  );
  const selected6 = originals.flatMap((d) =>
    d.interfaces.flatMap(
      (p) =>
        p.ipv6?.addresses
          .filter((a) => !linkLocal6(a.ip) && !multicast6(a.ip))
          .map((a) => ipv6Number(a.ip)) ?? []
    )
  );
  const collect6 = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (
      typeof object.network === 'string' &&
      ipv6Schema.safeParse(object.network).success &&
      typeof object.prefix === 'number' &&
      object.prefix > 0 &&
      object.prefix <= 128
    ) {
      const start = ipv6Number(network6(object.network, object.prefix)),
        size = 1n << BigInt(128 - object.prefix);
      if (selected6.some((ip) => ip >= start && ip < start + size)) ranges6.push({ start, size });
    }
    for (const next of Object.values(object)) collect6(next);
  };
  originals.forEach(collect6);
  const alignment6 = ranges6.reduce((n, r) => (r.size > n ? r.size : n), 1n << 64n);
  let offset6 = alignment6;
  for (let attempt = 0; attempt < 4094; attempt++, offset6 += alignment6)
    if (
      ranges6.every(
        (n) =>
          n.start + offset6 + n.size < 1n << 128n &&
          occupied6.every(
            (o) => n.start + offset6 + n.size <= o.start || n.start + offset6 >= o.start + o.size
          )
      )
    )
      break;
  if (
    ranges6.some(
      (n) =>
        n.start + offset6 + n.size >= 1n << 128n ||
        occupied6.some((o) => n.start + offset6 + n.size > o.start && n.start + offset6 < o.start + o.size)
    )
  )
    throw new Error('Sem prefixo IPv6 livre para o clone.');
  const address6 = (s: string) => {
    if (!ipv6Schema.safeParse(s).success || linkLocal6(s) || multicast6(s)) return s;
    const n = ipv6Number(s);
    return ranges6.some((b) => n >= b.start && n < b.start + b.size) ? ipv6String(n + offset6) : s;
  };
  const reservedVlans = new Set(source.devices.flatMap((d) => d.vlans.map((v) => v.id)));
  const vlans = new Map<number, number>();
  for (const n of new Set(
    originals.flatMap((d) => [
      ...d.vlans.map((v) => v.id),
      ...d.interfaces.flatMap((p) => [p.accessVlan, p.nativeVlan, ...p.allowedVlans]),
    ])
  )) {
    let free = 2;
    while (reservedVlans.has(free)) free++;
    if (free > 4094) throw new Error('Sem VLAN livre para o clone.');
    reservedVlans.add(free);
    vlans.set(n, free);
  }
  const reservedVnis = new Set(
      source.devices.flatMap((d) => d.interfaces.flatMap((p) => (p.vxlan ? [p.vxlan.vni] : [])))
    ),
    vnis = new Map<number, number>();
  for (const n of new Set(
    originals.flatMap((d) => d.interfaces.flatMap((p) => (p.vxlan ? [p.vxlan.vni] : [])))
  )) {
    let free = n + 1;
    while (reservedVnis.has(free)) free++;
    if (free > 16777215) throw new Error('Sem VNI livre para o clone.');
    vnis.set(n, free);
    reservedVnis.add(free);
  }
  const macs = new Map<string, string>();
  for (const d of originals)
    for (const p of d.interfaces)
      if (ports.get(d.id)!.has(p.id))
        macs.set(
          p.mac,
          e.device(mapping.get(d.id)!).interfaces.find((v) => v.id === ports.get(d.id)!.get(p.id))!.mac
        );
  const linkLocals = new Map<string, string>();
  for (const d of originals)
    for (const p of d.interfaces)
      for (const a of p.ipv6?.addresses ?? [])
        if (linkLocal6(a.ip) && macs.has(p.mac))
          linkLocals.set(a.ip, ipv6String(ipv6Number('fe80::') | interfaceId6(macs.get(p.mac)!)));
  const warnings = new Set<string>();
  function remap<T>(value: T, d: Device, key = ''): T {
    if (typeof value === 'string')
      return (mapping.get(value) ??
        ports.get(d.id)!.get(value) ??
        macs.get(value) ??
        linkLocals.get(value) ??
        address6(address(value))) as T;
    if (typeof value === 'number' && ['vlan', 'accessVlan', 'nativeVlan', 'allowedVlans'].includes(key))
      return (vlans.get(value) ?? value) as T;
    if (typeof value === 'number' && key === 'vni') return (vnis.get(value) ?? value) as T;
    if (Array.isArray(value)) return value.map((v) => remap(v, d, key)) as T;
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, d, k)])) as T;
    return value;
  }
  for (const d of originals) {
    const copy = e.device(mapping.get(d.id)!);
    if (d.wireless) {
      e.configureWireless(copy.id, { ...wirelessConfig(d), enabled: false });
      warnings.add(
        'Rádios e mesh começam desativados para impedir associação automática com a célula original.'
      );
    }
    if (copy.mesh) copy.mesh.enabled = false;
    copy.vlans = d.vlans.map((v) => ({ ...v, id: vlans.get(v.id)! }));
    copy.routes = remap(d.routes, d);
    if (d.gateway) copy.gateway = address(d.gateway);
    if (copy.hmiScan) {
      copy.hmiScan.target = address(copy.hmiScan.target);
      copy.hmiScan.enabled = d.hmiScan!.enabled;
    }
    for (const p of d.interfaces) {
      const q = copy.interfaces.find((v) => v.id === ports.get(d.id)!.get(p.id));
      if (!q) continue;
      for (const k of [
        'ip',
        'prefix',
        'gateway',
        'dns',
        'dhcpRelay',
        'aclIn',
        'aclOut',
        'natRole',
        'channel',
        'stpEdge',
        'stpCost',
      ] as const)
        if (p[k] !== undefined && !(p.ipv4Mode === 'dhcp' && ['ip', 'prefix', 'gateway', 'dns'].includes(k)))
          Object.assign(q, { [k]: remap(p[k], d, k) });
      q.accessVlan = vlans.get(p.accessVlan)!;
      q.nativeVlan = vlans.get(p.nativeVlan)!;
      q.allowedVlans = p.allowedVlans.map((n) => vlans.get(n)!);
      if (q.logical) q.logical = remap(q.logical, d);
      if (q.tunnel) q.tunnel = remap(q.tunnel, d);
      if (q.qos) q.qos = remap(q.qos, d);
      if (q.bond?.monitor) q.bond.monitor.target = address(q.bond.monitor.target);
      if (p.ipv6) e.configureIpv6(copy.id, q.id, remap(ipv6Config(p), d));
      if (p.dhcp6) {
        const config = Object.fromEntries(
          Object.keys(configurationSchemas.dhcp6.client.shape)
            .filter((k) => k in p.dhcp6!)
            .map((k) => [k, (p.dhcp6 as unknown as Record<string, unknown>)[k]])
        );
        e.configureDhcp6Client(copy.id, q.id, remap(config, d));
      }
      if (p.dhcp6Relay) e.configureDhcp6Relay(copy.id, q.id, remap(p.dhcp6Relay, d));
      if (q.vxlan) {
        q.vxlan.vni = vnis.get(p.vxlan!.vni)!;
        q.vxlan.vlan = vlans.get(p.vxlan!.vlan)!;
        q.vxlan.peers = p.vxlan!.peers.map(address);
        q.vxlan.routeTarget = p.vxlan!.routeTarget.split(':')[0] + ':' + q.vxlan.vni;
        warnings.add(
          'Overlays e túneis começam desativados; revise os peers e route targets antes de ativá-los.'
        );
      }
    }
    if (d.infrastructure?.kind === 'rack')
      copy.infrastructure = { ...d.infrastructure, slots: remap(d.infrastructure.slots, d) };
    if (d.infrastructure?.kind === 'ups')
      copy.infrastructure = {
        ...d.infrastructure,
        loads: remap(
          d.infrastructure.loads.filter((l) => mapping.has(l.device)),
          d
        ),
        lastAt: e.state.clock,
      };
    if (d.accessLists) copy.accessLists = remap(copy.accessLists, d);
    if (d.firewall) e.configureFirewall(copy.id, remap(copy.firewall, d));
    if (d.nat) e.configureNat(copy.id, remap({ ...d.nat, bindings: [] }, d));
    if (d.dnsServer) copy.dnsServer = remap(copy.dnsServer, d);
    if (d.proxy) copy.proxy!.backends = remap(d.proxy.backends, d);
    for (const key of [
      'ntp',
      'syslogClient',
      'aaaClient',
      'aaaServer',
      'remoteManagement',
      'wlc',
      'wtp',
      'sdwan',
      'sdwanController',
      'mesh',
      'telemetry',
    ] as const)
      if (copy[key]) Object.assign(copy, { [key]: remap(copy[key], d) });
    if (d.routes6)
      copy.routes6 = remap(
        d.routes6.filter((r) => !r.dhcp6Lease),
        d
      );
    if (d.dhcpServer) for (const pool of d.dhcpServer.pools) e.configureDhcpPool(copy.id, remap(pool, d));
    if (d.vrrp) e.configureVrrp(copy.id, { enabled: d.vrrp.enabled, groups: remap(vrrpConfigGroups(d), d) });
    if (d.bgp) e.configureBgp(copy.id, remap(bgpConfig(d), d));
    for (const [key, configure, schema] of [
      ['ospf', e.configureOspf.bind(e), configurationSchemas.ospf],
      ['rip', e.configureRip.bind(e), configurationSchemas.rip],
      ['dhcpSnooping', e.configureDhcpSnooping.bind(e), configurationSchemas.dhcpProtection],
      ['dhcp6Server', e.configureDhcp6Server.bind(e), configurationSchemas.dhcp6.server],
      ['eapServer', e.configureEapServer.bind(e), configurationSchemas.advancedNetwork.eapServer],
      [
        'eapAuthenticator',
        e.configureEapAuthenticator.bind(e),
        configurationSchemas.advancedNetwork.eapAuthenticator,
      ],
      ['eapSupplicant', e.configureEapSupplicant.bind(e), configurationSchemas.advancedNetwork.eapSupplicant],
      ['mpls', e.configureMpls.bind(e), configurationSchemas.mpls],
    ] as const) {
      const input = d[key];
      if (input) {
        const clean = Object.fromEntries(
          Object.keys(schema.shape)
            .filter((k) => k in input)
            .map((k) => [k, (input as unknown as Record<string, unknown>)[k]])
        );
        configure(copy.id, remap(clean, d));
      }
    }
    if (d.multiSpanningTree) {
      const c = {
        mode: d.multiSpanningTree.mode,
        region: d.multiSpanningTree.region,
        revision: d.multiSpanningTree.revision,
        priorities: d.multiSpanningTree.priorities,
        mappings: d.multiSpanningTree.mappings.map((m) => ({ ...m, vlan: vlans.get(m.vlan) ?? m.vlan })),
      };
      e.configureMultiSpanningTree(copy.id, c);
    }
    if (d.poeSupply) e.configurePoe(copy.id, remap({ ...d.poeSupply, allocations: [] }, d));
    if (d.poeDevice) copy.poeDevice = structuredClone(d.poeDevice);
  }
  const linkMapping = new Map<string, string>();
  for (const l of source.links.filter((l) => mapping.has(l.a.device) && mapping.has(l.b.device))) {
    if (['wireless', 'mesh'].includes(l.cable)) continue;
    const copy = e.connect(
      { device: mapping.get(l.a.device)!, port: ports.get(l.a.device)!.get(l.a.port)! },
      { device: mapping.get(l.b.device)!, port: ports.get(l.b.device)!.get(l.b.port)! },
      l.cable,
      { latency: l.latency, jitter: l.jitter, loss: l.loss, distance: l.distance }
    );
    copy.up = l.up;
    linkMapping.set(l.id, copy.id);
  }
  for (const d of originals)
    if (d.stateSync && mapping.has(d.stateSync.peer) && d.id < d.stateSync.peer) {
      const peer = source.devices.find((v) => v.id === d.stateSync!.peer)!;
      e.configureStateSyncPair(mapping.get(d.id)!, mapping.get(peer.id)!, {
        portA: ports.get(d.id)!.get(d.stateSync.port),
        portB: ports.get(peer.id)!.get(peer.stateSync!.port),
        mappings: d.stateSync.portMap.map((m) => ({
          a: ports.get(d.id)!.get(m.local),
          b: ports.get(peer.id)!.get(m.remote),
        })),
      });
    }
  const items = [];
  for (const item of source.canvasItems ?? [])
    if (chosen.has(item.id)) {
      const anchor =
        item.anchor &&
        (item.anchor.kind === 'device'
          ? mapping.get(item.anchor.target)
          : linkMapping.get(item.anchor.target));
      const { id: _id, ...configuration } = item;
      void _id;
      const position = canvasPosition(source, item);
      const copy = addCanvasItem(e, {
        ...configuration,
        position: anchor ? item.position : { x: position.x + 50, y: position.y + 80 },
        members: item.members?.flatMap((id) => (mapping.has(id) ? [mapping.get(id)!] : [])),
        anchor: anchor ? { ...item.anchor!, target: anchor } : undefined,
      });
      items.push(copy.id);
    }
  if (source.links.some((l) => mapping.has(l.a.device) !== mapping.has(l.b.device)))
    warnings.add('Cabos externos não foram copiados; conecte os novos uplinks após a revisão.');
  // Configuration helpers can refresh global control state. Preserve all of the
  // original devices/queues/cables, and include only work owned by the new cell.
  const clonedIds = new Set(mapping.values()),
    oldIds = new Set(source.devices.map((d) => d.id));
  e.state.devices = e.state.devices.map((d) =>
    oldIds.has(d.id) ? structuredClone(source.devices.find((v) => v.id === d.id)!) : d
  );
  e.state.links = [
    ...structuredClone(source.links),
    ...e.state.links.filter((l) => clonedIds.has(l.a.device) && clonedIds.has(l.b.device)),
  ];
  e.state.queue = [
    ...structuredClone(source.queue),
    ...e.state.queue.filter((q) => 'device' in q.action && clonedIds.has(q.action.device)),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  e.state.events = [
    ...structuredClone(source.events),
    ...e.state.events.filter((ev) => clonedIds.has(ev.device)),
  ].slice(-4000);
  const snapshot = validateSnapshot(e.snapshot());
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 16 * 1024 * 1024 - 4096)
    throw new Error(
      'O clone excede o limite de persistência de 16 MiB. Reduza a seleção ou a captura antes de preparar novamente.'
    );
  return {
    snapshot,
    selected: items.length ? items : [...mapping.values()],
    diff: configurationDiff(source, snapshot),
    addresses: originals.flatMap((d) =>
      d.interfaces.flatMap((p) =>
        p.ip
          ? [
              {
                device: d.hostname,
                before: p.ip,
                after: p.ipv4Mode === 'dhcp' ? 'DHCP (novo lease)' : address(p.ip),
              },
            ]
          : []
      )
    ),
    vlans: [...vlans],
    warnings: [...warnings],
  };
}
