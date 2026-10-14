import type { Device, NetworkInterface, Snapshot } from '../model';
import { linksAt } from '../core/topology-index';
import { linkOperational } from '../links/physical';
export function bondActive(s: Snapshot, d: Device, p: NetworkInterface): string | undefined {
  const b = p.bond;
  if (!b || !d.power || !p.adminUp) return;
  const eligible = (id: string) => {
    const member = d.interfaces.find((m) => m.id === id);
    if (
      !member?.adminUp ||
      member.channel !== p.id ||
      !linksAt(s, d.id, id).some((l) => linkOperational(s, l))
    )
      return false;
    if (!b.monitor) return true;
    const last = b.health.find((h) => h.port === id)?.lastResponseAt;
    return last !== undefined
      ? s.clock < last + b.monitor.timeoutMs
      : s.clock < b.startedAt + b.monitor.timeoutMs;
  };
  return eligible(b.primary) ? b.primary : b.members.find(eligible);
}
