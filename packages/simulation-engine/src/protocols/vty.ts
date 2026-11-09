import type { Device } from '../model';
import type { IosLine } from './ios-system-model';
import type { TcpPacket } from './tcp-model';
import { matchingAclRule } from './acl';

/** Telnet (TCP 23) and SSH (TCP 22) sessions to the VTY lines of IOS routers and switches. */
export type VtyTransport = 'ssh' | 'telnet';
export const vtyTransport = (port: number): VtyTransport | undefined =>
  port === 22 ? 'ssh' : port === 23 ? 'telnet' : undefined;
// IOS XE always has "line vty 0 4" (and 5 15 on switches); unconfigured lines accept Telnet and SSH
// with "login" and no password.
export function vtyLines(d: Device): IosLine[] {
  const lines = d.iosSystem?.lines?.filter((l) => l.kind === 'vty') ?? [];
  const blocks: [number, number][] =
    d.type === 'switch'
      ? [
          [0, 4],
          [5, 15],
        ]
      : [[0, 4]];
  const defaults = blocks
    .filter(([first, last]) => !lines.some((l) => l.first <= last && l.last >= first))
    .map(([first, last]): IosLine => ({ kind: 'vty', first, last }));
  return [...lines, ...defaults].sort((a, b) => a.first - b.first);
}
export const lineAccepts = (line: IosLine, transport: VtyTransport) =>
  !line.transportInput || line.transportInput.includes('all') || line.transportInput.includes(transport);
/** The VTY line a new session lands on: the first one that accepts the transport. */
export const vtyLineFor = (d: Device, transport: VtyTransport) =>
  vtyLines(d).find((l) => lineAccepts(l, transport));
/** The SSH server runs once an RSA key pair exists ("crypto key generate rsa"). */
export const sshServerEnabled = (d: Device) => !!d.iosSystem?.rsaModulus;
const vtyCount = (d: Device, transport: VtyTransport) =>
  vtyLines(d)
    .filter((l) => lineAccepts(l, transport))
    .reduce((n, l) => n + l.last - l.first + 1, 0);
/**
 * Whether the device accepts this Telnet/SSH SYN: an IOS device with the server running, a free
 * VTY line whose "transport input" allows the protocol and whose "access-class" permits the source.
 * Anything else is refused with a TCP reset, like IOS.
 */
export function vtyAccepts(d: Device, packet: TcpPacket) {
  const transport = vtyTransport(packet.destinationPort);
  if (!transport || !d.power || (d.type !== 'router' && d.type !== 'switch')) return false;
  if (transport === 'ssh' && !sshServerEnabled(d)) return false;
  const line = vtyLineFor(d, transport);
  if (!line) return false;
  const open = (d.tcpConnections ?? []).filter(
    (c) => c.service === 'vty' && c.role === 'server' && !['CLOSED', 'RESET', 'TIMED-OUT'].includes(c.state)
  ).length;
  if (open >= vtyCount(d, transport)) return false;
  const acl = line.accessClass && d.accessLists?.find((a) => a.name === line.accessClass!.acl);
  if (acl && packet.family !== 6) {
    const rule = matchingAclRule(d, acl.name, packet);
    if (rule) rule.hits++;
    else acl.implicitDrops++;
    if (rule?.action !== 'permit') return false;
  }
  return true;
}
