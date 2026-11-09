import { z } from 'zod';

/** "debug ..." categories: the show debugging group and the confirmation IOS prints for each. */
export const DEBUG_KINDS = {
  'ip ospf adj': ['IP routing', 'OSPF adjacency debugging is on'],
  'ip bgp': ['IP routing', 'BGP debugging is on for address family: IPv4 Unicast'],
  'ip icmp': ['Generic IP', 'ICMP packet debugging is on'],
  'ip packet': ['Generic IP', 'IP packet debugging is on'],
  'ip nat': ['Generic IP', 'IP NAT debugging is on'],
  arp: ['Generic IP', 'ARP packet debugging is on'],
  'ip dhcp server events': ['DHCP server', 'DHCP server event debugging is on.'],
  'ip dhcp server packet': ['DHCP server', 'DHCP server packet debugging is on.'],
  standby: ['HSRP', 'HSRP debugging is on'],
  vrrp: ['VRRP', 'VRRP debugging is on'],
} as const;
export type DebugKind = keyof typeof DEBUG_KINDS;
export const debugKindSchema = z.enum(Object.keys(DEBUG_KINDS) as [DebugKind, ...DebugKind[]]);
// Recent console output (IOS "logging console"), numbered so that terminals print each line once.
export const consoleLogSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    lines: z.array(z.string().max(320)).max(64),
  })
  .strict();
