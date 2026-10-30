import type { Device, Frame, NetworkInterface, Snapshot } from '../model';
import type { SimulationEngine } from '../core/engine';
import { interfaceOperational } from './layer3';
import { retainArpResolutions } from './arp';
import { startDhcp } from './dhcp-client';

const dataFrame = (f: Frame) => !!(f.arp || f.packet || f.ipv6 || f.fragment);
/** A phone learns only the CDP policy received on its own physical Ethernet port. */
export function phoneVoiceVlan(s: Snapshot, d: Device, p: NetworkInterface, stale = false) {
  if (
    !d.phone?.enabled ||
    d.phone.autoVoiceVlan === false ||
    p.logical ||
    p.loopback ||
    !['rj45', 'sfp', 'qsfp'].includes(p.media)
  )
    return;
  if (!stale && (!d.power || !interfaceOperational(s, d, p))) return;
  return d.discovery?.neighbors
    .filter(
      (n) =>
        n.protocol === 'CDP' &&
        n.port === p.id &&
        n.voiceVlan !== undefined &&
        (stale || n.expiresAt > s.clock)
    )
    .sort((a, b) => b.receivedAt - a.receivedAt || a.chassisId.localeCompare(b.chassisId))[0]?.voiceVlan;
}
export function phoneVoiceVlans(s: Snapshot, d: Device, stale = false) {
  return new Map(d.interfaces.map((p) => [p.id, phoneVoiceVlan(s, d, p, stale)]));
}
export function phoneEgressFrame(s: Snapshot, d: Device, p: NetworkInterface, f: Frame): Frame {
  const vlan = phoneVoiceVlan(s, d, p);
  return vlan !== undefined && dataFrame(f) && f.vlan === undefined ? { ...f, vlan, pcp: 5 } : f;
}
export function phoneIngressFrame(
  s: Snapshot,
  d: Device,
  p: NetworkInterface,
  f: Frame
): { frame: Frame; error?: string } {
  if (!d.phone?.enabled || d.phone.autoVoiceVlan === false || !dataFrame(f)) return { frame: f };
  const vlan = phoneVoiceVlan(s, d, p);
  if (vlan === undefined) return { frame: f };
  if (f.vlan !== vlan)
    return { frame: f, error: 'Voice VLAN: phone data must arrive on the learned VLAN ' + vlan + '.' };
  const frame = { ...f };
  delete frame.vlan;
  delete frame.pcp;
  return { frame };
}
/** A VLAN move invalidates ARP/DHCP and active dialogs instead of reusing state from another LAN. */
export function refreshPhoneVoiceNetwork(
  e: SimulationEngine,
  d: Device,
  before: Map<string, number | undefined>
) {
  if (!d.phone?.enabled || d.phone.autoVoiceVlan === false) return;
  for (const p of d.interfaces) {
    const next = phoneVoiceVlan(e.state, d, p);
    if (before.get(p.id) === next) continue;
    const local = p.ip;
    d.arpTable = d.arpTable.filter((a) => a.port !== p.id);
    d.pending = d.pending.filter((a) => a.port !== p.id);
    retainArpResolutions(e, d);
    for (const c of d.phone.calls)
      if (c.local === local && ['CALLING', 'RINGING', 'ESTABLISHED'].includes(c.state)) {
        c.state = 'FAILED';
        e.state.queue = e.state.queue.filter(
          (q) => q.action.kind !== 'voice-tick' || q.action.device !== d.id || q.action.call !== c.id
        );
      }
    e.emit(
      'CONFIG_CHANGED',
      d.id,
      'Phone voice network changed: ' + (next === undefined ? 'untagged' : 'VLAN ' + next) + '.',
      { port: p.id }
    );
    if (p.ipv4Mode === 'dhcp' && d.power && interfaceOperational(e.state, d, p)) startDhcp(e, d, p);
  }
}
