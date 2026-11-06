import type { Device } from '../model';

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
};
/** The IOS syslog message an engine event produces, if any. */
export function iosSyslogMessage(type: string, reason: string) {
  const kind = SYSLOG_EVENTS[type];
  if (!kind) return;
  const own = /^%[\w-]+-(\d)-\w+:/.exec(reason);
  if (own) return { severity: Number(own[1]), text: reason };
  return kind[1] ? { severity: kind[0], text: '%' + kind[1] + ': ' + reason } : undefined;
}
// IOS default: "logging buffered 4096 debugging".
export const DEFAULT_LOG_BUFFER = { size: 4096, level: 7 };
export function loggingBuffer(d: Device) {
  const buffered = d.iosSystem?.logging?.buffered;
  return buffered === false ? undefined : (buffered ?? DEFAULT_LOG_BUFFER);
}
/** Stores a syslog message in the circular logging buffer; the oldest messages give way when full. */
export function bufferSyslog(d: Device, clock: number, type: string, reason: string) {
  const message = iosSyslogMessage(type, reason);
  const buffer = message && loggingBuffer(d);
  if (!message || !buffer || message.severity > buffer.level) return;
  const lines = (d.syslogBuffer ??= []);
  lines.push((clock.toFixed(3) + ' ' + message.text).slice(0, 320));
  // Each buffered message costs its text plus the IOS timestamp (about 30 bytes).
  let bytes = lines.reduce((total, line) => total + line.length + 30, 0);
  while (lines.length > 1 && (bytes > buffer.size || lines.length > 2000))
    bytes -= lines.shift()!.length + 30;
}
