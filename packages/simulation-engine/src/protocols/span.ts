import type { SimulationEngine } from '../core/engine';
import type { Device, Frame, NetworkInterface } from '../model';
import { findInterface, sameInterface } from './interface-name';

// Without "encapsulation replicate", SPAN does not copy Layer 2 control frames (BPDU, CDP, LACP...).
const COPIED = new Set<Frame['etherType']>(['IPv4', 'IPv6', 'ARP', 'MPLS']);
const named = (d: Device, name: string) => findInterface(d, name);
const same = sameInterface;

/** A SPAN destination only transmits copies: it neither switches nor learns from what it receives. */
export function spanDestination(d: Device, p: NetworkInterface) {
  return !!d.iosSystem?.monitorSessions?.some(
    (s) => s.destination && same(s.destination, p.name) && (s.sources.length || s.vlans?.length)
  );
}
/**
 * Local SPAN ("monitor session"): frames received (rx) or sent (tx) on a source interface, and
 * frames received in a source VLAN, are copied untagged to the session's destination interface.
 */
export function mirrorFrame(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  frame: Frame,
  vlan: number,
  direction: 'rx' | 'tx'
) {
  const sessions = d.iosSystem?.monitorSessions;
  if (!sessions?.length || !COPIED.has(frame.etherType)) return;
  for (const s of sessions) {
    if (!s.destination) continue;
    const source =
      s.sources.some(
        (src) => same(src.port, p.name) && (src.direction === 'both' || src.direction === direction)
      ) ||
      (direction === 'rx' && !!s.vlans?.includes(vlan));
    const target = source ? named(d, s.destination) : undefined;
    if (!target || target.id === p.id || !target.adminUp) continue;
    e.sendFrame(d.id, target.id, { ...frame, vlan: undefined, pcp: undefined });
  }
}
