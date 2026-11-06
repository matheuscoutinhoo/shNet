import type { Device } from '../model';
import { ipv4Schema } from '../model';
import { ipString, mask, parsePrefix, subnet } from '../protocols/ipv4';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
import { showRoutes, interfaceName } from './operational';
import { rebuildSpanningTree } from '../protocols/stp';

type StaticRoute = Device['routes'][number];
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
/** IOS "ip route" options after the next hop: [distance] [name NAME] [permanent | track N] [tag N]. */
function staticRouteOptions(tokens: string[]) {
  const options: Pick<StaticRoute, 'distance' | 'name' | 'permanent' | 'track' | 'tag'> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i],
      keyword = token.toLowerCase(),
      value = tokens[i + 1];
    const number = (min: number, max: number) => {
      if (!value || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
        throw new Error('Invalid input detected at: ' + (value ?? token));
      i++;
      return Number(value);
    };
    if (i === 0 && /^\d+$/.test(token)) {
      if (Number(token) < 1 || Number(token) > 255) throw new Error('Invalid input detected at: ' + token);
      options.distance = Number(token);
    } else if (keyword === 'name' && value && /^[\x21-\x7e]{1,64}$/.test(value)) {
      options.name = value;
      i++;
    } else if (keyword === 'permanent' && !options.track) options.permanent = true;
    else if (keyword === 'track' && !options.permanent) options.track = number(1, 1000);
    else if (keyword === 'tag') options.tag = number(1, 4294967295);
    else throw new Error('Invalid input detected at: ' + token);
  }
  return options;
}
/** The running-config line of a static route, in IOS syntax order. */
export function staticRouteLine(d: Device, r: StaticRoute) {
  const target = r.discard
    ? 'Null0'
    : r.port
      ? d.interfaces.find((p) => p.id === r.port)!.name + (r.nextHop === '0.0.0.0' ? '' : ' ' + r.nextHop)
      : r.nextHop;
  return (
    'ip route ' +
    (r.vrf ? 'vrf ' + r.vrf + ' ' : '') +
    r.network +
    ' ' +
    ipString(mask(r.prefix)) +
    ' ' +
    target +
    (r.distance !== undefined ? ' ' + r.distance : '') +
    (r.name ? ' name ' + r.name : '') +
    (r.permanent ? ' permanent' : '') +
    (r.track ? ' track ' + r.track : '') +
    (r.tag ? ' tag ' + r.tag : '')
  );
}
export function registerLayer3Commands(r: CommandRegistry) {
  r.register({
    pattern:
      /^(no )?ip route (?:vrf ([\w-]{1,32}) )?((?:\d{1,3}\.){3}\d{1,3})(?:\/(\d{1,2})| ((?:\d{1,3}\.){3}\d{1,3}))(?: (.+))?$/i,
    syntax: [
      'ip route <network> <mask> <next-hop> [distance] [name NAME] [permanent | track N] [tag N]',
      'ip route <network> <mask> <interface> [next-hop] [distance] [name NAME]',
      'ip route <network> <mask> Null0 [distance] [name NAME] [tag N]',
      'ip route vrf <vrf> <network> <mask> <next-hop>',
      'no ip route <network> <mask> [next-hop | interface | Null0]',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      if (!['router', 'switch'].includes(d.type))
        throw new Error('Static routes require a router or a Layer 3 switch.');
      const vrf = m[2];
      if (vrf && !d.vrfs?.includes(vrf)) throw new Error('VRF ' + vrf + ' does not exist.');
      const network = ipv4Schema.parse(m[3]),
        prefix = parsePrefix(m[4] ?? m[5]);
      if (subnet(network, prefix).network !== network) throw new Error('Inconsistent address and mask');
      const tokens = m[6]?.trim().split(/\s+/) ?? [];
      const samePrefix = (route: StaticRoute) =>
        route.vrf === vrf && route.network === network && route.prefix === prefix;
      if (!tokens.length) {
        if (!m[1]) throw new Error('Incomplete command.');
        // "no ip route NETWORK MASK" removes every static route to the prefix.
        if (!d.routes.some(samePrefix)) throw new Error('No matching route to delete');
        d.routes = d.routes.filter((route) => !samePrefix(route));
        return;
      }
      let target: Pick<StaticRoute, 'nextHop' | 'port' | 'discard'>, rest: string[];
      if (IPV4.test(tokens[0])) {
        target = { nextHop: ipv4Schema.parse(tokens[0]) };
        rest = tokens.slice(1);
      } else if (/^null0$/i.test(tokens[0]) || (/^null$/i.test(tokens[0]) && tokens[1] === '0')) {
        target = { nextHop: '0.0.0.0', discard: true };
        rest = tokens.slice(/^null$/i.test(tokens[0]) ? 2 : 1);
      } else {
        // "GigabitEthernet0/1" or "GigabitEthernet 0/1", optionally followed by a next hop.
        const find = (name: string) =>
          d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(name).toLowerCase());
        const split = !find(tokens[0]) && tokens[1] !== undefined && !!find(tokens[0] + tokens[1]);
        const port = split ? find(tokens[0] + tokens[1]) : find(tokens[0]);
        if (!port) throw new Error('Invalid input detected at: ' + tokens[0]);
        if (port.mode !== 'routed' || port.vrf !== vrf)
          throw new Error('Exit interface must be a routed interface in this VRF.');
        rest = tokens.slice(split ? 2 : 1);
        const nextHop = rest[0] && IPV4.test(rest[0]) ? ipv4Schema.parse(rest.shift()) : '0.0.0.0';
        target = { nextHop, port: port.id };
      }
      const same = (route: StaticRoute) =>
        samePrefix(route) &&
        route.nextHop === target.nextHop &&
        // "no ip route NETWORK MASK NEXT-HOP" also matches the routes that name an exit interface.
        (route.port === target.port || (m[1] && !target.port && !target.discard)) &&
        !!route.discard === !!target.discard;
      if (m[1]) {
        if (!d.routes.some(same)) throw new Error('No matching route to delete');
        d.routes = d.routes.filter((route) => !same(route));
        return;
      }
      const options = staticRouteOptions(rest);
      const routes = d.routes.filter((route) => !same(route));
      if (routes.length >= 256) throw new Error('Route limit reached.');
      d.routes = [
        ...routes,
        {
          network,
          prefix,
          ...target,
          metric: 1,
          ...(vrf ? { vrf } : {}),
          ...options,
        } as StaticRoute,
      ];
    },
  });
  r.register({
    pattern: /^no interface (\S+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const port = d.interfaces.find((p) => p.name.toLowerCase() === m[1].toLowerCase());
      if (!port) throw new Error('Interface inexistente.');
      e.removeLogicalInterface(d.id, port.id);
    },
  });
  r.register({
    pattern: /^(no )?ip routing$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      if (d.type !== 'switch') throw new Error('ip routing configura a stack L3 do switch.');
      d.ipRouting = !m[1];
      e.emit('CONFIG_CHANGED', d.id, 'Roteamento L3 ' + (d.ipRouting ? 'ativo.' : 'desligado.'));
    },
  });
  r.register({
    pattern: /^(no )?vrf definition ([\w-]{1,32})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d, c) => {
      e.configureVrf(d.id, m[2], !!m[1]);
      if (!m[1]) {
        c.mode = 'vrf';
        c.vrf = m[2];
        delete c.router;
      }
    },
  });
  r.register({
    pattern: /^address-family (ipv4|ipv6)(?: unicast)?$/i,
    syntax: ['address-family ipv4', 'address-family ipv6'],
    modes: ['vrf'],
    run: (_m, _e, _d, c) => {
      c.mode = 'address-family';
    },
  });
  r.register({
    pattern: /^(?:ip )?vrf forwarding ([\w-]{1,32})$/i,
    modes: ['interface'],
    run: (m, e, d, c) => e.setInterfaceVrf(d.id, currentPort(d, c).id, m[1]),
  });
  r.register({
    pattern: /^no (?:ip )?vrf forwarding$/i,
    modes: ['interface'],
    run: (_m, e, d, c) => e.setInterfaceVrf(d.id, currentPort(d, c).id),
  });
  r.register({
    pattern: /^encapsulation dot1q (\d+)$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const port = currentPort(d, c),
        vlan = Number(m[1]);
      if (port.logical?.kind !== 'subinterface' || vlan < 1 || vlan > 4094)
        throw new Error('dot1q exige subinterface e VLAN válida.');
      port.logical.vlan = vlan;
    },
  });
  r.register({
    pattern: /^no switchport$/i,
    modes: ['interface'],
    run: (_m, e, d, c) => {
      const port = currentPort(d, c);
      if (d.type !== 'switch' || port.logical) throw new Error('Use uma porta física do switch.');
      port.mode = 'routed';
      delete port.spanningTree;
      delete port.spanningInstances;
      if (d.spanningTree?.enabled) rebuildSpanningTree(e, d);
    },
  });
  r.register({
    pattern: /^show vrf$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      (d.vrfs ?? [])
        .map(
          (v) =>
            v +
            ': ' +
            d.interfaces
              .filter((p) => p.vrf === v)
              .map((p) => p.name)
              .join(', ')
        )
        .join('\n') || 'Nenhuma VRF',
  });
  r.register({
    pattern: /^show ip route vrf ([\w-]{1,32})$/i,
    modes: ALL_MODES,
    run: (m, e, d) => {
      if (!d.vrfs?.includes(m[1])) throw new Error('VRF inexistente.');
      return showRoutes(e, d, m[1]);
    },
  });
  r.register({
    pattern: /^http get vrf ([\w-]{1,32}) ([\d.]+)(?: (\d+))?(?: (\/\S*))?$/i,
    modes: ALL_MODES,
    run: (m, e, d) =>
      'HTTP enfileirado [' + e.httpGet(d.id, m[2], Number(m[3] ?? 80), m[4] ?? '/', m[1]) + '].',
  });
}
export function layer3RunningConfig(d: Device) {
  return [
    ...(d.vrfs ?? []).flatMap((v) => ['vrf definition ' + v, 'exit']),
    ...(d.type === 'switch' && d.ipRouting ? ['ip routing'] : []),
  ];
}
