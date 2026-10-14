import { linkOperational, type Snapshot, type Link } from '@shlab/engine';
export type TopologyView = 'physical' | 'logical';
/** Logical projection traces explicit panel jumpers; it never certifies reachability. */
export function topologyView(s: Snapshot, view: TopologyView) {
  if (view === 'physical')
    return {
      devices: s.devices,
      links: s.links,
      labels: new Map<string, string>(),
      positions: new Map<string, { x: number; y: number }>(),
    };
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
  return { devices, links, labels, positions };
}
