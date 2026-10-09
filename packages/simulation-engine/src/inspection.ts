import type { Snapshot } from './model';
import type { SimulationEngine } from './core/engine';

export function traceNetworkPath(engine: SimulationEngine, source: string, destination: string) {
  const target = engine.device(destination).interfaces.find((port) => port.ip && port.adminUp)?.ip;
  if (!target) throw new Error('O destino precisa de uma interface IPv4 ativa.');
  const id = engine.ping(source, target);
  const probe = engine.state.probes.find((entry) => entry.id === id)!;
  for (let steps = 0; steps < 3000 && probe.status === 'pending'; steps++) if (!engine.step()) break;
  if (probe.status === 'pending') throw new Error('Diagnóstico excedeu o orçamento de 3000 eventos.');
  return id;
}
export function packetPath(snapshot: Snapshot, probeId: string) {
  return snapshot.events.flatMap((event) => {
    const packet = event.frame?.packet;
    if (
      event.type !== 'FRAME_SENT' ||
      packet?.protocol !== 'ICMP' ||
      (packet.traceId ?? packet.probeId) !== probeId
    )
      return [];
    const device = snapshot.devices.find((entry) => entry.id === event.device);
    const port = device?.interfaces.find((entry) => entry.id === event.port);
    return [
      {
        id: event.id,
        time: event.time,
        device: event.device,
        hostname: device?.hostname ?? event.device,
        port: port?.name ?? event.port ?? '-',
        peer: snapshot.devices.find((entry) => entry.id === event.peer)?.hostname ?? event.peer ?? '-',
        src: packet.src,
        dst: packet.dst,
        sourceMac: event.frame!.src,
        destinationMac: event.frame!.dst,
        vlan: event.frame!.vlan,
        ttl: packet.ttl,
        kind: packet.kind,
      },
    ];
  });
}
export function deviceParticipatesInVlan(snapshot: Snapshot, id: string, vlan: number) {
  const device = snapshot.devices.find((entry) => entry.id === id);
  if (!device) return false;
  if (device.interfaces.some((port) => port.logical?.vlan === vlan)) return true;
  if (device.type === 'switch') return device.vlans.some((entry) => entry.id === vlan);
  return snapshot.links.some((link) => {
    const peer = link.a.device === id ? link.b : link.b.device === id ? link.a : undefined;
    if (!peer) return false;
    const neighbor = snapshot.devices.find((entry) => entry.id === peer.device);
    const port = neighbor?.interfaces.find((entry) => entry.id === peer.port);
    return (
      neighbor?.type === 'switch' &&
      (port?.mode === 'trunk'
        ? port.nativeVlan === vlan && port.allowedVlans.includes(vlan)
        : port?.accessVlan === vlan)
    );
  });
}
