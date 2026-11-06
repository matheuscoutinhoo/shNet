import type { Device } from '../model';
import { longInterfaceName } from './interface-name';

// Events that IOS reports as syslog messages, with the severity and mnemonic they map to.
// An empty mnemonic keeps only the events already worded as IOS messages (e.g. %PM-4-ERR_DISABLE).
const SYSLOG_EVENTS: Record<string, [number, string]> = {
  LINK_DOWN: [3, 'LINK-3-UPDOWN'],
  LINK_UP: [3, 'LINK-3-UPDOWN'],
  OSPF_NEIGHBOR_CHANGED: [5, 'OSPF-5-ADJCHG'],
  BGP_STATE_CHANGED: [5, 'BGP-5-ADJCHANGE'],
  VRRP_STATE_CHANGED: [6, 'VRRP-6-STATECHANGE'],
  HSRP_STATE_CHANGED: [5, 'HSRP-5-STATECHANGE'],
  STP_ROOT_CHANGED: [6, 'SPANTREE-6-ROOTCHANGE'],
  STP_TOPOLOGY_CHANGED: [6, 'SPANTREE-6-TOPOCHANGE'],
  CONFIG_CHANGED: [5, ''],
  // "%SEC-6-IPACCESSLOG..." messages of ACL entries configured with "log".
  ACL_PERMIT: [6, ''],
  ACL_DENY: [6, ''],
  // %BGP-4-MAXPFX and %BGP-3-MAXPFXEXCEED.
  BGP_ROUTE_REJECTED: [4, ''],
  // %FW-6-DROP_PKT of zone-pair classes configured with "drop log".
  FIREWALL_DENY: [6, ''],
};
/** "10.0.0.2: OpenConfirm → Established." becomes "neighbor 10.0.0.2 Up" (IOS logs only Up/Down). */
function bgpAdjacency(d: Device | undefined, reason: string) {
  const match = /^([\d.]+): (\S+) → (\S+)\.$/.exec(reason);
  if (!match || d?.bgp?.logNeighborChanges === false) return;
  if (match[3] === 'Established') return 'neighbor ' + match[1] + ' Up';
  if (match[2] === 'Established') return 'neighbor ' + match[1] + ' Down';
}
const OSPF_STATES: Record<string, string> = {
  Down: 'DOWN',
  Init: 'INIT',
  '2-Way': '2WAY',
  ExStart: 'EXSTART',
  Exchange: 'EXCHANGE',
  Loading: 'LOADING',
  Full: 'FULL',
};
// IOS explains each transition by the event that caused it.
const OSPF_EVENTS: Record<string, string> = {
  INIT: 'Received Hello',
  '2WAY': '2-Way Received',
  EXSTART: 'AdjOK?',
  EXCHANGE: 'Negotiation Done',
  LOADING: 'Exchange Done',
  FULL: 'Loading Done',
};
const OSPF_DOWN: Record<string, string> = {
  'Dead interval expirou': 'Dead timer expired',
  'BFD Down': 'BFD node down',
};
/** "%OSPF-5-ADJCHG: Process 1, Nbr 2.2.2.2 on GigabitEthernet0/1 from LOADING to FULL, Loading Done". */
function ospfAdjacency(d: Device | undefined, reason: string, port?: string) {
  const match = /^([\d.]+)(?: em \S+)?: (\S+) → (\S+?)(?:; (.*))?\.$/.exec(reason);
  const setting = d?.ospf?.logAdjacencyChanges;
  if (!match || !d?.ospf || setting === false) return;
  const from = OSPF_STATES[match[2]] ?? match[2].toUpperCase(),
    to = OSPF_STATES[match[3]] ?? match[3].toUpperCase();
  if (setting !== 'detail' && to !== 'FULL' && to !== 'DOWN') return;
  const name = d.interfaces.find((p) => p.id === port)?.name ?? port ?? '';
  const why =
    to === 'DOWN'
      ? 'Neighbor Down: ' + (OSPF_DOWN[match[4] ?? ''] ?? 'Interface down or detached')
      : (OSPF_EVENTS[to] ?? 'Received Hello');
  return `Process ${d.ospf.processId ?? 1}, Nbr ${match[1]} on ${longInterfaceName(name)} from ${from} to ${to}, ${why}`;
}
/** The IOS syslog message an engine event produces, if any. */
export function iosSyslogMessage(type: string, reason: string, d?: Device, port?: string) {
  const kind = SYSLOG_EVENTS[type];
  if (!kind) return;
  const own = /^%[\w-]+-(\d)-\w+:/.exec(reason);
  if (own) return { severity: Number(own[1]), text: reason };
  if (type === 'BGP_STATE_CHANGED') {
    const text = bgpAdjacency(d, reason);
    return text ? { severity: 5, text: '%BGP-5-ADJCHANGE: ' + text } : undefined;
  }
  if (type === 'OSPF_NEIGHBOR_CHANGED') {
    const text = ospfAdjacency(d, reason, port);
    return text ? { severity: 5, text: '%OSPF-5-ADJCHG: ' + text } : undefined;
  }
  return kind[1] ? { severity: kind[0], text: '%' + kind[1] + ': ' + reason } : undefined;
}
// IOS default: "logging buffered 4096 debugging".
export const DEFAULT_LOG_BUFFER = { size: 4096, level: 7 };
export function loggingBuffer(d: Device) {
  const buffered = d.iosSystem?.logging?.buffered;
  return buffered === false ? undefined : (buffered ?? DEFAULT_LOG_BUFFER);
}
/** Stores a syslog message in the circular logging buffer; the oldest messages give way when full. */
export function bufferSyslog(d: Device, clock: number, type: string, reason: string, port?: string) {
  const message = iosSyslogMessage(type, reason, d, port);
  const buffer = message && loggingBuffer(d);
  if (!message || !buffer || message.severity > buffer.level) return;
  const lines = (d.syslogBuffer ??= []);
  lines.push((clock.toFixed(3) + ' ' + message.text).slice(0, 320));
  // Each buffered message costs its text plus the IOS timestamp (about 30 bytes).
  let bytes = lines.reduce((total, line) => total + line.length + 30, 0);
  while (lines.length > 1 && (bytes > buffer.size || lines.length > 2000))
    bytes -= lines.shift()!.length + 30;
}
