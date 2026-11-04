import { collapsedMembers, linkOperational, routingView, type Snapshot, type Link } from '@shlab/engine';
export type TopologyView = 'physical' | 'logical' | 'l3' | 'ospf' | 'bgp';
export const TOPOLOGY_VIEWS: { id: TopologyView; label: string; hint?: string }[] = [
  { id: 'physical', label: 'Física' },
  {
    id: 'logical',
    label: 'Lógica',
    hint: 'Projeção para consulta; agrupamentos de cabos não representam novos protocolos.',
  },
  {
    id: 'l3',
    label: 'Camada 3 (sub-redes)',
    hint: 'Roteadores e switches L3 ligados por sub-rede IPv4 comum.',
  },
  {
    id: 'ospf',
    label: 'OSPF (áreas)',
    hint: 'Adjacências OSPF por área; tracejado indica vizinho ausente ou incompleto.',
  },
  {
    id: 'bgp',
    label: 'BGP (sistemas autônomos)',
    hint: 'Sessões BGP agrupadas por AS; tracejado indica sessão não estabelecida.',
  },
];
export interface Projection {
  devices: Snapshot['devices'];
  links: Link[];
  labels: Map<string, string>;
  positions: Map<string, { x: number; y: number }>;
  /** Operational state for projected edges that are not physical links. */
  status: Map<string, boolean>;
  /** Draw devices as compact nodes with a single connection point. */
  compact: boolean;
  /** Device → collapsed group that stands in for it. */
  hidden: Map<string, string>;
  /** Block titles of control-plane views (area, AS or tier). */
  headings: { id: string; text: string; position: { x: number; y: number } }[];
}
const edge = (id: string, a: string, b: string, up: boolean): Link => ({
  id,
  a: { device: a, port: 'overview' },
  b: { device: b, port: 'overview' },
  cable: 'copper',
  up,
  latency: 1,
  jitter: 0,
  loss: 0,
  distance: 1,
});
function physical(s: Snapshot): Projection {
  const hidden = collapsedMembers(s);
  const base = {
    labels: new Map<string, string>(),
    positions: new Map<string, { x: number; y: number }>(),
    status: new Map<string, boolean>(),
    compact: false,
    hidden,
    headings: [],
  };
  if (!hidden.size) return { ...base, devices: s.devices, links: s.links };
  const byId = new Map(s.devices.map((d) => [d.id, d]));
  const name = (end: Link['a']) =>
    byId.get(end.device)?.interfaces.find((p) => p.id === end.port)?.name ?? end.port;
  const links: Link[] = [],
    merged = new Map<string, { link: Link; count: number; up: boolean; sample: Link }>();
  for (const l of s.links) {
    const a = hidden.get(l.a.device),
      b = hidden.get(l.b.device);
    if (!a && !b) {
      links.push(l);
      continue;
    }
    if (a && a === b) continue;
    const key = [a ?? l.a.device, b ?? l.b.device].sort().join('|');
    const up = linkOperational(s, l);
    const old = merged.get(key);
    if (old) {
      old.count++;
      old.up ||= up;
    } else
      merged.set(key, {
        // Group ends attach to the collapsed group's single handle; device ends keep their port.
        link: {
          ...l,
          id: 'group:' + key,
          a: a ? { device: a, port: 'group' } : l.a,
          b: b ? { device: b, port: 'group' } : l.b,
        },
        count: 1,
        up,
        sample: l,
      });
  }
  for (const { link, count, up, sample } of merged.values()) {
    links.push(link);
    base.status.set(link.id, up);
    base.labels.set(link.id, count > 1 ? count + ' cabos' : name(sample.a) + ' ↔ ' + name(sample.b));
  }
  return { ...base, devices: s.devices.filter((d) => !hidden.has(d.id)), links };
}
function routing(s: Snapshot, view: 'l3' | 'ospf' | 'bgp'): Projection {
  const projection = routingView(s, view);
  const labels = new Map<string, string>(),
    status = new Map<string, boolean>();
  const links = projection.edges.map((e) => {
    labels.set(e.id, e.label);
    status.set(e.id, e.up);
    return edge(e.id, e.a, e.b, e.up);
  });
  return {
    devices: projection.devices,
    links,
    labels,
    status,
    positions: projection.positions,
    compact: true,
    hidden: new Map(),
    headings: projection.blocks.map((block, index) => ({
      id: 'heading:' + view + ':' + index,
      text: block.name + ' · ' + block.devices.length,
      position: block.position,
    })),
  };
}
/** Logical projection traces explicit panel jumpers; it never certifies reachability. */
export function topologyView(s: Snapshot, view: TopologyView): Projection {
  if (view === 'physical') return physical(s);
  if (view !== 'logical') return routing(s, view);
  const passive = new Set(
    s.devices
      .filter((d) => ['rack', 'ups', 'patch-panel'].includes(d.infrastructure?.kind ?? ''))
      .map((d) => d.id)
  );
  const devices = s.devices.filter((d) => !passive.has(d.id));
  const ports = new Map<string, Link[]>();
  for (const l of s.links)
    for (const end of [l.a, l.b]) {
      const k = JSON.stringify(end);
      ports.set(k, [...(ports.get(k) ?? []), l]);
    }
  const projected: Link[] = [];
  for (const origin of s.links) {
    const start = !passive.has(origin.a.device)
      ? origin.a
      : !passive.has(origin.b.device)
        ? origin.b
        : undefined;
    if (!start) continue;
    let link = origin,
      end = link.a.device === start.device && link.a.port === start.port ? link.b : link.a;
    const seen = new Set([origin.id]);
    let up = linkOperational(s, origin);
    while (passive.has(end.device)) {
      const d = s.devices.find((d) => d.id === end.device),
        panel = d?.infrastructure;
      if (panel?.kind !== 'patch-panel') break;
      const pair = panel.pairs.find((p) => p.a === end.port || p.b === end.port);
      if (!pair) break;
      const nextPort = pair.a === end.port ? pair.b : pair.a;
      const next = ports
        .get(JSON.stringify({ device: end.device, port: nextPort }))
        ?.find((l) => !seen.has(l.id));
      if (!next) break;
      seen.add(next.id);
      up = up && linkOperational(s, next);
      link = next;
      end = link.a.device === d!.id && link.a.port === nextPort ? link.b : link.a;
    }
    if (passive.has(end.device) || start.device >= end.device) continue;
    projected.push({ ...origin, a: start, b: end, up });
  }
  const groups = new Map<string, Link[]>();
  for (const l of projected) {
    const k = JSON.stringify([l.a.device, l.b.device]);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const labels = new Map<string, string>(),
    links: Link[] = [];
  for (const group of groups.values()) {
    const l = group.find((l) => l.up) ?? group[0];
    links.push(l);
    const a = s.devices.find((d) => d.id === l.a.device)!,
      b = s.devices.find((d) => d.id === l.b.device)!;
    const annotations = new Set<string>();
    for (const p of [...a.interfaces, ...b.interfaces]) {
      if (p.vrf) annotations.add('VRF ' + p.vrf);
      if (p.vxlan) annotations.add('VNI ' + p.vxlan.vni);
    }
    labels.set(l.id, (group.length > 1 ? group.length + ' cabos · ' : '') + [...annotations].join(' · '));
  }
  const layer = (d: Snapshot['devices'][number]) =>
    d.type === 'router' || d.ipRouting ? 0 : d.type === 'switch' ? 1 : 2;
  const sorted = [...devices].sort(
    (a, b) => layer(a) - layer(b) || a.hostname.localeCompare(b.hostname, 'en')
  );
  const counts = [0, 0, 0],
    positions = new Map<string, { x: number; y: number }>();
  for (const d of sorted) {
    const row = layer(d),
      index = counts[row]++;
    positions.set(d.id, { x: 80 + (index % 12) * 350, y: 80 + row * 1800 + Math.floor(index / 12) * 240 });
  }
  return {
    devices,
    links,
    labels,
    positions,
    status: new Map<string, boolean>(),
    compact: false,
    hidden: new Map<string, string>(),
    headings: [],
  };
}
