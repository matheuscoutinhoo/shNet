import type { Device } from '../model';
import { ipv4Schema } from '../model';
import { parsePrefix, subnet } from '../protocols/ipv4';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
import { showRoutes, interfaceName } from './operational';
import { rebuildSpanningTree } from '../protocols/stp';
export function registerLayer3Commands(r: CommandRegistry) {
  r.register({
    pattern:
      /^(no )?ip route (?:vrf ([\w-]{1,32}) )?([\d.]+) ([\d.]+) ([a-z][\w/.-]*)(?: ((?:\d{1,3}\.){3}\d{1,3}))?(?: (\d+))?(?: track (\d+))?$/i,
    syntax: [
      'ip route <network> <mask> <interface>',
      'ip route <network> <mask> <interface> <next-hop> <distance>',
      'ip route <network> <mask> <interface> <distance>',
    ],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      const network = ipv4Schema.parse(m[3]),
        prefix = parsePrefix(m[4]),
        p = d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(m[5]).toLowerCase()),
        distance = m[7] ? Number(m[7]) : undefined;
      if (
        !['router', 'switch'].includes(d.type) ||
        !p ||
        p.mode !== 'routed' ||
        p.vrf !== m[2] ||
        (m[2] && !d.vrfs?.includes(m[2]))
      )
        throw new Error('Exit interface must be a routed interface in this VRF.');
      if (subnet(network, prefix).network !== network) throw new Error('Network must align to its mask.');
      if (distance !== undefined && (distance < 1 || distance > 255))
        throw new Error('Administrative distance must be between 1 and 255.');
      const nextHop = m[6] ? ipv4Schema.parse(m[6]) : '0.0.0.0';
      d.routes = d.routes.filter(
        (r) =>
          !(
            r.vrf === m[2] &&
            r.network === network &&
            r.prefix === prefix &&
            r.port === p.id &&
            r.nextHop === nextHop
          )
      );
      if (!m[1]) {
        if (d.routes.length >= 256) throw new Error('Route limit reached.');
        d.routes.push({
          network,
          prefix,
          nextHop,
          metric: 1,
          port: p.id,
          ...(m[2] ? { vrf: m[2] } : {}),
          ...(distance !== undefined ? { distance } : {}),
          ...(m[8] ? { track: Number(m[8]) } : {}),
        });
      }
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
    pattern: /^(no )?ip route vrf ([\w-]{1,32}) ([\d.]+)(?:\/|\s+)([\d.]+) ([\d.]+)(?: (\d+))?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      if (!d.vrfs?.includes(m[2])) throw new Error('VRF inexistente.');
      const network = ipv4Schema.parse(m[3]),
        prefix = parsePrefix(m[4]),
        nextHop = ipv4Schema.parse(m[5]);
      if (subnet(network, prefix).network !== network) throw new Error('Rede desalinhada ao prefixo.');
      d.routes = d.routes.filter(
        (p) => !(p.vrf === m[2] && p.network === network && p.prefix === prefix && p.nextHop === nextHop)
      );
      if (!m[1]) {
        if (d.routes.length >= 256) throw new Error('Limite de rotas.');
        const distance = m[6] ? Number(m[6]) : undefined;
        if (distance !== undefined && (distance < 1 || distance > 255))
          throw new Error('Administrative distance must be between 1 and 255.');
        d.routes.push({
          network,
          prefix,
          nextHop,
          metric: 1,
          vrf: m[2],
          ...(distance !== undefined ? { distance } : {}),
        });
      }
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
    pattern: /^ping vrf ([\w-]{1,32}) ([\d.]+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => 'ICMP enfileirado [' + e.ping(d.id, m[2], 64, m[1]) + '].',
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
