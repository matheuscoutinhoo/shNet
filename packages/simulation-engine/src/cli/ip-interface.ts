import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface } from '../model';
import { interfaceOperational, routingEnabled } from '../protocols/layer3';
import { eigrpPorts } from '../protocols/eigrp';
import { findInterface, longInterfaceName } from '../protocols/interface-name';
import { ALL_MODES, currentPort, type CommandRegistry } from './registry';
import { interfaceStatus } from './operational';

/** IOS "show ip interface [NAME]": addressing, filters, helpers, NAT and uRPF of each interface. */
function showIpInterface(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const admin = interfaceStatus(e, d, p),
    protocol = admin === 'up' && (p.iosTunnel || interfaceOperational(e.state, d, p)) ? 'up' : 'down';
  const head = `${longInterfaceName(p.name)} is ${admin}, line protocol is ${protocol}`;
  if (!p.ip || p.prefix === undefined) return head + '\n  Internet protocol processing disabled';
  const helpers = p.dhcpRelay ?? [];
  const groups = [
    ...(d.ospf?.enabled && d.ospf.interfaces.some((i) => i.port === p.id) ? ['224.0.0.5', '224.0.0.6'] : []),
    ...(eigrpPorts(d).some((x) => x.id === p.id) ? ['224.0.0.10'] : []),
    ...(d.vrrp?.groups.some((g) => g.port === p.id) ? ['224.0.0.18'] : []),
    ...(d.hsrp?.groups.some((g) => g.port === p.id) ? ['224.0.0.2'] : []),
  ];
  const u = p.urpf;
  return [
    head,
    `  Internet address is ${p.ip}/${p.prefix}`,
    `  Broadcast address is 255.255.255.255`,
    '  Address determined by non-volatile memory',
    `  MTU is ${p.mtu} bytes`,
    helpers.length > 1
      ? '  Helper addresses are ' + helpers.join('\n                       ')
      : '  Helper address is ' + (helpers[0] ?? 'not set'),
    '  Directed broadcast forwarding is disabled',
    ...(groups.length ? ['  Multicast reserved groups joined: ' + groups.join(' ')] : []),
    ...(p.vrf ? [`  VPN Routing/Forwarding "${p.vrf}"`] : []),
    '  Outgoing Common access list is not set',
    '  Outgoing access list is ' + (p.aclOut ?? 'not set'),
    '  Inbound Common access list is not set',
    '  Inbound  access list is ' + (p.aclIn ?? 'not set'),
    '  Proxy ARP is ' + (routingEnabled(d) && p.proxyArp !== false ? 'enabled' : 'disabled'),
    '  Local Proxy ARP is disabled',
    '  Security level is default',
    '  Split horizon is enabled',
    '  ICMP redirects are always sent',
    '  ICMP unreachables are always sent',
    '  ICMP mask replies are never sent',
    '  IP fast switching is enabled',
    '  IP Flow switching is disabled',
    '  IP CEF switching is enabled',
    '  IP route-cache flags are Fast, CEF',
    '  Router Discovery is disabled',
    '  IP output packet accounting is disabled',
    '  IP access violation accounting is disabled',
    '  TCP/IP header compression is disabled',
    '  RTP/IP header compression is disabled',
    '  Policy routing is disabled',
    p.natRole
      ? `  Network address translation is enabled, interface in domain ${p.natRole}`
      : '  Network address translation is disabled',
    '  BGP Policy Mapping is disabled',
    `  Input features: ${u ? 'Verify Unicast Reverse-Path, ' : ''}MCI Check`,
    ...(u
      ? [
          `  IP verify source reachable-via ${u.mode.toUpperCase()}${u.allowDefault ? ', allow default' : ''}`,
          `   ${p.urpfDrops ?? 0} verification drops`,
          '   0 suppressed verification drops',
          '   0 verification drop-rate',
        ]
      : []),
  ].join('\n');
}
const listed = (p: NetworkInterface) => !['console', 'wifi', 'mesh'].includes(p.media);

export function registerIpInterfaceCommands(r: CommandRegistry) {
  r.register({
    pattern:
      /^(no )?ip verify unicast (?:source reachable-via (rx|any)(?: (allow-default))?|reverse-path)(?: \d+)?$/i,
    syntax: [
      'ip verify unicast source reachable-via rx [allow-default]',
      'ip verify unicast source reachable-via any [allow-default]',
      'ip verify unicast reverse-path',
    ],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (d.type !== 'router' && !(d.type === 'switch' && p.mode === 'routed'))
        throw new Error("% Invalid input detected at '^' marker.");
      if (m[1]) {
        delete p.urpf;
        delete p.urpfDrops;
        return;
      }
      // "reverse-path" is the older form of strict mode.
      p.urpf = {
        mode: (m[2]?.toLowerCase() as 'rx' | 'any' | undefined) ?? 'rx',
        ...(m[3] ? { allowDefault: true } : {}),
      };
    },
  });
  r.register({
    pattern: /^(no )?ip proxy-arp$/i,
    syntax: ['ip proxy-arp', 'no ip proxy-arp'],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (d.type !== 'router' && d.type !== 'switch')
        throw new Error("% Invalid input detected at '^' marker.");
      if (m[1]) p.proxyArp = false;
      else delete p.proxyArp;
    },
  });
  r.register({
    pattern: /^show ip interface(?: (?!brief$)(.+))?$/i,
    syntax: 'show ip interface [interface]',
    modes: ALL_MODES,
    run: (m, e, d) => {
      if (m[1]) {
        const p = findInterface(d, m[1].trim());
        if (!p) throw new Error("% Invalid input detected at '^' marker.");
        return showIpInterface(e, d, p);
      }
      return d.interfaces
        .filter(listed)
        .map((p) => showIpInterface(e, d, p))
        .join('\n');
    },
  });
}
/** uRPF and proxy ARP lines of an interface block in running-config. */
export function urpfRunningConfig(p: NetworkInterface) {
  return [
    ...(p.urpf
      ? [
          ` ip verify unicast source reachable-via ${p.urpf.mode}${p.urpf.allowDefault ? ' allow-default' : ''}`,
        ]
      : []),
    ...(p.proxyArp === false ? [' no ip proxy-arp'] : []),
  ];
}
