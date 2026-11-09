import type { SimulationEngine } from '../core/engine';
import { invalidateProtocolIndex } from '../core/protocol-index';
import { LIMITS, type Action, type Device, type Frame, type NetworkInterface, type Snapshot } from '../model';
import { interfaceOperational } from './layer3';
import { ipNumber } from './ipv4';
import { linkLocal6, network6 } from './ipv6-address';
import { usable6 } from './ipv6-routing';
import { longInterfaceName } from './interface-name';
import { ospf3PayloadBytes } from '../wire/ospf3-codec';
import {
  OSPF3,
  ospf3ConfigSchema,
  type Ospf3Config,
  type Ospf3Lsa,
  type Ospf3Message,
  type Ospf3Neighbor,
  type Ospf3Packet,
  type Ospf3Route,
  type Ospf3State,
} from './ospf3-model';

/**
 * OSPFv3 for IPv6 (RFC 5340), single process per router: Hellos from the link-local address to
 * FF02::5, the DR/BDR election on broadcast links, adjacencies that exchange and flood the link
 * state database, router / intra-area-prefix / inter-area-prefix LSAs, SPF per area and ABR
 * summaries between areas. The database exchange is condensed: a new adjacency sends its whole
 * area database in Link State Updates, and later changes are flooded to the FULL neighbors.
 */
type Tick = Extract<Action, { kind: 'ospf3-tick' }>;
type Interface = Ospf3Config['interfaces'][number];
type Hop = { port: string; address: string };
const NONE = '0.0.0.0';
const portOf = (d: Device, id: string) => d.interfaces.find((p) => p.id === id);
const lsaKey = (l: Pick<Ospf3Lsa, 'type' | 'area' | 'advertisingRouter' | 'id'>) =>
  `${l.type}|${l.area}|${l.advertisingRouter}|${l.id}`;
const prefixKey = (x: { network: string; prefix: number }) => x.network + '/' + x.prefix;

// --- configuration helpers ----------------------------------------------------------------------
export function ospf3Config(d: Device): Ospf3Config | undefined {
  const s = d.ospf3;
  if (!s) return undefined;
  return ospf3ConfigSchema.parse(
    Object.fromEntries(Object.entries(s).filter(([key]) => key in ospf3ConfigSchema.shape))
  );
}
export const ospf3Passive = (s: Pick<Ospf3Config, 'passiveDefault' | 'passive'>, port: string) =>
  s.passiveDefault ? !s.passive.includes(port) : s.passive.includes(port);
/** Link-local address OSPFv3 sends from (every IPv6 interface has one). */
export const ospf3LinkLocal = (p: NetworkInterface) => usable6(p).find((a) => linkLocal6(a.ip))?.ip;
/** Interface cost: "ipv6 ospf cost" or the reference bandwidth over the interface bandwidth. */
export function ospf3Cost(s: Pick<Ospf3Config, 'interfaces' | 'referenceBandwidth'>, p: NetworkInterface) {
  const configured = s.interfaces.find((i) => i.port === p.id)?.cost;
  if (configured !== undefined) return configured;
  if (p.loopback) return 1;
  const kbps = p.bandwidthKbps ?? (p.iosTunnel || p.tunnel ? 100 : Math.max(1, p.speed * 1000));
  return Math.max(1, Math.min(65535, Math.floor((s.referenceBandwidth * 1000) / kbps)));
}
function chooseRouterId(d: Device) {
  if (d.ospf3?.routerId) return d.ospf3.routerId;
  const addressed = d.interfaces.filter((p) => p.ip && !p.vrf && p.adminUp);
  const loopbacks = addressed.filter((p) => p.loopback);
  return (loopbacks.length ? loopbacks : addressed)
    .map((p) => p.ip!)
    .sort((a, b) => ipNumber(b) - ipNumber(a))[0];
}
/** Router ID in use (or the one the process would choose). */
export function ospf3RouterId(d: Device) {
  return d.ospf3?.rid ?? chooseRouterId(d);
}
const areasOf = (s: Ospf3State) =>
  [...new Set(s.interfaces.filter((i) => activePort(s, i.port)).map((i) => i.area))].sort((a, b) => a - b);
const activePort = (s: Ospf3State, port: string) => !!s.ports.find((r) => r.port === port)?.operational;
/** An area border router has active interfaces in the backbone and in another area. */
export const ospf3Abr = (s: Ospf3State) => {
  const areas = areasOf(s);
  return areas.includes(0) && areas.length > 1;
};

// --- packets ------------------------------------------------------------------------------------
function transmit(
  e: SimulationEngine,
  d: Device,
  s: Ospf3State,
  c: Interface,
  message: Ospf3Message,
  neighbor?: Ospf3Neighbor
) {
  const p = portOf(d, c.port),
    src = p && ospf3LinkLocal(p);
  if (!p || !src || !s.rid || !d.power || !p.adminUp) return;
  const packet: Ospf3Packet = {
    src,
    dst: neighbor?.address ?? OSPF3.allRouters,
    hopLimit: 1,
    protocol: 'OSPFv3',
    kind: 'ospf',
    routerId: s.rid,
    area: c.area,
    message,
    bytes: 40 + ospf3PayloadBytes(message),
  };
  const frame: Frame = {
    src: p.mac,
    dst: neighbor?.mac ?? OSPF3.mac,
    etherType: 'IPv6',
    ipv6: packet,
    hops: LIMITS.l2Hops,
  };
  e.emit(
    message.type === 'hello' ? 'OSPF_HELLO' : 'OSPF_SENT',
    d.id,
    `OSPFv3 ${message.type === 'hello' ? 'Hello' : 'LS Update'} area ${c.area} on ${p.name} to ${(neighbor?.address ?? OSPF3.allRouters).toUpperCase()}` +
      (message.type === 'update' ? `, ${message.lsas.length} LSA(s)` : '') +
      '.',
    { port: p.id, frame }
  );
  e.sendFrame(d.id, p.id, frame);
}
const lsaBytes = (l: Ospf3Lsa) => ospf3PayloadBytes({ type: 'update', lsas: [l] }) - 20;
/** Link State Updates within the interface MTU (and 256 LSAs each). */
function sendLsas(
  e: SimulationEngine,
  d: Device,
  s: Ospf3State,
  c: Interface,
  lsas: Ospf3Lsa[],
  neighbor?: Ospf3Neighbor
) {
  const mtu = portOf(d, c.port)?.mtu ?? 1500;
  let batch: Ospf3Lsa[] = [],
    size = 40 + 20;
  for (const l of lsas) {
    const bytes = lsaBytes(l);
    if (batch.length && (size + bytes > mtu || batch.length >= 256)) {
      transmit(e, d, s, c, { type: 'update', lsas: batch }, neighbor);
      batch = [];
      size = 40 + 20;
    }
    batch.push(structuredClone(l));
    size += bytes;
  }
  if (batch.length) transmit(e, d, s, c, { type: 'update', lsas: batch }, neighbor);
}
/**
 * Floods LSAs to the FULL neighbors of their area. On the interface it came from, an LSA is sent
 * back only by the DR (to the other routers of the segment); duplicates are ignored on reception.
 */
function flood(e: SimulationEngine, d: Device, s: Ospf3State, lsas: Ospf3Lsa[], from?: Ospf3Neighbor) {
  for (const c of s.interfaces) {
    const list = lsas.filter((l) => l.area === c.area);
    if (!list.length || !activePort(s, c.port) || ospf3Passive(s, c.port)) continue;
    const full = s.neighbors.filter((n) => n.port === c.port && n.state === 'FULL' && n !== from);
    if (!full.length) continue;
    if (from && from.port === c.port && s.ports.find((r) => r.port === c.port)?.dr !== s.rid) continue;
    sendLsas(e, d, s, c, list);
  }
}

// --- neighbors ----------------------------------------------------------------------------------
function adjacency(
  e: SimulationEngine,
  d: Device,
  s: Ospf3State,
  n: Ospf3Neighbor,
  from: string,
  to: string,
  reason?: string
) {
  const p = portOf(d, n.port);
  e.emit(
    'OSPF_NEIGHBOR_CHANGED',
    d.id,
    `%OSPFv3-5-ADJCHG: Process ${s.processId}, IPv6, Nbr ${n.routerId} on ${longInterfaceName(p?.name ?? n.port)} from ${from} to ${to}, ${reason ?? 'Loading Done'}`,
    { port: n.port }
  );
}
function neighborDown(e: SimulationEngine, d: Device, s: Ospf3State, n: Ospf3Neighbor, reason: string) {
  s.neighbors = s.neighbors.filter((x) => x !== n);
  if (n.state !== 'INIT') adjacency(e, d, s, n, n.state, 'DOWN', 'Neighbor Down: ' + reason);
  s.spfDue = true;
}
/** Adjacencies form on point-to-point links and with the DR and BDR of a broadcast segment. */
function adjacent(s: Ospf3State, c: Interface, n: Ospf3Neighbor) {
  if (c.networkType === 'point-to-point') return true;
  const r = s.ports.find((x) => x.port === c.port);
  if (!r || r.dr === NONE) return false;
  return [r.dr, r.bdr].includes(s.rid!) || [r.dr, r.bdr].includes(n.routerId);
}
function syncAdjacencies(e: SimulationEngine, d: Device, s: Ospf3State) {
  for (const n of s.neighbors) {
    const c = s.interfaces.find((i) => i.port === n.port);
    if (!c || n.state === 'INIT') continue;
    const wanted = adjacent(s, c, n);
    if (wanted && n.state === '2WAY') {
      n.state = 'FULL';
      // Condensed database exchange: the whole area database goes to the new neighbor.
      sendLsas(
        e,
        d,
        s,
        c,
        s.lsdb.filter((l) => l.area === c.area),
        n
      );
      adjacency(e, d, s, n, 'LOADING', 'FULL');
      s.spfDue = true;
    } else if (!wanted && n.state === 'FULL') {
      n.state = '2WAY';
      s.spfDue = true;
    }
  }
}
type Candidate = { id: string; priority: number; dr: string; bdr: string };
const better = (a: Candidate, b: Candidate) => a.priority - b.priority || ipNumber(a.id) - ipNumber(b.id);
const best = (list: Candidate[]) => [...list].sort((a, b) => better(b, a))[0];
/** DR/BDR election (RFC 2328 9.4): routers already declared keep their role (no preemption). */
function elect(e: SimulationEngine, d: Device, s: Ospf3State, c: Interface, now: number) {
  const r = s.ports.find((x) => x.port === c.port)!;
  const neighbors = s.neighbors.filter((n) => n.port === c.port && n.state !== 'INIT');
  // Waiting state: a dead interval, unless a neighbor already declares a DR or BDR.
  if (now < r.upAt + c.deadMs && !neighbors.some((n) => n.dr !== NONE || n.bdr !== NONE)) return;
  const self: Candidate = { id: s.rid!, priority: c.priority, dr: r.dr, bdr: r.bdr };
  const candidates = [
    self,
    ...neighbors.map((n) => ({ id: n.routerId, priority: n.priority, dr: n.dr, bdr: n.bdr })),
  ];
  const calculate = () => {
    const eligible = candidates.filter((x) => x.priority > 0);
    const notDr = eligible.filter((x) => x.dr !== x.id);
    const bdr = best(notDr.filter((x) => x.bdr === x.id)) ?? best(notDr);
    const dr = best(eligible.filter((x) => x.dr === x.id)) ?? bdr;
    return { dr: dr?.id ?? NONE, bdr: bdr && bdr.id !== dr?.id ? bdr.id : NONE };
  };
  let result = calculate();
  const role = (x: { dr: string; bdr: string }) => (x.dr === self.id ? 'DR' : x.bdr === self.id ? 'BDR' : '');
  if (role(result) !== role(self)) {
    self.dr = result.dr === self.id ? self.id : self.dr === self.id ? NONE : self.dr;
    self.bdr = result.bdr === self.id ? self.id : self.bdr === self.id ? NONE : self.bdr;
    if (result.dr === self.id) self.bdr = NONE;
    result = calculate();
  }
  if (result.dr === r.dr && result.bdr === r.bdr) return;
  r.dr = result.dr;
  r.bdr = result.bdr;
  s.spfDue = true;
  const p = portOf(d, c.port)!;
  e.emit('OSPF_DR_CHANGED', d.id, `OSPFv3: ${p.name} DR ${r.dr}, BDR ${r.bdr}.`, { port: p.id });
}
function hello(e: SimulationEngine, d: Device, s: Ospf3State, c: Interface) {
  const r = s.ports.find((x) => x.port === c.port)!;
  const p2p = c.networkType === 'point-to-point';
  transmit(e, d, s, c, {
    type: 'hello',
    interfaceId: d.interfaces.findIndex((p) => p.id === c.port) + 1,
    priority: c.priority,
    helloMs: c.helloMs,
    deadMs: c.deadMs,
    dr: p2p ? NONE : r.dr,
    bdr: p2p ? NONE : r.bdr,
    neighbors: s.neighbors.filter((n) => n.port === c.port).map((n) => n.routerId),
  });
}

// --- link state database ------------------------------------------------------------------------
/** Prefixes of the router's own active interfaces in an area (loopbacks as /128, like IOS). */
function ownPrefixes(d: Device, s: Ospf3State, area: number) {
  const out = new Map<string, Ospf3Lsa['prefixes'][number]>();
  for (const c of s.interfaces) {
    const p = portOf(d, c.port);
    if (c.area !== area || !p || !activePort(s, c.port)) continue;
    for (const a of usable6(p)) {
      if (linkLocal6(a.ip)) continue;
      const host = p.loopback && c.networkType !== 'point-to-point';
      const x = host
        ? { network: a.ip, prefix: 128, metric: 0 }
        : { network: network6(a.ip, a.prefix), prefix: a.prefix, metric: ospf3Cost(s, p) };
      const key = prefixKey(x);
      if (!out.has(key) || out.get(key)!.metric > x.metric) out.set(key, x);
    }
  }
  return [...out.values()].sort((a, b) => prefixKey(a).localeCompare(prefixKey(b)));
}
/** Neighbors a router LSA lists: FULL ones, and on a synchronized broadcast segment the others too. */
function linked(s: Ospf3State, c: Interface) {
  const all = s.neighbors.filter((n) => n.port === c.port && n.state !== 'INIT');
  const synced = all.some((n) => n.state === 'FULL');
  return all.filter((n) => n.state === 'FULL' || (c.networkType === 'broadcast' && synced));
}
function desiredLsas(d: Device, s: Ospf3State, inter: Map<number, Ospf3Lsa['prefixes']>) {
  const out: Omit<Ospf3Lsa, 'sequence' | 'originatedAt'>[] = [];
  for (const area of areasOf(s)) {
    const links = s.interfaces
      .filter((c) => c.area === area && activePort(s, c.port) && !ospf3Passive(s, c.port))
      .flatMap((c) => {
        const cost = ospf3Cost(s, portOf(d, c.port)!);
        return linked(s, c).map((n) => ({ neighbor: n.routerId, cost }));
      })
      .sort((a, b) => ipNumber(a.neighbor) - ipNumber(b.neighbor) || a.cost - b.cost);
    out.push({ type: 'router', area, advertisingRouter: s.rid!, id: 0, links, prefixes: [] });
    const prefixes = ownPrefixes(d, s, area);
    if (prefixes.length)
      out.push({ type: 'prefix', area, advertisingRouter: s.rid!, id: 0, links: [], prefixes });
    const summary = inter.get(area);
    if (summary?.length)
      out.push({
        type: 'inter-prefix',
        area,
        advertisingRouter: s.rid!,
        id: 0,
        links: [],
        prefixes: summary,
      });
  }
  return out;
}
const content = (l: Pick<Ospf3Lsa, 'links' | 'prefixes' | 'flushed'>) =>
  JSON.stringify([l.links, l.prefixes, !!l.flushed]);
/** Originates the router's LSAs; changed ones get a new sequence number and are flooded. */
function originate(e: SimulationEngine, d: Device, s: Ospf3State, inter: Map<number, Ospf3Lsa['prefixes']>) {
  const now = e.state.clock,
    changed: Ospf3Lsa[] = [];
  const desired = desiredLsas(d, s, inter);
  const keys = new Set(desired.map(lsaKey));
  for (const want of desired) {
    const old = s.lsdb.find((l) => lsaKey(l) === lsaKey(want));
    if (old && content(old) === content(want)) continue;
    const lsa: Ospf3Lsa = { ...want, sequence: (old?.sequence ?? 0) + 1, originatedAt: now };
    s.lsdb = [...s.lsdb.filter((l) => l !== old), lsa];
    changed.push(lsa);
  }
  for (const old of s.lsdb)
    if (old.advertisingRouter === s.rid && !old.flushed && !keys.has(lsaKey(old))) {
      Object.assign(old, {
        sequence: old.sequence + 1,
        originatedAt: now,
        flushed: true,
        links: [],
        prefixes: [],
      });
      changed.push(old);
    }
  if (!changed.length) return;
  s.spfDue = true;
  e.emit('OSPF_LSA', d.id, `OSPFv3: ${changed.length} LSA(s) originated by ${s.rid}.`);
  flood(e, d, s, changed);
}
/** Installs a received LSA when it is newer; returns it when it must be flooded on. */
function install(e: SimulationEngine, d: Device, s: Ospf3State, lsa: Ospf3Lsa): Ospf3Lsa | undefined {
  const key = lsaKey(lsa),
    old = s.lsdb.find((l) => lsaKey(l) === key);
  if (old && old.sequence >= lsa.sequence) return undefined;
  if (lsa.advertisingRouter === s.rid) {
    // A copy from a previous incarnation of this router: originate past it.
    const own = old ?? { ...lsa, flushed: true, links: [], prefixes: [] };
    if (!old) s.lsdb.push(own);
    own.sequence = lsa.sequence + 1;
    own.originatedAt = e.state.clock;
    return own;
  }
  if (!old && s.lsdb.length >= 4096) {
    e.drop(d, 'OSPFv3: link state database full.');
    return undefined;
  }
  const copy = { ...structuredClone(lsa), originatedAt: e.state.clock };
  s.lsdb = [...s.lsdb.filter((l) => l !== old), copy];
  s.spfDue = true;
  return copy;
}

// --- SPF ----------------------------------------------------------------------------------------
type Path = { cost: number; hops: Hop[]; area: number };
function merge(map: Map<string, Path>, key: string, path: Path) {
  const old = map.get(key);
  if (!old || path.cost < old.cost) map.set(key, { ...path, hops: [...path.hops] });
  else if (path.cost === old.cost)
    for (const h of path.hops)
      if (!old.hops.some((x) => x.port === h.port && x.address === h.address)) old.hops.push(h);
}
/** Shortest paths to every router of an area (bidirectional links only). */
function shortestPaths(d: Device, s: Ospf3State, area: number) {
  const routers = new Map<string, Ospf3Lsa>();
  for (const l of s.lsdb)
    if (l.type === 'router' && l.area === area && !l.flushed && l.advertisingRouter !== s.rid)
      routers.set(l.advertisingRouter, l);
  const listsBack = (from: string, to: string) => {
    const own = s.lsdb.find(
      (l) => l.type === 'router' && l.area === area && l.advertisingRouter === from && !l.flushed
    );
    return !!own?.links.some((x) => x.neighbor === to);
  };
  const dist = new Map<string, Path>();
  const queue = new Map<string, Path>();
  for (const c of s.interfaces) {
    if (c.area !== area || !activePort(s, c.port) || ospf3Passive(s, c.port)) continue;
    const cost = ospf3Cost(s, portOf(d, c.port)!);
    for (const n of linked(s, c))
      if (routers.has(n.routerId) && listsBack(n.routerId, s.rid!))
        merge(queue, n.routerId, { cost, hops: [{ port: n.port, address: n.address }], area });
  }
  while (queue.size) {
    const [id, path] = [...queue].sort((a, b) => a[1].cost - b[1].cost || ipNumber(a[0]) - ipNumber(b[0]))[0];
    queue.delete(id);
    dist.set(id, path);
    for (const link of routers.get(id)?.links ?? []) {
      if (link.neighbor === s.rid || dist.has(link.neighbor) || !routers.has(link.neighbor)) continue;
      if (!listsBack(link.neighbor, id)) continue;
      merge(queue, link.neighbor, { cost: path.cost + link.cost, hops: path.hops, area });
    }
  }
  return dist;
}
/** Runs SPF in every area; returns the summaries an ABR advertises into each area. */
function spf(e: SimulationEngine, d: Device, s: Ospf3State) {
  const areas = areasOf(s),
    abr = ospf3Abr(s);
  const intra = new Map<number, Map<string, Path>>();
  const inter = new Map<string, Path>();
  for (const area of areas) {
    const dist = shortestPaths(d, s, area),
      routes = new Map<string, Path>();
    intra.set(area, routes);
    for (const l of s.lsdb) {
      if (l.area !== area || l.flushed || l.advertisingRouter === s.rid) continue;
      const to = dist.get(l.advertisingRouter);
      if (!to) continue;
      if (l.type === 'prefix')
        for (const x of l.prefixes)
          merge(routes, prefixKey(x), { cost: to.cost + x.metric, hops: to.hops, area });
      // An ABR only uses the summaries of the backbone.
      if (l.type === 'inter-prefix' && (!abr || area === 0))
        for (const x of l.prefixes)
          merge(inter, prefixKey(x), { cost: to.cost + x.metric, hops: to.hops, area });
    }
  }
  const connected = new Set(
    d.interfaces.flatMap((p) =>
      usable6(p)
        .filter((a) => !linkLocal6(a.ip))
        .flatMap((a) => [prefixKey({ network: network6(a.ip, a.prefix), prefix: a.prefix }), a.ip + '/128'])
    )
  );
  const chosen = new Map<string, Path & { pathType: 'intra' | 'inter' }>();
  for (const routes of intra.values())
    for (const [key, path] of routes) {
      const old = chosen.get(key);
      if (!old || path.cost < old.cost) chosen.set(key, { ...path, pathType: 'intra' });
    }
  for (const [key, path] of inter) if (!chosen.has(key)) chosen.set(key, { ...path, pathType: 'inter' });
  const routes: Ospf3Route[] = [];
  for (const [key, path] of [...chosen].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (connected.has(key)) continue;
    const [network, prefix] = key.split('/');
    for (const hop of path.hops
      .sort((a, b) => a.port.localeCompare(b.port) || a.address.localeCompare(b.address))
      .slice(0, s.maximumPaths))
      routes.push({
        network,
        prefix: Number(prefix),
        nextHop: hop.address,
        port: hop.port,
        metric: Math.min(16777215, path.cost),
        pathType: path.pathType,
        area: path.area,
      });
  }
  if (JSON.stringify(routes) !== JSON.stringify(s.routes)) {
    s.routes = routes.slice(0, 4096);
    invalidateProtocolIndex(e.state);
    e.emit('OSPF_SPF', d.id, `OSPFv3 SPF: ${new Set(routes.map(prefixKey)).size} route(s).`);
  }
  // Summaries an ABR originates into each attached area.
  const summaries = new Map<number, Ospf3Lsa['prefixes']>();
  if (abr)
    for (const area of areas) {
      const out = new Map<string, Ospf3Lsa['prefixes'][number]>();
      const add = (key: string, metric: number) => {
        const [network, prefix] = key.split('/');
        if (intra.get(area)!.has(key) || ownPrefixes(d, s, area).some((x) => prefixKey(x) === key)) return;
        if (!out.has(key) || out.get(key)!.metric > metric)
          out.set(key, { network, prefix: Number(prefix), metric: Math.min(16777215, metric) });
      };
      for (const other of areas) {
        if (other === area) continue;
        for (const x of ownPrefixes(d, s, other)) add(prefixKey(x), x.metric);
        for (const [key, path] of intra.get(other)!) add(key, path.cost);
      }
      if (area !== 0) for (const [key, path] of inter) add(key, path.cost);
      summaries.set(
        area,
        [...out.values()].sort((a, b) => prefixKey(a).localeCompare(prefixKey(b))).slice(0, 512)
      );
    }
  return summaries;
}

// --- process ------------------------------------------------------------------------------------
function cancel(e: SimulationEngine, d: Device) {
  e.state.queue = e.state.queue.filter(
    ({ action }) => action.kind !== 'ospf3-tick' || action.device !== d.id
  );
}
/** Flushes the router's LSAs and drops its neighbors (process removed or restarted). */
function shutdown(e: SimulationEngine, d: Device, s: Ospf3State) {
  const own = s.lsdb.filter((l) => l.advertisingRouter === s.rid && !l.flushed);
  for (const l of own)
    Object.assign(l, {
      sequence: l.sequence + 1,
      originatedAt: e.state.clock,
      flushed: true,
      links: [],
      prefixes: [],
    });
  if (own.length) flood(e, d, s, own);
  for (const n of [...s.neighbors]) neighborDown(e, d, s, n, 'Interface down or detached');
}
export function configureOspf3(e: SimulationEngine, d: Device, input: unknown) {
  const config = ospf3ConfigSchema.parse(input);
  if (d.type !== 'router' && !(d.type === 'switch' && d.ipRouting))
    throw new Error('OSPFv3 requires IPv6 routing (a router or "ip routing" on the switch).');
  const known = (id: string) => d.interfaces.some((p) => p.id === id);
  if (
    !config.passive.every(known) ||
    !config.interfaces.every((i) => known(i.port)) ||
    new Set(config.interfaces.map((i) => i.port)).size !== config.interfaces.length
  )
    throw new Error('Invalid OSPFv3 interface or passive interface.');
  const old = d.ospf3;
  const restart =
    !old ||
    !old.enabled ||
    !config.enabled ||
    old.processId !== config.processId ||
    old.routerId !== config.routerId;
  if (old && restart) shutdown(e, d, old);
  cancel(e, d);
  const state: Ospf3State = {
    ...config,
    token: e.id('ospf3'),
    tickAt: e.state.clock + 0.001,
    ports: restart ? [] : old!.ports,
    neighbors: restart ? [] : old!.neighbors,
    lsdb: restart ? [] : old!.lsdb,
    routes: restart ? [] : old!.routes,
    spfDue: true,
    ...(!restart && old!.rid ? { rid: old!.rid } : {}),
  };
  // Interfaces leaving the process drop their neighbors.
  for (const n of [...state.neighbors])
    if (!config.interfaces.some((i) => i.port === n.port) || ospf3Passive(config, n.port))
      neighborDown(e, d, state, n, 'Interface down or detached');
  state.ports = state.ports.filter((r) => config.interfaces.some((i) => i.port === r.port));
  d.ospf3 = state;
  if (config.enabled) e.schedule(0.001, { kind: 'ospf3-tick', device: d.id, token: state.token });
  invalidateProtocolIndex(e.state);
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    `OSPFv3 process ${config.processId} ${config.enabled ? 'configured' : 'shut down'}.`
  );
}
export function removeOspf3(e: SimulationEngine, d: Device) {
  const s = d.ospf3;
  if (!s) return;
  if (s.enabled) shutdown(e, d, s);
  cancel(e, d);
  delete d.ospf3;
  invalidateProtocolIndex(e.state);
  e.emit('CONFIG_CHANGED', d.id, `OSPFv3 process ${s.processId} removed.`);
}
/** "clear ipv6 ospf process": the router ID is chosen again and the adjacencies restart. */
export function clearOspf3Process(e: SimulationEngine, d: Device) {
  const s = d.ospf3;
  if (!s?.enabled) return;
  shutdown(e, d, s);
  delete s.rid;
  s.ports = [];
  s.lsdb = [];
  s.routes = [];
  s.spfDue = true;
  invalidateProtocolIndex(e.state);
}
export function handleOspf3Tick(e: SimulationEngine, a: Tick) {
  const d = e.device(a.device),
    s = d.ospf3;
  if (!s?.enabled || s.token !== a.token) return;
  run(e, d, s);
  s.tickAt = e.state.clock + OSPF3.tickMs;
  e.schedule(OSPF3.tickMs, { kind: 'ospf3-tick', device: d.id, token: s.token });
}
function run(e: SimulationEngine, d: Device, s: Ospf3State) {
  const now = e.state.clock;
  if (!s.rid) {
    const rid = chooseRouterId(d);
    if (!rid) {
      if (!s.noRouterId)
        e.emit(
          'CONFIG_CHANGED',
          d.id,
          `%OSPFv3-4-NORTRID: Process OSPFv3-${s.processId}-IPv6 could not pick a router-id, please configure manually`
        );
      s.noRouterId = true;
      return;
    }
    s.rid = rid;
    delete s.noRouterId;
  }
  for (const c of s.interfaces) {
    const p = portOf(d, c.port);
    let r = s.ports.find((x) => x.port === c.port);
    if (!r) {
      r = { port: c.port, helloAt: now, upAt: now, operational: false, dr: NONE, bdr: NONE };
      s.ports.push(r);
    }
    const operational =
      !!p && d.power && p.adminUp && !!ospf3LinkLocal(p) && interfaceOperational(e.state, d, p);
    if (r.operational && !operational) {
      for (const n of s.neighbors.filter((x) => x.port === c.port))
        neighborDown(e, d, s, n, 'Interface down or detached');
      r.dr = r.bdr = NONE;
      s.spfDue = true;
    }
    if (operational && !r.operational) {
      r.upAt = r.helloAt = now;
      s.spfDue = true;
    }
    r.operational = operational;
    if (!operational) continue;
    for (const n of s.neighbors.filter((x) => x.port === c.port && x.deadAt <= now))
      neighborDown(e, d, s, n, 'Dead timer expired');
    if (ospf3Passive(s, c.port)) continue;
    if (c.networkType === 'broadcast' && !p!.loopback) elect(e, d, s, c, now);
    if (r.helloAt <= now) {
      hello(e, d, s, c);
      r.helloAt = now + c.helloMs;
    }
  }
  syncAdjacencies(e, d, s);
  // Without changes the ABR keeps advertising the summaries it already originated.
  const summaries = s.spfDue ? spf(e, d, s) : originatedSummaries(s);
  s.spfDue = false;
  originate(e, d, s, summaries);
  // Own changes (a new adjacency in the router LSA) are reflected in the next SPF run.
}
function originatedSummaries(s: Ospf3State) {
  return new Map(
    s.lsdb
      .filter((l) => l.type === 'inter-prefix' && l.advertisingRouter === s.rid && !l.flushed)
      .map((l) => [l.area, l.prefixes] as const)
  );
}
export function receiveOspf3(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  packet: Ospf3Packet,
  mac: string
) {
  const s = d.ospf3;
  const c = s?.interfaces.find((i) => i.port === p.id);
  if (!s?.enabled || !s.rid || !c || ospf3Passive(s, p.id) || !activePort(s, p.id)) return;
  if (packet.dst !== OSPF3.allRouters && packet.dst !== ospf3LinkLocal(p)) return;
  if (!linkLocal6(packet.src) || packet.routerId === s.rid) return;
  if (packet.area !== c.area) {
    e.drop(
      d,
      `OSPFv3: packet from ${packet.src.toUpperCase()} on ${p.name} is for area ${packet.area}, interface is in area ${c.area}.`,
      p.id
    );
    return;
  }
  const m = packet.message,
    now = e.state.clock;
  e.emit(
    'OSPF_RECEIVED',
    d.id,
    `OSPFv3 ${m.type === 'hello' ? 'Hello' : 'LS Update'} from ${packet.routerId} on ${p.name}.`,
    { port: p.id }
  );
  let n = s.neighbors.find((x) => x.routerId === packet.routerId && x.port === p.id);
  if (m.type === 'hello') {
    if (m.helloMs !== c.helloMs || m.deadMs !== c.deadMs) {
      e.drop(
        d,
        `OSPFv3: mismatched hello parameters from ${packet.src.toUpperCase()} on ${p.name} (hello ${m.helloMs / 1000}, dead ${m.deadMs / 1000}; configured ${c.helloMs / 1000}, ${c.deadMs / 1000}).`,
        p.id
      );
      return;
    }
    if (!n) {
      if (s.neighbors.length >= 256) {
        e.drop(d, 'OSPFv3: neighbor table full.', p.id);
        return;
      }
      n = {
        routerId: packet.routerId,
        port: p.id,
        address: packet.src,
        mac,
        priority: m.priority,
        dr: m.dr,
        bdr: m.bdr,
        interfaceId: m.interfaceId,
        state: 'INIT',
        deadAt: now + c.deadMs,
        upAt: now,
      };
      s.neighbors.push(n);
    }
    Object.assign(n, {
      address: packet.src,
      mac,
      priority: m.priority,
      dr: m.dr,
      bdr: m.bdr,
      interfaceId: m.interfaceId,
    });
    n.deadAt = now + c.deadMs;
    if (!m.neighbors.includes(s.rid)) {
      if (n.state !== 'INIT') {
        adjacency(e, d, s, n, n.state, 'INIT', 'Neighbor Down: 1-Way');
        n.state = 'INIT';
        s.spfDue = true;
      }
    } else if (n.state === 'INIT') {
      n.state = '2WAY';
      s.spfDue = true;
      syncAdjacencies(e, d, s);
    }
    return;
  }
  if (n?.state !== 'FULL') return;
  const fresh = m.lsas.map((l) => install(e, d, s, l)).filter((l): l is Ospf3Lsa => !!l);
  const own = fresh.filter((l) => l.advertisingRouter === s.rid);
  if (own.length) flood(e, d, s, own);
  const others = fresh.filter((l) => l.advertisingRouter !== s.rid);
  if (others.length) flood(e, d, s, others, n);
}
/** OSPFv3 routes offered to the IPv6 routing table ("O" intra-area, "OI" inter-area). */
export function ospf3Routes(d: Device) {
  const s = d.ospf3;
  return s?.enabled && d.power ? s.routes : [];
}
export function validateOspf3(snapshot: Snapshot) {
  for (const d of snapshot.devices) {
    const s = d.ospf3;
    if (!s) continue;
    if (!['router', 'switch'].includes(d.type))
      throw new Error('OSPFv3 requires a router or a Layer 3 switch.');
    const known = (id: string) => d.interfaces.some((p) => p.id === id);
    if (
      !s.interfaces.every((i) => known(i.port)) ||
      !s.neighbors.every((n) => known(n.port)) ||
      !s.routes.every((r) => known(r.port))
    )
      throw new Error('OSPFv3 reference to a missing interface.');
    const keys = s.lsdb.map(lsaKey);
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate OSPFv3 LSA.');
    const timers = snapshot.queue.filter(
      ({ action }) => action.kind === 'ospf3-tick' && action.device === d.id
    );
    if (
      timers.length !== Number(s.enabled) ||
      (s.enabled &&
        (timers[0].at !== s.tickAt ||
          timers[0].action.kind !== 'ospf3-tick' ||
          timers[0].action.token !== s.token))
    )
      throw new Error('Inconsistent OSPFv3 timer.');
  }
  for (const { action } of snapshot.queue)
    if (
      action.kind === 'ospf3-tick' &&
      !snapshot.devices.some((d) => d.id === action.device && d.ospf3?.enabled)
    )
      throw new Error('OSPFv3 timer without a process.');
}
