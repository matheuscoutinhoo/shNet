import type { SimulationEngine } from '../core/engine';
import { invalidateProtocolIndex } from '../core/protocol-index';
import { LIMITS, type Action, type Device, type NetworkInterface, type Snapshot } from '../model';
import { interfaceOperational } from './layer3';
import { ipNumber, resolveRoute, sameSubnet, staticRouteInstalled, subnet } from './ipv4';
import type { DynamicRoute } from './ospf-model';
import { keyChainKeys } from './key-chain';
import { hmacHex } from './security-crypto';
import { longInterfaceName } from './interface-name';
import { ripRoutes } from './rip';
import { eigrpPayloadBytes } from '../wire/eigrp-codec';
import {
  EIGRP,
  eigrpConfigSchema,
  type EigrpConfig,
  type EigrpExternal,
  type EigrpMessage,
  type EigrpNeighbor,
  type EigrpPacket,
  type EigrpRouteTlv,
  type EigrpState,
  type EigrpTopologyEntry,
  type EigrpVector,
} from './eigrp-model';

/**
 * EIGRP for IPv4 with DUAL (RFC 7868): neighbors from Hellos, reliable Update/Query/Reply with
 * acknowledgements and retransmission, the feasibility condition for loop-free successors,
 * diffusing computations (active routes) when no feasible successor remains, split horizon,
 * stub routing, summarization with a Null0 route and redistribution as external routes.
 */
const INF = EIGRP.infinity;
type Tick = Extract<Action, { kind: 'eigrp-tick' }>;
const keyOf = (network: string, prefix: number) => network + '/' + prefix;
const entryKey = (e: { network: string; prefix: number }) => keyOf(e.network, e.prefix);
const portOf = (d: Device, id: string) => d.interfaces.find((p) => p.id === id);

// --- metric -----------------------------------------------------------------------------------
export function eigrpBandwidth(p: NetworkInterface) {
  return (
    p.bandwidthKbps ?? (p.loopback ? 8_000_000 : p.iosTunnel || p.tunnel ? 100 : Math.max(1, p.speed * 1000))
  );
}
/** Interface delay in tens of microseconds ("delay" command units). */
export function eigrpDelay(p: NetworkInterface) {
  if (p.delayTens !== undefined) return p.delayTens;
  if (p.loopback) return 500;
  if (p.iosTunnel || p.tunnel) return 5000;
  return p.speed >= 1000 ? 1 : p.speed >= 100 ? 10 : 100;
}
function linkVector(p: NetworkInterface): EigrpVector {
  return {
    bandwidth: eigrpBandwidth(p),
    delay: eigrpDelay(p),
    reliability: 255,
    load: 1,
    mtu: p.mtu,
    hops: 0,
  };
}
/** Classic composite metric: 256 x (K1 x BW + K2 x BW/(256-load) + K3 x delay) [x K5/(rel+K4)]. */
export function eigrpMetric(v: EigrpVector, k: number[] = [1, 0, 1, 0, 0]) {
  if (v.delay >= INF) return INF;
  const bw = Math.floor(10_000_000 / v.bandwidth);
  let m = k[0] * bw + Math.floor((k[1] * bw) / (256 - Math.min(255, v.load))) + k[2] * v.delay;
  if (k[4]) m = Math.floor((m * k[4]) / (v.reliability + k[3]));
  return Math.min(INF - 1, m * 256);
}
function extend(v: EigrpVector, p: NetworkInterface): EigrpVector {
  if (v.delay >= INF) return v;
  const link = linkVector(p);
  return {
    bandwidth: Math.min(v.bandwidth, link.bandwidth),
    delay: Math.min(INF - 1, v.delay + link.delay),
    reliability: Math.min(v.reliability, link.reliability),
    load: Math.max(v.load, link.load),
    mtu: Math.min(v.mtu, link.mtu),
    hops: Math.min(255, v.hops + 1),
  };
}

// --- configuration ----------------------------------------------------------------------------
const classful = (ip: string) => {
  const first = Number(ip.split('.')[0]);
  return first < 128 ? 8 : first < 192 ? 16 : 24;
};
export function eigrpCovers(s: Pick<EigrpConfig, 'networks'>, ip: string) {
  return s.networks.some((n) => {
    if (!n.wildcard) return sameSubnet(ip, n.network, classful(n.network));
    const keep = ~ipNumber(n.wildcard) >>> 0;
    return (ipNumber(ip) & keep) >>> 0 === (ipNumber(n.network) & keep) >>> 0;
  });
}
/** Interfaces "network" statements enable (global table, with an IPv4 address). */
export function eigrpPorts(d: Device) {
  const s = d.eigrp;
  return s?.enabled
    ? d.interfaces.filter((p) => !p.vrf && p.ip && p.prefix !== undefined && eigrpCovers(s, p.ip))
    : [];
}
export const eigrpPassive = (s: Pick<EigrpConfig, 'passiveDefault' | 'passive'>, port: string) =>
  s.passiveDefault ? !s.passive.includes(port) : s.passive.includes(port);
export const eigrpInterface = (s: Pick<EigrpConfig, 'interfaces'>, port: string) =>
  s.interfaces.find((i) => i.port === port);
export const eigrpHelloMs = (s: EigrpConfig, port: string) =>
  eigrpInterface(s, port)?.helloMs ?? EIGRP.helloMs;
export const eigrpHoldMs = (s: EigrpConfig, port: string) => eigrpInterface(s, port)?.holdMs ?? EIGRP.holdMs;
/** Key chain used to authenticate the packets of an interface (mode md5 and a key chain). */
export function eigrpKeyChain(s: Pick<EigrpConfig, 'interfaces'>, port: string) {
  const i = eigrpInterface(s, port);
  return i?.authenticationMode === 'md5' && i.keyChain ? i.keyChain : undefined;
}
export function eigrpRouterId(d: Device) {
  if (d.eigrp?.routerId) return d.eigrp.routerId;
  const addressed = d.interfaces.filter((p) => p.ip && !p.vrf);
  const loopbacks = addressed.filter((p) => p.loopback);
  return (
    (loopbacks.length ? loopbacks : addressed)
      .map((p) => p.ip!)
      .sort((a, b) => ipNumber(b) - ipNumber(a))[0] ?? '0.0.0.0'
  );
}
const distances = (s: EigrpConfig) =>
  s.distance ?? { internal: EIGRP.internalDistance, external: EIGRP.externalDistance };

// --- topology and routing table ---------------------------------------------------------------
type Scored = {
  via: EigrpTopologyEntry['via'][number];
  port: NetworkInterface;
  distance: number;
  reported: number;
};
function scored(d: Device, s: EigrpState, entry: EigrpTopologyEntry): Scored[] {
  return entry.via.flatMap((via) => {
    const port = portOf(d, via.port);
    if (!port) return [];
    const distance = eigrpMetric(extend(via.reported, port), s.k);
    return distance < INF ? [{ via, port, distance, reported: eigrpMetric(via.reported, s.k) }] : [];
  });
}
/** Successors and feasible successors in use: they satisfy the feasibility condition (RD < FD). */
function paths(d: Device, s: EigrpState, entry: EigrpTopologyEntry) {
  const feasible = scored(d, s, entry).filter((x) => x.reported < entry.fd);
  if (!feasible.length) return [];
  const best = Math.min(...feasible.map((x) => x.distance));
  return feasible
    .filter((x) => x.distance === best || (s.variance > 1 && x.distance <= best * s.variance))
    .sort((a, b) => a.distance - b.distance || ipNumber(a.via.address) - ipNumber(b.via.address))
    .slice(0, s.maximumPaths);
}
/** EIGRP routes offered to the routing table ("D" internal, "D EX" external). */
export function eigrpRoutes(d: Device): DynamicRoute[] {
  const s = d.eigrp;
  if (!s?.enabled || !d.power) return [];
  const ad = distances(s);
  return s.topology.flatMap((entry) =>
    entry.local
      ? []
      : paths(d, s, entry).map((x) => ({
          network: entry.network,
          prefix: entry.prefix,
          nextHop: x.via.address,
          port: x.via.port,
          metric: x.distance,
          protocol: 'EIGRP' as const,
          distance: x.via.external ? ad.external : ad.internal,
        }))
  );
}
/** Summaries with at least one component: IOS installs them to Null0 with distance 5. */
export function eigrpSummaryRoutes(d: Device) {
  const s = d.eigrp;
  if (!s?.enabled || !d.power) return [];
  return s.topology
    .filter((e) => e.local?.kind === 'summary')
    .map((e) => ({ network: e.network, prefix: e.prefix }));
}
/** The vector this router uses for a destination (its own distance), if reachable. */
function ownVector(d: Device, s: EigrpState, entry: EigrpTopologyEntry | undefined) {
  if (!entry) return undefined;
  if (entry.local) return { vector: entry.local.vector, external: entry.local.external };
  const best = paths(d, s, entry)[0];
  return best ? { vector: extend(best.via.reported, best.port), external: best.via.external } : undefined;
}
const ownDistance = (d: Device, s: EigrpState, entry: EigrpTopologyEntry | undefined) => {
  const own = ownVector(d, s, entry);
  return own ? eigrpMetric(own.vector, s.k) : INF;
};
const unreachable: EigrpVector = { bandwidth: 1, delay: INF, reliability: 0, load: 0, mtu: 0, hops: 0 };

// --- outgoing packets -------------------------------------------------------------------------
interface Outbox {
  updates: Set<string>;
  queries: Map<string, Set<string>>;
  replies: Map<string, Set<string>>;
}
const outbox = (): Outbox => ({ updates: new Set(), queries: new Map(), replies: new Map() });
const add = (map: Map<string, Set<string>>, neighbor: string, key: string) =>
  map.set(neighbor, (map.get(neighbor) ?? new Set()).add(key));
export function eigrpDigest(packet: EigrpPacket, key: string) {
  const { authentication: _a, ...body } = packet;
  return hmacHex(key, JSON.stringify(body)).slice(0, 32);
}
function transmit(
  e: SimulationEngine,
  d: Device,
  port: NetworkInterface,
  message: EigrpMessage,
  sequence: number,
  ack: number,
  neighbor?: EigrpNeighbor
) {
  const s = d.eigrp!;
  if (!d.power || !port.adminUp || !port.ip) return;
  const keyChain = eigrpKeyChain(s, port.id);
  const packet: EigrpPacket = {
    protocol: 'EIGRP',
    src: port.ip,
    dst: neighbor?.address ?? EIGRP.destination,
    ttl: 2,
    asn: s.asn,
    sequence,
    ack,
    message,
    bytes: 20 + eigrpPayloadBytes(message, !!keyChain),
  };
  if (keyChain) {
    const key = keyChainKeys(d, keyChain, 'send', e.state.clock)[0];
    if (!key?.keyString) {
      e.drop(d, `EIGRP: no valid key in key chain ${keyChain} for ${port.name}.`, port.id);
      return;
    }
    packet.authentication = { keyId: key.id, digest: '0'.repeat(32) };
    packet.authentication.digest = eigrpDigest(packet, key.keyString);
  }
  const frame = {
    src: port.mac,
    dst: neighbor?.mac ?? EIGRP.mac,
    etherType: 'IPv4' as const,
    packet,
    hops: LIMITS.l2Hops,
  };
  const counter = (message.opcode + 'Sent') as keyof EigrpState['counters'];
  s.counters[counter] = (s.counters[counter] + 1) >>> 0;
  e.emit(
    'EIGRP_SENT',
    d.id,
    `EIGRP ${message.opcode.toUpperCase()} AS ${s.asn} on ${port.name}` +
      (neighbor ? ` to ${neighbor.address}` : ' to 224.0.0.10') +
      ('routes' in message ? `, ${message.routes.length} route(s)` : '') +
      (sequence ? `, seq ${sequence}` : '') +
      (ack ? `, ack ${ack}` : '') +
      '.',
    { port: port.id, frame }
  );
  e.sendFrame(d.id, port.id, frame);
}
/** Update, Query and Reply are reliable: each neighbor acknowledges them or they are retransmitted. */
function sendReliable(
  e: SimulationEngine,
  d: Device,
  port: NetworkInterface,
  message: EigrpMessage,
  neighbors: EigrpNeighbor[],
  unicast: boolean
) {
  const s = d.eigrp!;
  if (!neighbors.length) return;
  s.sequence = (s.sequence + 1) >>> 0 || 1;
  for (const n of neighbors) {
    if (n.pending.length >= 64) n.pending.shift();
    n.pending.push({ sequence: s.sequence, message, sentAt: e.state.clock, retries: 0 });
  }
  if (unicast) for (const n of neighbors) transmit(e, d, port, message, s.sequence, 0, n);
  else transmit(e, d, port, message, s.sequence, 0);
}
/** What this router tells the neighbors on one interface about a destination (undefined: nothing). */
function advertise(d: Device, s: EigrpState, key: string, port: NetworkInterface): EigrpRouteTlv | undefined {
  const [network, length] = key.split('/'),
    prefix = Number(length);
  const entry = s.topology.find((t) => entryKey(t) === key);
  const tlv = (vector: EigrpVector, external?: EigrpExternal): EigrpRouteTlv => ({
    network,
    prefix,
    nextHop: '0.0.0.0',
    vector,
    ...(external ? { external } : {}),
  });
  if (s.stub) {
    const local = entry?.local;
    const allowed =
      !s.stub.receiveOnly &&
      !!local &&
      ((local.kind === 'connected' && s.stub.connected) ||
        (local.kind === 'summary' && s.stub.summary) ||
        (local.kind === 'redistributed' &&
          (s.stub.redistributed || (s.stub.static && local.external?.protocol === 'static'))));
    if (!allowed) return entry ? undefined : tlv(unreachable);
  }
  if (entry?.local?.kind === 'summary' && entry.local.port !== port.id) return undefined;
  // Components of a summary configured on this interface are suppressed there.
  const summaries = eigrpInterface(s, port.id)?.summaries ?? [];
  if (
    summaries.some(
      (sum) =>
        sum.prefix < prefix &&
        sameSubnet(network, sum.network, sum.prefix) &&
        s.topology.some(
          (t) => t.local?.kind === 'summary' && t.network === sum.network && t.prefix === sum.prefix
        )
    )
  )
    return tlv(unreachable);
  const own = ownVector(d, s, entry);
  if (!entry || !own) return tlv(unreachable);
  // Split horizon with poison reverse: a route is not advertised back out its successor's interface.
  if (
    !entry.local &&
    eigrpInterface(s, port.id)?.splitHorizon !== false &&
    paths(d, s, entry).some((x) => x.via.port === port.id)
  )
    return tlv(unreachable);
  return tlv(own.vector, own.external);
}
/** Route TLVs split into packets that fit the interface MTU (EIGRP never fragments). */
function packets(s: EigrpState, port: NetworkInterface, routes: EigrpRouteTlv[]) {
  const auth = !!eigrpKeyChain(s, port.id),
    result: EigrpRouteTlv[][] = [];
  let current: EigrpRouteTlv[] = [];
  for (const route of routes) {
    const next = [...current, route];
    if (current.length && 20 + eigrpPayloadBytes({ opcode: 'update', routes: next }, auth) > port.mtu) {
      result.push(current);
      current = [route];
    } else current = next;
  }
  if (current.length) result.push(current);
  return result;
}
function flush(e: SimulationEngine, d: Device, s: EigrpState, out: Outbox) {
  const ports = eigrpPorts(d);
  if (out.updates.size)
    for (const port of ports) {
      const neighbors = s.neighbors.filter((n) => n.port === port.id);
      if (!neighbors.length || eigrpPassive(s, port.id)) continue;
      const routes = [...out.updates].flatMap((key) => advertise(d, s, key, port) ?? []);
      for (const chunk of packets(s, port, routes))
        sendReliable(e, d, port, { opcode: 'update', routes: chunk }, neighbors, false);
    }
  for (const [kind, map] of [
    ['query', out.queries],
    ['reply', out.replies],
  ] as const)
    for (const [address, keys] of map) {
      const n = s.neighbors.find((x) => x.address === address);
      const port = n && portOf(d, n.port);
      if (!n || !port) continue;
      const routes = [...keys].map((key) => {
        const [network, length] = key.split('/');
        return (
          advertise(d, s, key, port) ?? {
            network,
            prefix: Number(length),
            nextHop: '0.0.0.0',
            vector: unreachable,
          }
        );
      });
      for (const chunk of packets(s, port, routes))
        sendReliable(e, d, port, { opcode: kind, routes: chunk }, [n], true);
    }
}
function sendTable(e: SimulationEngine, d: Device, s: EigrpState, n: EigrpNeighbor) {
  const port = portOf(d, n.port);
  if (!port) return;
  const routes = s.topology.flatMap((t) => {
    const tlv = advertise(d, s, entryKey(t), port);
    return tlv && tlv.vector.delay < INF ? [tlv] : [];
  });
  const chunks = packets(s, port, routes);
  // The first update carries the INIT flag, even when the table is empty.
  for (const [i, chunk] of (chunks.length ? chunks : [[]]).entries())
    sendReliable(e, d, port, { opcode: 'update', init: i === 0, routes: chunk }, [n], true);
}

// --- DUAL ---------------------------------------------------------------------------------------
function routeEvent(
  e: SimulationEngine,
  d: Device,
  s: EigrpState,
  entry: EigrpTopologyEntry,
  before: number
) {
  const after = ownDistance(d, s, entry);
  if (entry.local || before === after) return;
  const best = paths(d, s, entry)[0];
  e.emit(
    after === INF ? 'ROUTE_REMOVED' : 'ROUTE_ADDED',
    d.id,
    after === INF
      ? `EIGRP ${entryKey(entry)} unreachable.`
      : `EIGRP ${entryKey(entry)} via ${best?.via.address}, metric ${after}.`
  );
}
function remove(s: EigrpState, entry: EigrpTopologyEntry) {
  s.topology = s.topology.filter((t) => t !== entry);
}
function changed(d: Device, s: EigrpState, entry: EigrpTopologyEntry, out: Outbox) {
  const distance = ownDistance(d, s, entry);
  if (entry.advertised !== distance) {
    entry.advertised = distance;
    out.updates.add(entryKey(entry));
  }
}
function goPassive(e: SimulationEngine, d: Device, s: EigrpState, entry: EigrpTopologyEntry, out: Outbox) {
  const before = ownDistance(d, s, entry);
  entry.state = 'passive';
  entry.replies = [];
  delete entry.activeAt;
  const all = scored(d, s, entry);
  // Leaving the active state resets the feasible distance to the best distance now known.
  entry.fd = entry.local
    ? eigrpMetric(entry.local.vector, s.k)
    : all.length
      ? Math.min(...all.map((x) => x.distance))
      : INF;
  entry.changedAt = e.state.clock;
  if (entry.origin) {
    add(out.replies, entry.origin, entryKey(entry));
    delete entry.origin;
  }
  routeEvent(e, d, s, entry, before);
  changed(d, s, entry, out);
  if (entry.fd === INF && !entry.local) remove(s, entry);
}
/** DUAL input event for one destination; "from" asked a query that needs a reply. */
function evaluate(
  e: SimulationEngine,
  d: Device,
  s: EigrpState,
  entry: EigrpTopologyEntry,
  out: Outbox,
  from?: string,
  before = ownDistance(d, s, entry)
) {
  if (entry.state === 'active') {
    if (from) add(out.replies, from, entryKey(entry));
    return;
  }
  if (entry.local) {
    entry.fd = eigrpMetric(entry.local.vector, s.k);
    if (from) add(out.replies, from, entryKey(entry));
    changed(d, s, entry, out);
    return;
  }
  const all = scored(d, s, entry);
  const feasible = all.filter((x) => x.reported < entry.fd);
  if (feasible.length) {
    // Local computation: a feasible successor exists, the route stays passive.
    const best = Math.min(...feasible.map((x) => x.distance));
    if (best < entry.fd) entry.fd = best;
    entry.changedAt = e.state.clock;
    if (from) add(out.replies, from, entryKey(entry));
    routeEvent(e, d, s, entry, before);
    changed(d, s, entry, out);
    return;
  }
  // No feasible successor: a diffusing computation asks every neighbor except stubs.
  const recipients = s.neighbors.filter((n) => n.address !== from && !n.stub);
  if (!recipients.length) {
    entry.origin = from;
    goPassive(e, d, s, entry, out);
    return;
  }
  entry.state = 'active';
  entry.activeAt = e.state.clock;
  entry.replies = recipients.map((n) => n.address);
  if (from) entry.origin = from;
  else delete entry.origin;
  for (const n of recipients) add(out.queries, n.address, entryKey(entry));
  routeEvent(e, d, s, entry, before);
}
function input(
  e: SimulationEngine,
  d: Device,
  s: EigrpState,
  n: EigrpNeighbor,
  r: EigrpRouteTlv,
  opcode: 'update' | 'query' | 'reply',
  out: Outbox
) {
  const key = keyOf(r.network, r.prefix);
  let entry = s.topology.find((t) => entryKey(t) === key);
  // An external route this router originated has looped back.
  const own = r.external?.routerId === eigrpRouterId(d);
  const infinite = own || r.vector.delay >= INF;
  if (!entry) {
    if (opcode === 'query') add(out.replies, n.address, key);
    if (infinite || opcode !== 'update') return;
    if (s.topology.length >= 4096) {
      e.drop(d, 'EIGRP: topology table full.', n.port);
      return;
    }
    entry = {
      network: r.network,
      prefix: r.prefix,
      fd: INF,
      state: 'passive',
      via: [],
      replies: [],
      changedAt: e.state.clock,
    };
    s.topology.push(entry);
  }
  const before = ownDistance(d, s, entry);
  entry.via = entry.via.filter((v) => v.address !== n.address);
  if (!infinite)
    entry.via.push({
      address: n.address,
      port: n.port,
      reported: r.vector,
      ...(r.external ? { external: r.external } : {}),
    });
  if (opcode === 'reply') {
    if (entry.state === 'active') {
      entry.replies = entry.replies.filter((a) => a !== n.address);
      if (!entry.replies.length) goPassive(e, d, s, entry, out);
    } else evaluate(e, d, s, entry, out, undefined, before);
    return;
  }
  if (entry.state === 'active') {
    // While active, updates only refresh the topology table; a query gets the current answer.
    if (opcode === 'query') add(out.replies, n.address, key);
    return;
  }
  evaluate(e, d, s, entry, out, opcode === 'query' ? n.address : undefined, before);
}
function neighborDown(
  e: SimulationEngine,
  d: Device,
  s: EigrpState,
  n: EigrpNeighbor,
  reason: string,
  out: Outbox
) {
  if (!s.neighbors.includes(n)) return;
  s.neighbors = s.neighbors.filter((x) => x !== n);
  const port = portOf(d, n.port);
  e.emit(
    'EIGRP_NEIGHBOR_CHANGED',
    d.id,
    `%DUAL-5-NBRCHANGE: EIGRP-IPv4 ${s.asn}: Neighbor ${n.address} (${longInterfaceName(port?.name ?? n.port)}) is down: ${reason}`,
    { port: n.port }
  );
  for (const entry of [...s.topology]) {
    const before = ownDistance(d, s, entry);
    const had = entry.via.some((v) => v.address === n.address);
    entry.via = entry.via.filter((v) => v.address !== n.address);
    if (entry.origin === n.address) delete entry.origin;
    if (entry.state === 'active') {
      if (entry.replies.includes(n.address)) {
        entry.replies = entry.replies.filter((a) => a !== n.address);
        if (!entry.replies.length) goPassive(e, d, s, entry, out);
      }
    } else if (had) evaluate(e, d, s, entry, out, undefined, before);
  }
}

// --- locally originated routes ----------------------------------------------------------------
type Local = NonNullable<EigrpTopologyEntry['local']>;
function redistributed(e: SimulationEngine, d: Device, s: EigrpState) {
  const result = new Map<string, Local>();
  const routerId = eigrpRouterId(d);
  for (const r of s.redistribute) {
    const metric = r.metric ?? s.defaultMetric;
    const routes: { network: string; prefix: number; port?: NetworkInterface; discard?: boolean }[] =
      r.source === 'connected'
        ? d.interfaces
            .filter((p) => !p.vrf && p.ip && p.prefix !== undefined && interfaceOperational(e.state, d, p))
            .map((p) => ({ network: subnet(p.ip!, p.prefix!).network, prefix: p.prefix!, port: p }))
        : r.source === 'static'
          ? d.routes
              .filter((route) => !route.vrf && staticRouteInstalled({ ...d, eigrp: undefined }, route))
              .map((route) => ({
                network: route.network,
                prefix: route.prefix,
                discard: !!route.discard,
                port: route.port
                  ? portOf(d, route.port)
                  : route.discard
                    ? undefined
                    : resolveRoute({ ...d, eigrp: undefined }, route.nextHop, undefined, e.state)?.port,
              }))
          : (r.source === 'ospf'
              ? d.ospf?.enabled && (r.process === undefined || (d.ospf.processId ?? 1) === r.process)
                ? d.ospf.routes
                : []
              : r.source === 'bgp'
                ? d.bgp?.enabled && (r.process === undefined || d.bgp.asn === r.process)
                  ? d.bgp.routes
                  : []
                : ripRoutes(d)
            ).map((route) => ({ network: route.network, prefix: route.prefix }));
    for (const route of routes) {
      const key = keyOf(route.network, route.prefix);
      if (result.has(key)) continue;
      // Static and connected routes take the metric of their interface; other sources need one.
      const vector: EigrpVector | undefined = metric
        ? {
            bandwidth: metric.bandwidth,
            delay: Math.min(INF - 1, metric.delay),
            reliability: metric.reliability,
            load: metric.load,
            mtu: metric.mtu,
            hops: 0,
          }
        : route.port && (r.source === 'static' || r.source === 'connected')
          ? linkVector(route.port)
          : route.discard
            ? // Null0: the metric of the null interface (8 Gbit/s, no delay).
              { bandwidth: 8_000_000, delay: 0, reliability: 255, load: 1, mtu: 1500, hops: 0 }
            : undefined;
      if (!vector) continue;
      result.set(key, {
        kind: 'redistributed',
        vector,
        external: {
          routerId,
          asn: r.process ?? 0,
          protocol: r.source,
          metric: 0,
          tag: 0,
        },
      });
    }
  }
  return result;
}
function syncLocal(e: SimulationEngine, d: Device, s: EigrpState, out: Outbox) {
  const wanted = new Map<string, Local>();
  for (const p of eigrpPorts(d))
    if (interfaceOperational(e.state, d, p))
      wanted.set(keyOf(subnet(p.ip!, p.prefix!).network, p.prefix!), {
        kind: 'connected',
        port: p.id,
        vector: linkVector(p),
      });
  for (const [key, local] of redistributed(e, d, s)) if (!wanted.has(key)) wanted.set(key, local);
  const apply = (key: string, local: Local | undefined) => {
    let entry = s.topology.find((t) => entryKey(t) === key);
    if (JSON.stringify(entry?.local) === JSON.stringify(local)) return;
    if (!entry) {
      if (!local) return;
      const [network, prefix] = key.split('/');
      entry = {
        network,
        prefix: Number(prefix),
        fd: INF,
        state: 'passive',
        via: [],
        replies: [],
        changedAt: e.state.clock,
      };
      s.topology.push(entry);
    }
    const before = ownDistance(d, s, entry);
    if (local) entry.local = local;
    else {
      delete entry.local;
      // The route is now only as good as what the neighbors report.
      entry.fd = INF;
    }
    if (entry.state === 'active') {
      entry.state = 'passive';
      entry.replies = [];
    }
    evaluate(e, d, s, entry, out, undefined, before);
    if (!entry.local && !entry.via.length && entry.state === 'passive') {
      changed(d, s, entry, out);
      remove(s, entry);
    }
  };
  for (const entry of [...s.topology])
    if (entry.local && entry.local.kind !== 'summary' && !wanted.has(entryKey(entry)))
      apply(entryKey(entry), undefined);
  for (const [key, local] of wanted) apply(key, local);
  // Summaries exist while at least one more specific route is reachable.
  const summaries = new Map<string, Local>();
  for (const port of eigrpPorts(d))
    for (const sum of eigrpInterface(s, port.id)?.summaries ?? []) {
      const key = keyOf(sum.network, sum.prefix);
      const components = s.topology.filter(
        (t) =>
          t.local?.kind !== 'summary' &&
          t.prefix > sum.prefix &&
          sameSubnet(t.network, sum.network, sum.prefix) &&
          ownDistance(d, s, t) < INF
      );
      if (!components.length) continue;
      const best = components
        .map((t) => ownVector(d, s, t)!.vector)
        .sort((a, b) => eigrpMetric(a, s.k) - eigrpMetric(b, s.k))[0];
      summaries.set(key, { kind: 'summary', port: port.id, vector: best });
    }
  for (const entry of [...s.topology])
    if (entry.local?.kind === 'summary' && !summaries.has(entryKey(entry))) apply(entryKey(entry), undefined);
  for (const [key, local] of summaries) apply(key, local);
}

// --- configuration API --------------------------------------------------------------------------
const zeroCounters = (): EigrpState['counters'] => ({
  helloSent: 0,
  helloReceived: 0,
  updateSent: 0,
  updateReceived: 0,
  querySent: 0,
  queryReceived: 0,
  replySent: 0,
  replyReceived: 0,
  ackSent: 0,
  ackReceived: 0,
});
/** EIGRP configuration without runtime state (what "router eigrp" holds). */
export function eigrpConfig(d: Device): EigrpConfig | undefined {
  const s = d.eigrp;
  if (!s) return undefined;
  return eigrpConfigSchema.parse(
    Object.fromEntries(Object.entries(s).filter(([key]) => key in eigrpConfigSchema.shape))
  );
}
/** IOS "Goodbye": a Hello with every K value 255 tells the neighbors to drop the adjacency. */
function goodbye(e: SimulationEngine, d: Device) {
  const s = d.eigrp;
  if (!s?.enabled) return;
  for (const port of eigrpPorts(d))
    if (!eigrpPassive(s, port.id) && s.neighbors.some((n) => n.port === port.id))
      transmit(
        e,
        d,
        port,
        { opcode: 'hello', holdTime: eigrpHoldMs(s, port.id) / 1000, k: [255, 255, 255, 255, 255] },
        0,
        0
      );
}
export function configureEigrp(e: SimulationEngine, d: Device, input: unknown) {
  const config = eigrpConfigSchema.parse(input);
  if (d.type !== 'router' && !(d.type === 'switch' && d.ipRouting))
    throw new Error('EIGRP requires IP routing (a router or "ip routing" on the switch).');
  const known = (id: string) => d.interfaces.some((p) => p.id === id);
  if (
    !config.passive.every(known) ||
    config.interfaces.some(
      (i) =>
        !known(i.port) || i.summaries.some((sum) => subnet(sum.network, sum.prefix).network !== sum.network)
    ) ||
    new Set(config.interfaces.map((i) => i.port)).size !== config.interfaces.length
  )
    throw new Error('Invalid EIGRP interface, passive interface or summary.');
  const old = d.eigrp;
  // The neighbors restart when the process, its metric weights, router ID or stub role change.
  const restart =
    !old ||
    !old.enabled ||
    !config.enabled ||
    old.asn !== config.asn ||
    old.k.join() !== config.k.join() ||
    old.routerId !== config.routerId ||
    JSON.stringify(old.stub) !== JSON.stringify(config.stub);
  if (old && restart) {
    goodbye(e, d);
    for (const n of old.neighbors)
      e.emit(
        'EIGRP_NEIGHBOR_CHANGED',
        d.id,
        `%DUAL-5-NBRCHANGE: EIGRP-IPv4 ${old.asn}: Neighbor ${n.address} (${longInterfaceName(portOf(d, n.port)?.name ?? n.port)}) is down: ${config.enabled && old.asn === config.asn ? 'route configuration changed' : 'interface down'}`,
        { port: n.port }
      );
  }
  e.state.queue = e.state.queue.filter(
    ({ action }) => action.kind !== 'eigrp-tick' || action.device !== d.id
  );
  d.eigrp = {
    ...config,
    token: e.id('eigrp'),
    tickAt: e.state.clock + 0.001,
    sequence: old?.sequence ?? 0,
    ports: restart ? [] : old!.ports,
    neighbors: restart ? [] : old!.neighbors,
    topology: restart ? [] : old!.topology,
    counters: old?.counters ?? zeroCounters(),
  };
  if (config.enabled) e.schedule(0.001, { kind: 'eigrp-tick', device: d.id, token: d.eigrp.token });
  invalidateProtocolIndex(e.state);
  e.emit('CONFIG_CHANGED', d.id, `EIGRP AS ${config.asn} ${config.enabled ? 'configured' : 'shut down'}.`);
}
export function removeEigrp(e: SimulationEngine, d: Device) {
  const s = d.eigrp;
  if (!s) return;
  goodbye(e, d);
  for (const n of s.neighbors)
    e.emit(
      'EIGRP_NEIGHBOR_CHANGED',
      d.id,
      `%DUAL-5-NBRCHANGE: EIGRP-IPv4 ${s.asn}: Neighbor ${n.address} (${longInterfaceName(portOf(d, n.port)?.name ?? n.port)}) is down: interface down`,
      { port: n.port }
    );
  e.state.queue = e.state.queue.filter(
    ({ action }) => action.kind !== 'eigrp-tick' || action.device !== d.id
  );
  delete d.eigrp;
  invalidateProtocolIndex(e.state);
  e.emit('CONFIG_CHANGED', d.id, `EIGRP AS ${s.asn} removed.`);
}
/** "clear ip eigrp neighbors [address | interface]": the adjacencies restart. */
export function clearEigrpNeighbors(e: SimulationEngine, d: Device, match: (n: EigrpNeighbor) => boolean) {
  const s = d.eigrp;
  if (!s?.enabled) return 0;
  const out = outbox(),
    selected = s.neighbors.filter(match);
  for (const n of selected) neighborDown(e, d, s, n, 'manually cleared', out);
  flush(e, d, s, out);
  return selected.length;
}

// --- timers and reception -----------------------------------------------------------------------
function sendHello(e: SimulationEngine, d: Device, s: EigrpState, port: NetworkInterface) {
  transmit(
    e,
    d,
    port,
    {
      opcode: 'hello',
      holdTime: Math.round(eigrpHoldMs(s, port.id) / 1000),
      k: [...s.k],
      ...(s.stub ? { stub: { ...s.stub } } : {}),
    },
    0,
    0
  );
}
export function handleEigrpTick(e: SimulationEngine, a: Tick) {
  const d = e.device(a.device),
    s = d.eigrp;
  if (!s?.enabled || s.token !== a.token) return;
  const out = outbox(),
    now = e.state.clock,
    ports = eigrpPorts(d);
  for (const n of [...s.neighbors])
    if (!ports.some((p) => p.id === n.port)) neighborDown(e, d, s, n, 'interface down', out);
  for (const p of ports) {
    let runtime = s.ports.find((r) => r.port === p.id);
    if (!runtime) {
      runtime = { port: p.id, helloAt: now, operational: false, signature: '' };
      s.ports.push(runtime);
    }
    const operational = d.power && interfaceOperational(e.state, d, p);
    const passive = eigrpPassive(s, p.id);
    // Addressing or passive changes restart the adjacencies; bandwidth or delay only change metrics.
    const signature =
      [p.ip, p.prefix, passive].join('/') + '|' + [eigrpBandwidth(p), eigrpDelay(p)].join('/');
    const [address, metric] = runtime.signature.split('|');
    if ((runtime.operational && !operational) || (runtime.signature && address !== signature.split('|')[0]))
      for (const n of s.neighbors.filter((x) => x.port === p.id))
        neighborDown(e, d, s, n, operational ? 'interface parameters changed' : 'interface down', out);
    else if (runtime.signature && metric !== signature.split('|')[1])
      for (const entry of [...s.topology])
        if (entry.via.some((v) => v.port === p.id)) evaluate(e, d, s, entry, out);
    if (operational && !runtime.operational) runtime.helloAt = now;
    runtime.operational = operational;
    runtime.signature = signature;
    if (operational && !passive && runtime.helloAt <= now) {
      sendHello(e, d, s, p);
      runtime.helloAt = now + eigrpHelloMs(s, p.id);
    }
  }
  s.ports = s.ports.filter((r) => ports.some((p) => p.id === r.port));
  for (const n of [...s.neighbors])
    if (n.expiresAt <= now) neighborDown(e, d, s, n, 'holding time expired', out);
  for (const n of [...s.neighbors]) {
    const port = portOf(d, n.port);
    for (const p of n.pending) {
      if (now - p.sentAt < EIGRP.rtoMs || !port) continue;
      if (p.retries >= EIGRP.retries) {
        neighborDown(e, d, s, n, 'retry limit exceeded', out);
        break;
      }
      p.retries++;
      p.sentAt = now;
      transmit(e, d, port, p.message, p.sequence, 0, n);
    }
  }
  // Stuck in active: the neighbors that never replied are reset.
  for (const entry of s.topology)
    if (entry.state === 'active' && entry.activeAt !== undefined && now - entry.activeAt >= EIGRP.activeMs)
      for (const address of [...entry.replies]) {
        const n = s.neighbors.find((x) => x.address === address);
        if (n) neighborDown(e, d, s, n, 'stuck in active', out);
      }
  syncLocal(e, d, s, out);
  flush(e, d, s, out);
  s.tickAt = now + EIGRP.tickMs;
  e.schedule(EIGRP.tickMs, { kind: 'eigrp-tick', device: d.id, token: s.token });
}
function authentic(
  e: SimulationEngine,
  d: Device,
  s: EigrpState,
  port: NetworkInterface,
  packet: EigrpPacket
) {
  const keyChain = eigrpKeyChain(s, port.id);
  if (!keyChain) return !packet.authentication;
  const a = packet.authentication;
  if (!a) return false;
  return keyChainKeys(d, keyChain, 'accept', e.state.clock).some(
    (k) => k.id === a.keyId && !!k.keyString && eigrpDigest(packet, k.keyString) === a.digest
  );
}
export function receiveEigrp(
  e: SimulationEngine,
  d: Device,
  port: NetworkInterface,
  packet: EigrpPacket,
  mac: string
) {
  const s = d.eigrp;
  if (!s?.enabled || packet.asn !== s.asn || !port.ip || port.prefix === undefined) return;
  if (!eigrpPorts(d).some((p) => p.id === port.id) || eigrpPassive(s, port.id)) return;
  if (packet.dst !== EIGRP.destination && packet.dst !== port.ip) return;
  if (!sameSubnet(packet.src, port.ip, port.prefix)) {
    e.drop(
      d,
      `EIGRP: neighbor ${packet.src} (${longInterfaceName(port.name)}) is blocked: not on common subnet (${port.ip}/${port.prefix}).`,
      port.id
    );
    return;
  }
  if (!authentic(e, d, s, port, packet)) {
    e.drop(d, `EIGRP: packet from ${packet.src} on ${port.name} failed authentication.`, port.id);
    return;
  }
  const m = packet.message;
  const counter = (m.opcode + 'Received') as keyof EigrpState['counters'];
  s.counters[counter] = (s.counters[counter] + 1) >>> 0;
  e.emit(
    'EIGRP_RECEIVED',
    d.id,
    `EIGRP ${m.opcode.toUpperCase()} from ${packet.src} on ${port.name}` +
      ('routes' in m ? `, ${m.routes.length} route(s)` : '') +
      '.',
    { port: port.id }
  );
  const out = outbox();
  let n = s.neighbors.find((x) => x.address === packet.src && x.port === port.id);
  if (n && packet.ack) {
    const pending = n.pending.find((p) => p.sequence === packet.ack);
    if (pending) n.srtt = Math.max(1, Math.round(e.state.clock - pending.sentAt));
    n.pending = n.pending.filter((p) => p.sequence !== packet.ack);
  }
  if (m.opcode === 'hello') {
    if (m.k.every((k) => k === 255)) {
      if (n) neighborDown(e, d, s, n, 'Interface PEER-TERMINATION received', out);
      flush(e, d, s, out);
      return;
    }
    if (m.k.join() !== s.k.join()) {
      if (n) neighborDown(e, d, s, n, 'K-value mismatch', out);
      else e.drop(d, `EIGRP: K-value mismatch with ${packet.src} on ${port.name}.`, port.id);
      flush(e, d, s, out);
      return;
    }
    if (!n) {
      if (s.neighbors.length >= 256) {
        e.drop(d, 'EIGRP: neighbor table full.', port.id);
        return;
      }
      n = {
        address: packet.src,
        mac,
        port: port.id,
        holdMs: m.holdTime * 1000,
        expiresAt: e.state.clock + m.holdTime * 1000,
        upAt: e.state.clock,
        sequence: 0,
        pending: [],
        srtt: 0,
        ...(m.stub ? { stub: m.stub } : {}),
      };
      s.neighbors.push(n);
      e.emit(
        'EIGRP_NEIGHBOR_CHANGED',
        d.id,
        `%DUAL-5-NBRCHANGE: EIGRP-IPv4 ${s.asn}: Neighbor ${packet.src} (${longInterfaceName(port.name)}) is up: new adjacency`,
        { port: port.id }
      );
      sendTable(e, d, s, n);
      return;
    }
    n.expiresAt = e.state.clock + m.holdTime * 1000;
    n.holdMs = m.holdTime * 1000;
    n.mac = mac;
    if (m.stub) n.stub = m.stub;
    else delete n.stub;
    return;
  }
  if (!n || m.opcode === 'ack') return;
  // Every reliable packet is acknowledged, duplicates (retransmissions) included.
  transmit(e, d, port, { opcode: 'ack' }, 0, packet.sequence, n);
  const restart = m.opcode === 'update' && m.init && n.initReceived;
  if (packet.sequence <= n.sequence && !(m.opcode === 'update' && m.init)) return;
  n.sequence = packet.sequence;
  if (m.opcode === 'update' && m.init) {
    if (restart) {
      // The neighbor restarted: forget what it said and send it the whole table again.
      for (const entry of [...s.topology]) {
        if (!entry.via.some((v) => v.address === n!.address)) continue;
        const before = ownDistance(d, s, entry);
        entry.via = entry.via.filter((v) => v.address !== n!.address);
        evaluate(e, d, s, entry, out, undefined, before);
      }
      sendTable(e, d, s, n);
    }
    n.initReceived = true;
  }
  for (const r of m.routes) input(e, d, s, n, r, m.opcode, out);
  flush(e, d, s, out);
}
/** Topology entries of a device, for show commands. */
export function eigrpTopologyView(d: Device) {
  const s = d.eigrp;
  if (!s) return [];
  return s.topology.map((entry) => ({
    entry,
    successors: entry.local ? 1 : paths(d, s, entry).length,
    scored: scored(d, s, entry),
    fd: entry.local ? eigrpMetric(entry.local.vector, s.k) : entry.fd,
  }));
}
export function validateEigrp(snapshot: Snapshot) {
  for (const d of snapshot.devices) {
    const s = d.eigrp;
    if (!s) continue;
    if (!['router', 'switch'].includes(d.type))
      throw new Error('EIGRP requires a router or a Layer 3 switch.');
    const keys = s.topology.map(entryKey);
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate EIGRP topology entry.');
    if (
      s.neighbors.some((n) => !d.interfaces.some((p) => p.id === n.port)) ||
      s.topology.some((t) => t.via.some((v) => !d.interfaces.some((p) => p.id === v.port)))
    )
      throw new Error('EIGRP neighbor on a missing interface.');
    const timers = snapshot.queue.filter(
      ({ action }) => action.kind === 'eigrp-tick' && action.device === d.id
    );
    if (
      timers.length !== Number(s.enabled) ||
      (s.enabled &&
        (timers[0].at !== s.tickAt ||
          timers[0].action.kind !== 'eigrp-tick' ||
          timers[0].action.token !== s.token))
    )
      throw new Error('Inconsistent EIGRP timer.');
  }
  for (const { action } of snapshot.queue)
    if (
      action.kind === 'eigrp-tick' &&
      !snapshot.devices.some((d) => d.id === action.device && d.eigrp?.enabled)
    )
      throw new Error('EIGRP timer without a process.');
}
