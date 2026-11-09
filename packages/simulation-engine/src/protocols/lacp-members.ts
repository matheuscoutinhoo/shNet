import type { Device, NetworkInterface, Snapshot } from '../model';
import { linkOperational } from '../links/physical';
import { findPort, linksAt } from '../core/topology-index';
import { pagpMode } from './lacp-model';
export function lacpMembers(snapshot: Snapshot, device: Device, port: NetworkInterface) {
  const agg = port.aggregate;
  if (!agg || !device.power || !port.adminUp) return [];
  // Static EtherChannel ("mode on"): every member with an operational link is bundled.
  if (agg.mode === 'on') {
    const up = agg.members
      .filter(
        (id) =>
          findPort(device, id)?.channel === port.id &&
          linksAt(snapshot, device.id, id).some((l) => linkOperational(snapshot, l))
      )
      .sort();
    return up.length >= agg.minLinks ? up : [];
  }
  const candidates = agg.received
    .filter((r) => {
      const member = findPort(device, r.port),
        partner = r.pdu.partner;
      return (
        member?.channel === port.id &&
        agg.members.includes(r.port) &&
        r.expiresAt > snapshot.clock &&
        partner?.system === device.interfaces[0].mac &&
        partner.key === agg.number &&
        partner.port === r.port &&
        // The PDU's protocol matches the group (PAgP for desirable/auto, LACP otherwise), and at
        // least one side actively negotiates (active/desirable).
        !!r.pdu.pagp === pagpMode(agg.mode) &&
        (agg.mode === 'active' || agg.mode === 'desirable' || r.pdu.active) &&
        linksAt(snapshot, device.id, r.port).some((l) => linkOperational(snapshot, l))
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
