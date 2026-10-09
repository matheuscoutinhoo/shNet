import type { Device, NetworkInterface, Snapshot } from '../model';
import { linkOperational } from '../links/physical';
export function lacpMembers(snapshot: Snapshot, device: Device, port: NetworkInterface) {
  const agg = port.aggregate;
  if (!agg || !device.power || !port.adminUp) return [];
  const candidates = agg.received
    .filter((r) => {
      const member = device.interfaces.find((p) => p.id === r.port),
        partner = r.pdu.partner;
      return (
        member?.channel === port.id &&
        agg.members.includes(r.port) &&
        r.expiresAt > snapshot.clock &&
        partner?.system === device.interfaces[0].mac &&
        partner.key === agg.number &&
        partner.port === r.port &&
        (agg.mode === 'active' || r.pdu.active) &&
        snapshot.links.some(
          (l) =>
            [l.a, l.b].some((end) => end.device === device.id && end.port === r.port) &&
            linkOperational(snapshot, l)
        )
      );
    })
    .sort(
      (a, b) =>
        a.pdu.actor.system.localeCompare(b.pdu.actor.system) ||
        a.pdu.actor.key - b.pdu.actor.key ||
        a.port.localeCompare(b.port)
    );
  const partner = candidates[0]?.pdu.actor;
  const selected = candidates
    .filter((r) => r.pdu.actor.system === partner?.system && r.pdu.actor.key === partner.key)
    .map((r) => r.port)
    .sort();
  return selected.length >= agg.minLinks ? selected : [];
}
export const switchingPorts = (d: Device) =>
  d.interfaces.filter((p) => !p.logical && !p.channel && !p.vxlan && p.mode !== 'routed');
