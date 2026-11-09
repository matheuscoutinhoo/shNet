import type { Device, Frame } from '../model';
import { dottedMac, longInterfaceName } from './interface-name';
import { iosTimestamp } from '../cli/ios-time';
import type { DebugKind } from './debug-model';

// Events that IOS reports as syslog messages, with the severity of the message they map to.
// Events listed without a dedicated translation keep only reasons already worded as IOS messages
// (e.g. %PM-4-ERR_DISABLE, %LINK-3-UPDOWN, %SEC-6-IPACCESSLOGP).
const SYSLOG_EVENTS: Record<string, number> = {
  LINK_DOWN: 3,
  LINK_UP: 3,
  OSPF_NEIGHBOR_CHANGED: 5,
  BGP_STATE_CHANGED: 5,
  VRRP_STATE_CHANGED: 6,
  HSRP_STATE_CHANGED: 5,
  CONFIG_CHANGED: 5,
  ACL_PERMIT: 6,
  ACL_DENY: 6,
  // %BGP-4-MAXPFX and %BGP-3-MAXPFXEXCEED.
  BGP_ROUTE_REJECTED: 4,
  // %FW-6-DROP_PKT of zone-pair classes configured with "drop log".
  FIREWALL_DENY: 6,
  // Drops worded as IOS messages, such as %HSRP-4-BADAUTH.
  PACKET_DROPPED: 4,
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
const title = (state: string) => state[0] + state.slice(1).toLowerCase();
const VRRP_STATES: Record<string, string> = { INIT: 'Init', BACKUP: 'Backup', ACTIVE: 'Master' };
/** The IOS syslog messages an engine event produces (an interface change logs LINK and LINEPROTO). */
export function iosSyslogMessages(
  type: string,
  reason: string,
  d?: Device,
  port?: string
): { severity: number; text: string }[] {
  if (SYSLOG_EVENTS[type] === undefined) return [];
  const own = /^%[\w-]+-(\d)-\w+:/.exec(reason);
  if (own) return [{ severity: Number(own[1]), text: reason }];
  const name = d?.interfaces.find((p) => p.id === port)?.name ?? port ?? '';
  if (type === 'BGP_STATE_CHANGED') {
    const text = bgpAdjacency(d, reason);
    return text ? [{ severity: 5, text: '%BGP-5-ADJCHANGE: ' + text }] : [];
  }
  if (type === 'OSPF_NEIGHBOR_CHANGED') {
    const text = ospfAdjacency(d, reason, port);
    return text ? [{ severity: 5, text: '%OSPF-5-ADJCHG: ' + text }] : [];
  }
  if (type === 'HSRP_STATE_CHANGED') {
    const m = /^HSRP (\d+), VIP \S+: (\w+) → (\w+)\.$/.exec(reason);
    return m
      ? [
          {
            severity: 5,
            text: `%HSRP-5-STATECHANGE: ${longInterfaceName(name)} Grp ${m[1]} state ${title(m[2])} -> ${title(m[3])}`,
          },
        ]
      : [];
  }
  if (type === 'VRRP_STATE_CHANGED') {
    const m = /^VRID (\d+), VIP \S+: (\w+) → (\w+)\.$/.exec(reason);
    return m
      ? [
          {
            severity: 6,
            text: `%VRRP-6-STATECHANGE: ${name} Grp ${m[1]} state ${VRRP_STATES[m[2]] ?? m[2]} -> ${VRRP_STATES[m[3]] ?? m[3]}`,
          },
        ]
      : [];
  }
  // Other simulator wording (power, PoE, spanning-tree internals) is not an IOS message.
  return [];
}
// IOS default: "logging buffered 4096 debugging".
export const DEFAULT_LOG_BUFFER = { size: 4096, level: 7 };
export function loggingBuffer(d: Device) {
  const buffered = d.iosSystem?.logging?.buffered;
  return buffered === false ? undefined : (buffered ?? DEFAULT_LOG_BUFFER);
}
const CONSOLE_LINES = 64;
/**
 * Logs one IOS message: into the circular logging buffer and onto the console (IOS default
 * "logging console debugging"), each at its configured severity.
 */
export function logIos(d: Device, clock: number, severity: number, text: string) {
  const buffer = loggingBuffer(d);
  if (buffer && severity <= buffer.level) {
    const lines = (d.syslogBuffer ??= []);
    lines.push((clock.toFixed(3) + ' ' + text).slice(0, 320));
    // Each buffered message costs its text plus the IOS timestamp (about 30 bytes).
    let bytes = lines.reduce((total, line) => total + line.length + 30, 0);
    while (lines.length > 1 && (bytes > buffer.size || lines.length > 2000))
      bytes -= lines.shift()!.length + 30;
  }
  const console = d.iosSystem?.logging?.console;
  if (console === false || severity > (console ?? 7) || (d.type !== 'router' && d.type !== 'switch')) return;
  const log = (d.consoleLog ??= { sequence: 0, lines: [] });
  log.lines.push((iosTimestamp(clock, !!d.ntp?.synchronized) + ': ' + text).slice(0, 320));
  log.sequence++;
  if (log.lines.length > CONSOLE_LINES) log.lines.shift();
}
/** Stores the syslog messages of an engine event and the debug output it produces. */
export function bufferSyslog(
  d: Device,
  clock: number,
  type: string,
  reason: string,
  details: { port?: string; frame?: Frame } = {}
) {
  for (const message of iosSyslogMessages(type, reason, d, details.port))
    logIos(d, clock, message.severity, message.text);
  if (d.debug?.length) debugEvent(d, clock, type, reason, details);
}
/** One line of "debug" output, when that debugging is on (severity 7, no mnemonic). */
export function debugLog(d: Device, clock: number, kind: DebugKind, text: string) {
  if (d.debug?.includes(kind)) logIos(d, clock, 7, text);
}
const OSPF_ADJ: Record<string, (nbr: string, d: Device) => string[]> = {
  '2-Way': (nbr) => [`2 Way Communication to ${nbr}, state 2WAY`],
  ExStart: (nbr) => [`Nbr ${nbr}: Prepare dbase exchange`],
  Exchange: (nbr, d) => [
    `NBR Negotiation Done. We are the ${ipValue(d.ospf?.routerId ?? '0.0.0.0') > ipValue(nbr) ? 'MASTER' : 'SLAVE'}`,
  ],
  Loading: (nbr) => [`Exchange Done with ${nbr}`],
  Full: (nbr) => [`Synchronized with ${nbr}, state FULL`],
  Down: (nbr) => [`Neighbor ${nbr} is dead, state DOWN`],
};
const ipValue = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
/** Debug output derived from engine events (OSPF adjacencies, HSRP, VRRP, BGP, ARP). */
function debugEvent(
  d: Device,
  clock: number,
  type: string,
  reason: string,
  details: { port?: string; frame?: Frame }
) {
  const name = shortName(d, details.port);
  if (type === 'OSPF_NEIGHBOR_CHANGED') {
    const m = /^([\d.]+)(?: em \S+)?: (\S+) → (\S+?)(?:; .*)?\.$/.exec(reason);
    for (const line of (m && OSPF_ADJ[m[3]]?.(m[1], d)) ?? [])
      debugLog(d, clock, 'ip ospf adj', `OSPF-${d.ospf?.processId ?? 1} ADJ   ${name}: ${line}`);
  } else if (type === 'OSPF_DR_CHANGED') {
    const m = /^(\S+): DR ([\d.]+), BDR ([\d.]+)\.$/.exec(reason);
    if (m) {
      const port = shortName(d, m[1]),
        prefix = `OSPF-${d.ospf?.processId ?? 1} ADJ   ${port}: `;
      for (const line of [
        'DR/BDR election',
        `Elect BDR ${m[3]}`,
        `Elect DR ${m[2]}`,
        `DR: ${m[2]} (Id)   BDR: ${m[3]} (Id)`,
      ])
        debugLog(d, clock, 'ip ospf adj', prefix + line);
    }
  } else if (type === 'HSRP_STATE_CHANGED') {
    const m = /^HSRP (\d+), VIP \S+: (\w+) → (\w+)\.$/.exec(reason);
    if (m) debugLog(d, clock, 'standby', `HSRP: ${name} Grp ${m[1]} ${title(m[2])} -> ${title(m[3])}`);
  } else if (type === 'VRRP_STATE_CHANGED') {
    const m = /^VRID (\d+), VIP \S+: (\w+) → (\w+)\.$/.exec(reason);
    if (m)
      debugLog(
        d,
        clock,
        'vrrp',
        `VRRP: ${name} Grp ${m[1]} state ${VRRP_STATES[m[2]] ?? m[2]} -> ${VRRP_STATES[m[3]] ?? m[3]}`
      );
  } else if (type === 'BGP_STATE_CHANGED') {
    const m = /^([\d.]+): (\S+) → (\S+)\.$/.exec(reason);
    if (m) debugLog(d, clock, 'ip bgp', `BGP: ${m[1]} went from ${m[2]} to ${m[3]}`);
  } else if (
    details.frame?.arp &&
    (type === 'ARP_REQUEST' || type === 'ARP_REPLY' || type === 'ARP_TABLE_UPDATED')
  ) {
    const a = details.frame.arp,
      sent = type !== 'ARP_TABLE_UPDATED',
      target = a.kind === 'request' ? '0000.0000.0000' : dottedMac(details.frame.dst);
    debugLog(
      d,
      clock,
      'arp',
      `IP ARP: ${sent ? 'sent' : 'rcvd'} ${a.kind === 'request' ? 'req' : 'rep'} src ${a.senderIp} ${dottedMac(a.senderMac)}, dst ${a.targetIp}${sent ? ' ' + target : ''} ${name}`
    );
    if (!sent && a.senderIp !== '0.0.0.0')
      debugLog(
        d,
        clock,
        'arp',
        `IP ARP: creating entry for IP address: ${a.senderIp}, hw: ${dottedMac(a.senderMac)}`
      );
  }
}
const shortName = (d: Device, port?: string) => d.interfaces.find((p) => p.id === port)?.name ?? port ?? '';
