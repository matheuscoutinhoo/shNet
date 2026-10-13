import { deviceCapabilities, type Device, type NetworkEvent, type Link } from '@shlab/engine';

export const eventFilters = [
  ['all', 'Todos'],
  ['arp', 'ARP'],
  ['icmp', 'ICMP'],
  ['dhcp', 'DHCP'],
  ['dns', 'DNS'],
  ['tcp', 'TCP'],
  ['ospf', 'OSPF'],
  ['vrrp', 'VRRP'],
  ['lacp', 'LACP'],
  ['ipv6', 'IPv6 / NDP'],
  ['wireless', 'Wi-Fi'],
  ['tunnel', 'VPN / SD-WAN'],
  ['forwarding', 'QoS / MPLS'],
  ['vxlan', 'VXLAN / EVPN'],
  ['aaa', '802.1X / AAA'],
  ['bgp', 'BGP'],
  ['rip', 'RIP'],
  ['management', 'Gerenciamento'],
  ['stp', 'STP'],
  ['policy', 'ACL / NAT'],
  ['ethernet', 'Ethernet'],
  ['drops', 'Descartes'],
] as const;
export type EventFilterId = (typeof eventFilters)[number][0];

export function eventFiltersForSelection(devices: Device[], events: NetworkEvent[], links: Link[]) {
  if (!devices.length) return eventFilters;
  const possible = new Set<EventFilterId>(['all']);
  const selectedIds = new Set(devices.map((d) => d.id));
  for (const d of devices) {
    const c = deviceCapabilities(d);
    if (d.interfaces.some((p) => ['rj45', 'sfp', 'qsfp'].includes(p.media))) {
      possible.add('ethernet');
      possible.add('drops');
    }
    if (!c.active) continue;
    possible.add('drops');
    for (const id of ['arp', 'icmp', 'dhcp', 'dns', 'tcp', 'ipv6', 'management'] as const) possible.add(id);
    if (c.wireless) possible.add('wireless');
    if (c.lacp) possible.add('lacp');
    if (c.vxlan) possible.add('vxlan');
    if (c.switching) possible.add('stp');
    if (c.routing) possible.add('policy');
    if (c.routing || c.switching || d.interfaces.some((p) => !!p.qos)) possible.add('forwarding');
    if (c.aaaKinds.length || c.advancedKinds.some((kind) => kind.startsWith('eap'))) possible.add('aaa');
    if (c.routingProtocols) possible.add('bgp');
    if (c.routingProtocols && d.type === 'router') {
      possible.add('ospf');
      possible.add('rip');
      possible.add('vrrp');
      possible.add('tunnel');
    }
    if (c.sdwanController || d.interfaces.some((p) => !!p.tunnel) || d.sdwan) possible.add('tunnel');
  }
  // Forwarded packets and imported configurations remain inspectable even when
  // the equipment does not originate that protocol (for example OSPF through L2).
  return eventFilters.filter(
    ([id]) =>
      possible.has(id) ||
      events.some((event) => selectedIds.has(event.device) && matchesEventFilter(event, id, links))
  );
}

export function matchesEventFilter(e: NetworkEvent, filter: EventFilterId, links: Link[]): boolean {
  return !!(
    filter === 'all' ||
    (filter === 'aaa'
      ? e.type.startsWith('AAA') ||
        e.type.startsWith('DOT1X') ||
        !!e.frame?.eapol ||
        (e.frame?.packet?.protocol === 'UDP' && e.frame.packet.payload.protocol === 'RADIUS') ||
        (e.frame?.packet?.protocol === 'TCP' &&
          [e.frame.packet.sourcePort, e.frame.packet.destinationPort].includes(49))
      : filter === 'vxlan'
        ? e.type.startsWith('VXLAN') ||
          e.type.startsWith('EVPN') ||
          (e.frame?.packet?.protocol === 'UDP' && e.frame.packet.payload.protocol === 'VXLAN')
        : filter === 'forwarding'
          ? e.type.startsWith('QOS') || e.type.startsWith('MPLS') || !!e.frame?.mpls
          : filter === 'tunnel'
            ? e.type.startsWith('TUNNEL') ||
              e.type.startsWith('SDWAN') ||
              (e.frame?.packet?.protocol === 'UDP' &&
                ['TUNNEL', 'SDWAN'].includes(e.frame.packet.payload.protocol))
            : filter === 'wireless'
              ? e.type.startsWith('WIFI') ||
                !!e.frame?.wifi ||
                (e.link && links.find((l) => l.id === e.link)?.cable === 'wireless')
              : filter === 'ipv6'
                ? e.type.startsWith('IPV6') || e.type.startsWith('NDP') || !!e.frame?.ipv6
                : filter === 'lacp'
                  ? e.type.startsWith('LACP') || !!e.frame?.lacp
                  : filter === 'bgp'
                    ? e.type.startsWith('BGP') ||
                      (e.type.startsWith('ROUTE_') && e.reason.startsWith('BGP')) ||
                      (e.frame?.packet?.protocol === 'TCP' &&
                        [e.frame.packet.sourcePort, e.frame.packet.destinationPort].includes(179))
                    : filter === 'vrrp'
                      ? e.type.startsWith('VRRP') || e.frame?.packet?.protocol === 'VRRP'
                      : filter === 'management'
                        ? e.type.startsWith('REMOTE') ||
                          e.type.startsWith('AUTOMATION') ||
                          e.type.startsWith('TELEMETRY') ||
                          e.type.startsWith('NTP') ||
                          e.type.startsWith('SNMP') ||
                          e.type.startsWith('SYSLOG') ||
                          (e.frame?.packet?.protocol === 'UDP' &&
                            ['SNMP', 'SYSLOG', 'TELEMETRY', 'NTP'].includes(e.frame.packet.payload.protocol))
                        : filter === 'arp'
                          ? e.type.startsWith('ARP')
                          : filter === 'drops'
                            ? e.type === 'PACKET_DROPPED' ||
                              e.type === 'PING_TIMEOUT' ||
                              e.type === 'DNS_FAILED' ||
                              e.type === 'DNS_TIMEOUT' ||
                              e.type === 'TCP_TIMEOUT' ||
                              e.type === 'TCP_RESET'
                            : filter === 'icmp'
                              ? e.frame?.packet?.protocol === 'ICMP' || e.type.startsWith('PING')
                              : filter === 'dhcp'
                                ? e.type.startsWith('DHCP') ||
                                  (e.frame?.packet?.protocol === 'UDP' &&
                                    e.frame.packet.payload.protocol === 'DHCP')
                                : filter === 'dns'
                                  ? e.type.startsWith('DNS') ||
                                    (e.frame?.packet?.protocol === 'UDP' &&
                                      e.frame.packet.payload.protocol === 'DNS')
                                  : filter === 'tcp'
                                    ? e.type.startsWith('TCP') ||
                                      e.type === 'APPLICATION_DATA' ||
                                      e.frame?.packet?.protocol === 'TCP'
                                    : filter === 'ospf'
                                      ? e.type.startsWith('OSPF') ||
                                        (e.type.startsWith('ROUTE_') && e.reason.startsWith('OSPF')) ||
                                        e.frame?.packet?.protocol === 'OSPF'
                                      : filter === 'rip'
                                        ? e.type.startsWith('RIP') ||
                                          (e.type.startsWith('ROUTE_') && e.reason.startsWith('RIP')) ||
                                          (e.frame?.packet?.protocol === 'UDP' &&
                                            e.frame.packet.payload.protocol === 'RIP')
                                        : filter === 'policy'
                                          ? e.type.startsWith('ACL') ||
                                            e.type.startsWith('NAT') ||
                                            e.type.startsWith('FIREWALL')
                                          : filter === 'stp'
                                            ? e.type.startsWith('STP') ||
                                              e.type.startsWith('BPDU') ||
                                              !!e.frame?.bpdu
                                            : e.type === 'MAC_LEARNED' ||
                                              (e.type.startsWith('FRAME') &&
                                                !e.frame?.wifi &&
                                                !e.frame?.secure &&
                                                !e.frame?.meshHello &&
                                                !['wireless', 'mesh'].includes(
                                                  links.find((link) => link.id === e.link)?.cable ?? ''
                                                )))
  );
}
