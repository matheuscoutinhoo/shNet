import type { Device } from '../model';
import { ipv4Schema } from '../model';
import { parsePrefix, subnet } from '../protocols/ipv4';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
export function registerLayer3Commands(r: CommandRegistry) {
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
    run: (m, e, d) => e.configureVrf(d.id, m[2], !!m[1]),
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
      if (d.spanningTree?.enabled)
        e.configureSpanningTree(d.id, d.spanningTree.mode, d.spanningTree.priority);
    },
  });
  r.register({
    pattern: /^(no )?ip route vrf ([\w-]{1,32}) ([\d.]+)(?:\/|\s+)([\d.]+) ([\d.]+)$/i,
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
        d.routes.push({ network, prefix, nextHop, metric: 1, vrf: m[2] });
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
    run: (m, _e, d) => {
      if (!d.vrfs?.includes(m[1])) throw new Error('VRF inexistente.');
      return (
        [
          ...d.interfaces
            .filter((p) => p.vrf === m[1] && p.ip)
            .map((p) => `C ${subnet(p.ip!, p.prefix!).network}/${p.prefix}, ${p.name}`),
          ...d.routes.filter((p) => p.vrf === m[1]).map((p) => `S ${p.network}/${p.prefix} via ${p.nextHop}`),
        ].join('\n') || 'Nenhuma rota'
      );
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
    ...(d.vrfs ?? []).map((v) => 'vrf definition ' + v),
    ...(d.type === 'switch' && d.ipRouting ? ['ip routing'] : []),
  ];
}
