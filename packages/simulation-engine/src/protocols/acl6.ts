import type { SimulationEngine } from '../core/engine';
import type { Device, Frame, NetworkInterface, Packet6 } from '../model';
import type { acl6EntrySchema } from './ipv6-model';
import { sameSubnet6 } from './ipv6-address';
import type { z } from 'zod';

export type Acl6Entry = z.infer<typeof acl6EntrySchema>;
type PortMatch = NonNullable<Acl6Entry['sourcePort']>;

const ICMP_KINDS: Record<string, string> = {
  'echo-request': 'echo-request',
  'echo-reply': 'echo-reply',
  ns: 'nd-ns',
  na: 'nd-na',
  rs: 'router-solicitation',
  ra: 'router-advertisement',
  unreachable: 'unreachable',
  'time-exceeded': 'time-exceeded',
  'packet-too-big': 'packet-too-big',
};
function portMatches(match: PortMatch | undefined, port: number | undefined) {
  if (!match) return true;
  if (port === undefined) return false;
  switch (match.op) {
    case 'eq':
      return port === match.port;
    case 'neq':
      return port !== match.port;
    case 'gt':
      return port > match.port;
    case 'lt':
      return port < match.port;
    case 'range':
      return port >= match.port && port <= (match.end ?? match.port);
  }
}
function ports(packet: Packet6): [number?, number?] {
  if (packet.protocol === 'TCP') return [packet.segment.sourcePort, packet.segment.destinationPort];
  if (packet.protocol === 'UDP') return [packet.datagram.sourcePort, packet.datagram.destinationPort];
  return [];
}
export function acl6Matches(rule: Acl6Entry, packet: Packet6) {
  if (!sameSubnet6(packet.src, rule.source, rule.sourcePrefix)) return false;
  if (!sameSubnet6(packet.dst, rule.destination, rule.destinationPrefix)) return false;
  switch (rule.protocol) {
    case 'ipv6':
      return true;
    case 'ospf':
      return packet.protocol === 'OSPFv3';
    case 'icmp':
      return packet.protocol === 'ICMPv6' && (!rule.icmpType || ICMP_KINDS[packet.kind] === rule.icmpType);
    case 'tcp':
    case 'udp': {
      if (packet.protocol !== rule.protocol.toUpperCase()) return false;
      const [source, destination] = ports(packet);
      if (!portMatches(rule.sourcePort, source) || !portMatches(rule.destinationPort, destination))
        return false;
      // "established": a TCP segment with ACK or RST, i.e. not the opening SYN.
      if (rule.established && packet.protocol === 'TCP')
        return packet.segment.flags.some((f) => f === 'ACK' || f === 'RST');
      return true;
    }
  }
}
/**
 * IOS "ipv6 traffic-filter": a named IPv6 ACL applied to the interface. Returns undefined when no
 * named filter is configured for the direction. Like IOS, a filter naming an ACL that does not
 * exist permits everything, and every list ends with the implicit
 * "permit icmp any any nd-na", "permit icmp any any nd-ns" and "deny ipv6 any any".
 */
export function filter6(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  direction: 'in' | 'out',
  packet: Packet6
): boolean | undefined {
  const name = direction === 'in' ? p.ipv6FilterIn : p.ipv6FilterOut;
  if (!name) return undefined;
  const list = d.ipv6AccessLists?.find((a) => a.name === name);
  if (!list) return true;
  const rule = list.rules.find((r) => acl6Matches(r, packet));
  if (rule) rule.hits++;
  if (rule?.log) {
    const [sp, dp] = ports(packet),
      verb = rule.action === 'permit' ? 'permitted' : 'denied',
      protocol =
        packet.protocol === 'OSPFv3' ? '89' : packet.protocol.replace('ICMPv6', 'icmp').toLowerCase();
    e.emit(
      rule.action === 'permit' ? 'ACL_PERMIT' : 'ACL_DENY',
      d.id,
      `%IPV6_ACL-6-ACCESSLOGP: list ${name}/${rule.sequence} ${verb} ${protocol} ${packet.src}${sp !== undefined ? '(' + sp + ')' : ''} -> ${packet.dst}${dp !== undefined ? '(' + dp + ')' : ''}, 1 packet`,
      { port: p.id }
    );
  }
  if (rule?.action === 'permit') return true;
  if (!rule && packet.protocol === 'ICMPv6' && (packet.kind === 'ns' || packet.kind === 'na')) return true;
  const frame: Frame = { src: p.mac, dst: p.mac, etherType: 'IPv6', ipv6: packet, hops: 1 };
  const reason =
    `IPv6 ACL ${name} ${direction}: ` +
    (rule ? `sequence ${rule.sequence} deny` : 'implicit deny ipv6 any any') +
    '.';
  if (!rule?.log) e.emit('ACL_DENY', d.id, reason, { port: p.id, frame });
  e.drop(d, reason, p.id, frame);
  return false;
}
