import { interfaceOperational } from './protocols/layer3';
import { subnet } from './protocols/ipv4';
import { deviceTier } from './topology-sites';
import type { Device, NetworkInterface, Snapshot } from './model';

export type RoutingView = 'l3' | 'ospf' | 'bgp';
export interface RoutingEdge {
  id: string;
  a: string;
  b: string;
  label: string;
  up: boolean;
}
export interface RoutingProjection {
  devices: Device[];
  edges: RoutingEdge[];
  positions: Map<string, { x: number; y: number }>;
  /** Block heading (area, AS or tier) → device ids, in display order, with the heading position. */
  blocks: { name: string; devices: string[]; position: { x: number; y: number } }[];
}
const CELL = { width: 300, height: 190 },
  BLOCK_COLUMNS = 5,
  BLOCK_GAP = 160,
  HEADING = 70,
  MAX_ROW_WIDTH = 2400;

function network(ip: string, prefix: number) {
  return subnet(ip, prefix).network + '/' + prefix;
}
const routes = (d: Device) => d.type === 'router' || !!d.ipRouting;
const sortDevices = (a: Device, b: Device) =>
  deviceTier(a) - deviceTier(b) || a.hostname.localeCompare(b.hostname, 'en', { numeric: true });

/** Layer-3 segments: routed interfaces of different devices in the same subnet and VRF. */
function segments(s: Snapshot, include: (d: Device, p: NetworkInterface) => boolean) {
  const bySubnet = new Map<string, { device: Device; port: NetworkInterface }[]>();
  for (const device of s.devices)
    for (const port of device.interfaces) {
      if (!port.ip || port.prefix === undefined || port.prefix >= 32 || !include(device, port)) continue;
      const key = (port.vrf ?? '') + '|' + network(port.ip, port.prefix);
      bySubnet.set(key, [...(bySubnet.get(key) ?? []), { device, port }]);
    }
  return [...bySubnet].filter(([, ends]) => new Set(ends.map((e) => e.device.id)).size > 1);
}
/** Full mesh for small segments, star from the first member for larger shared LANs. */
function pairs<T>(ends: T[]) {
  if (ends.length <= 4) return ends.flatMap((a, i) => ends.slice(i + 1).map((b) => [a, b] as const));
  return ends.slice(1).map((b) => [ends[0], b] as const);
}
function project(blocks: { name: string; devices: Device[] }[], edges: RoutingEdge[]): RoutingProjection {
  const kept = blocks.filter((b) => b.devices.length);
  const positions = new Map<string, { x: number; y: number }>();
  const headings: RoutingProjection['blocks'] = [];
  // Blocks flow left to right and wrap, so many small blocks (e.g. one AS per branch) stay compact.
  let x = 80,
    top = 80,
    rowHeight = 0;
  for (const block of kept) {
    const width = Math.min(block.devices.length, BLOCK_COLUMNS) * CELL.width,
      height = HEADING + Math.ceil(block.devices.length / BLOCK_COLUMNS) * CELL.height;
    if (x > 80 && x + width > 80 + MAX_ROW_WIDTH) {
      x = 80;
      top += rowHeight + BLOCK_GAP;
      rowHeight = 0;
    }
    headings.push({ name: block.name, devices: block.devices.map((d) => d.id), position: { x, y: top } });
    block.devices.sort(sortDevices).forEach((d, i) =>
      positions.set(d.id, {
        x: x + (i % BLOCK_COLUMNS) * CELL.width,
        y: top + HEADING + Math.floor(i / BLOCK_COLUMNS) * CELL.height,
      })
    );
    x += width + BLOCK_GAP;
    rowHeight = Math.max(rowHeight, height);
  }
  return { devices: kept.flatMap((b) => b.devices), edges, positions, blocks: headings };
}
function l3View(s: Snapshot) {
  const edges: RoutingEdge[] = [];
  for (const [key, ends] of segments(s, (d) => routes(d) && d.power !== false)) {
    const subnet = key.split('|');
    const unique = [...new Map(ends.map((e) => [e.device.id, e])).values()];
    for (const [a, b] of pairs(unique))
      edges.push({
        id: 'l3:' + key + ':' + a.device.id + ':' + b.device.id,
        a: a.device.id,
        b: b.device.id,
        label: (subnet[0] ? 'VRF ' + subnet[0] + ' · ' : '') + subnet[1],
        up: interfaceOperational(s, a.device, a.port) && interfaceOperational(s, b.device, b.port),
      });
  }
  const routed = s.devices.filter(routes);
  return project(
    [
      { name: 'Roteadores', devices: routed.filter((d) => d.type === 'router') },
      { name: 'Switches L3', devices: routed.filter((d) => d.type !== 'router') },
    ],
    edges
  );
}
function ospfView(s: Snapshot) {
  const speakers = s.devices.filter((d) => d.ospf?.enabled);
  const byRouterId = new Map(speakers.map((d) => [d.ospf!.routerId, d]));
  const edges = new Map<string, RoutingEdge>();
  const areaOf = (d: Device, port: string) => d.ospf?.interfaces.find((i) => i.port === port)?.area;
  for (const d of speakers)
    for (const n of d.ospf!.neighbors) {
      const peer = byRouterId.get(n.routerId);
      if (!peer || peer.id === d.id) continue;
      const [a, b] = d.id < peer.id ? [d, peer] : [peer, d];
      const id = 'ospf:' + a.id + ':' + b.id + ':' + n.area;
      const full = n.state === 'Full' || n.state === '2-Way';
      const old = edges.get(id);
      if (!old || (!old.up && full))
        edges.set(id, {
          id,
          a: a.id,
          b: b.id,
          label: 'Área ' + n.area + ' · ' + n.state.toUpperCase(),
          up: full,
        });
    }
  // Configured OSPF segments without a neighbor are shown as failed adjacencies.
  // Passive interfaces never form neighbors, so their segments are not expected to have one.
  const active = (d: Device, port: string) =>
    d.ospf?.interfaces.some((i) => i.port === port && !i.passive) ?? false;
  for (const [, ends] of segments(s, (d, p) => !!d.ospf?.enabled && active(d, p.id))) {
    const unique = [...new Map(ends.map((e) => [e.device.id, e])).values()];
    for (const [x, y] of pairs(unique)) {
      const [a, b] = x.device.id < y.device.id ? [x, y] : [y, x];
      const area = areaOf(a.device, a.port.id)!;
      const id = 'ospf:' + a.device.id + ':' + b.device.id + ':' + area;
      if (edges.has(id) || [...edges.values()].some((e) => e.a === a.device.id && e.b === b.device.id))
        continue;
      edges.set(id, {
        id,
        a: a.device.id,
        b: b.device.id,
        label: 'Área ' + area + ' · sem adjacência',
        up: false,
      });
    }
  }
  // Backbone-only routers, ABRs (area 0 plus another area), then routers internal to each area.
  const areas = new Map<number, Device[]>();
  for (const d of speakers) {
    const nonBackbone = [...new Set(d.ospf!.interfaces.map((i) => i.area))].filter((area) => area !== 0);
    const internal = d.ospf!.interfaces.every((i) => i.area !== 0) && nonBackbone.length === 1;
    const block = !nonBackbone.length ? -2 : internal ? nonBackbone[0] : -1;
    areas.set(block, [...(areas.get(block) ?? []), d]);
  }
  return project(
    [...areas]
      .sort(([a], [b]) => a - b)
      .map(([block, devices]) => ({
        name: block === -2 ? 'Área 0 (backbone)' : block === -1 ? 'ABRs' : 'Área ' + block,
        devices,
      })),
    [...edges.values()]
  );
}
function bgpView(s: Snapshot) {
  const speakers = s.devices.filter((d) => d.bgp?.enabled);
  const owner = new Map<string, Device>();
  for (const d of speakers) for (const p of d.interfaces) if (p.ip) owner.set(p.ip, d);
  const edges = new Map<string, RoutingEdge>();
  for (const d of speakers)
    for (const n of d.bgp!.neighbors) {
      const peer = owner.get(n.ip);
      if (!peer || peer.id === d.id) continue;
      const [a, b] = d.id < peer.id ? [d, peer] : [peer, d];
      const id = 'bgp:' + a.id + ':' + b.id;
      const state = d.bgp!.peers.find((p) => p.ip === n.ip)?.state ?? 'Idle';
      const up = state === 'Established';
      const old = edges.get(id);
      if (old && (old.up || !up)) continue;
      const kind = a.bgp!.asn === b.bgp!.asn ? 'iBGP' : 'eBGP';
      edges.set(id, {
        id,
        a: a.id,
        b: b.id,
        label: kind + ' AS' + a.bgp!.asn + (kind === 'eBGP' ? '↔AS' + b.bgp!.asn : '') + ' · ' + state,
        up,
      });
    }
  const systems = new Map<number, Device[]>();
  for (const d of speakers) systems.set(d.bgp!.asn, [...(systems.get(d.bgp!.asn) ?? []), d]);
  return project(
    [...systems].sort(([a], [b]) => a - b).map(([asn, devices]) => ({ name: 'AS ' + asn, devices })),
    [...edges.values()]
  );
}
/** Read-only control-plane projections; edges never stand for physical cables. */
export function routingView(s: Snapshot, view: RoutingView): RoutingProjection {
  return view === 'l3' ? l3View(s) : view === 'ospf' ? ospfView(s) : bgpView(s);
}
