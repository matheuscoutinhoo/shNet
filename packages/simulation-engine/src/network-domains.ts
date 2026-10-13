import type { Device, NetworkInterface, Snapshot } from './model';

// Configuration graph: potential Ethernet domains, independent of current STP/carrier.
// Routing never merges domains. VLAN numbers and VRF names alone are not global identities.
export function networkDomains(s: Snapshot) {
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    const p = parent.get(key)!;
    if (p !== key) parent.set(key, root(p));
    return parent.get(key)!;
  };
  const join = (a: string, b: string) => {
    parent.set(root(b), root(a));
  };
  const tags = [...new Set([0, ...s.devices.flatMap((d) => d.vlans.map((v) => v.id))])];
  const passive = (d: Device, port: string, tag: number) => d.id + ':jumper:' + port + ':' + tag;
  for (const d of s.devices) {
    if (d.infrastructure?.kind === 'patch-panel')
      for (const p of d.infrastructure.pairs)
        for (const tag of tags) join(passive(d, p.a, tag), passive(d, p.b, tag));
    if (d.bgp?.enabled)
      for (const peer of d.bgp.neighbors) {
        const other = s.devices.find(
          (x) => x.bgp?.enabled && x.interfaces.some((p) => p.ip === peer.ip) && x.bgp.asn === peer.remoteAs
        );
        if (other) join('bgp:' + d.id, 'bgp:' + other.id);
      }
  }
  const bridge = (d: Device, vlan: number) => d.id + ':vlan:' + vlan;
  const domain = (d: Device, p: NetworkInterface) =>
    p.logical?.kind === 'svi'
      ? bridge(d, p.logical.vlan)
      : p.mode !== 'routed'
        ? bridge(d, p.accessVlan)
        : d.id + ':port:' + p.id;
  const wires = (d: Device, physical: NetworkInterface) => {
    if (d.infrastructure?.kind === 'patch-panel')
      return tags.map((tag) => ({ tag, node: passive(d, physical.id, tag) }));
    const p = physical.channel ? (d.interfaces.find((x) => x.id === physical.channel) ?? physical) : physical;
    if (p.mode === 'trunk')
      return p.allowedVlans.map((v) => ({ tag: v === p.nativeVlan ? 0 : v, node: bridge(d, v) }));
    const entries = [{ tag: 0, node: domain(d, p) }];
    if (p.mode === 'routed')
      for (const sub of d.interfaces.filter((x) => x.logical?.parent === p.id))
        entries.push({ tag: sub.logical!.vlan, node: domain(d, sub) });
    return entries;
  };
  for (const d of s.devices.filter((d) => d.wireless?.association)) {
    const ap = s.devices.find(
      (a) =>
        a.wireless?.role === 'ap' &&
        a.interfaces.find((p) => p.id === a.wireless!.port)?.mac === d.wireless!.association!.bssid
    );
    const a = ap?.interfaces.find((p) => p.id === ap.wireless!.port),
      b = d.interfaces.find((p) => p.id === d.wireless!.port);
    if (ap && a && b) join(domain(ap, a), domain(d, b));
  }
  for (const l of s.links) {
    const a = s.devices.find((d) => d.id === l.a.device),
      b = s.devices.find((d) => d.id === l.b.device);
    const ap = a?.interfaces.find((p) => p.id === l.a.port),
      bp = b?.interfaces.find((p) => p.id === l.b.port);
    if (!a || !b || !ap || !bp) continue;
    for (const x of wires(a, ap)) for (const y of wires(b, bp)) if (x.tag === y.tag) join(x.node, y.node);
  }
  for (const a of s.devices)
    for (const p of a.interfaces.filter((p) => p.vxlan?.enabled)) {
      const v = p.vxlan!;
      for (const b of s.devices.filter((b) => b.id !== a.id))
        for (const q of b.interfaces.filter((q) => q.vxlan?.enabled && q.vxlan.vni === v.vni)) {
          const w = q.vxlan!,
            remote = b.interfaces.find((x) => x.id === w.underlay)?.ip;
          const local = a.interfaces.find((x) => x.id === v.underlay)?.ip;
          const staticPair = remote && local && v.peers.includes(remote) && w.peers.includes(local);
          const evpnPair =
            v.peerPolicy === 'evpn' &&
            w.peerPolicy === 'evpn' &&
            v.routeTarget === w.routeTarget &&
            !!a.bgp?.enabled &&
            !!b.bgp?.enabled &&
            root('bgp:' + a.id) === root('bgp:' + b.id);
          if (staticPair || evpnPair) join(bridge(a, v.vlan), bridge(b, w.vlan));
        }
    }
  return (d: Device, p: NetworkInterface) => root(domain(d, p));
}
