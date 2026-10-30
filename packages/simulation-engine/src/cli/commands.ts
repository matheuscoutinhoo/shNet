import { registerHostCommands } from './host';
import { deviceCommandHelp, terminalIdentity } from './device-commands';
import { registerApplicationCommands } from './applications';
import type { NetworkInterface } from '../model';
import { registerRemoteCommands, remoteRunningConfig } from './remote';
import { registerAaaCommands, aaaRunningConfig } from './aaa';
import { registerVxlanCommands, vxlanRunningConfig } from './vxlan';
import { registerForwardingCommands, forwardingRunningConfig } from './forwarding';
import { registerTunnelCommands, tunnelRunningConfig } from './tunnel';
import { registerWirelessCommands, wirelessRunningConfig } from './wireless';
import { registerIpv6Commands, ipv6RunningConfig } from './ipv6';
import { registerLayer3Commands, layer3RunningConfig } from './layer3';
import { registerLacpCommands, lacpRunningConfig } from './lacp';
import { registerBgpCommands, bgpRunningConfig } from './bgp';
import { registerVrrpCommands, vrrpRunningConfig } from './vrrp';
import { registerStateSyncCommands, stateSyncRunningConfig } from './state-sync';
import { ALL_MODES, CONFIG_MODES, CommandRegistry, currentPort, type Mode } from './registry';
import { ipv4Schema } from '../model';
import { parsePrefix, subnet, ipString, mask } from '../protocols/ipv4';
import { dhcpRunningConfig, registerDhcpCommands } from './dhcp';
import { dnsRunningConfig, registerDnsCommands } from './dns';
import { registerStpCommands, stpRunningConfig } from './stp';
import { registerPolicyCommands, policyRunningConfig } from './policy';
import { registerTcpCommands, tcpRunningConfig } from './tcp';
import { registerOspfCommands, ospfRunningConfig } from './ospf';
import { registerRipCommands, ripRunningConfig } from './rip';
import { interfaceOperational } from '../protocols/layer3';
import { syncPvstInstances } from '../protocols/stp';
import { hardwareSpeed } from '../links/physical';
import { registerManagementCommands, managementRunningConfig } from './management';
import { clearArpPending } from '../protocols/arp';
import { interfaceName, showInterfaces, showInterfacesDescription, showInterfacesStatus, showRoutes } from './operational';
import { saveStartup, reloadLosesChanges } from './startup';
import { registerDiscoveryCommands, discoveryRunningConfig } from './discovery';
import { registerHsrpCommands, hsrpRunningConfig } from './hsrp';
import { registerLocalSecurityCommands } from './local-security';
import { registerCampusCommands, campusRunningConfig } from './campus';
import { registerIosOperations, iosSystemRunning } from './ios-operations';
import { registerMonitoring, monitoringRunning } from './monitoring';
import { registerRoutingPolicy, routingPolicyRunning } from './routing-policy';
import { registerMqc, mqcDefinitions, mqcAttachments } from './mqc';
import { showVlan } from './ios-show';
import { registerPingCommands } from './ping';
const all = ALL_MODES;
const config = CONFIG_MODES;
const privileged: Mode[] = ['privileged', ...config];
function vlanId(value: string) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4094) throw new Error('VLAN deve estar entre 1 e 4094');
  return n;
}
function vlanList(value: string) {
  const list = value.split(',').flatMap((s) => {
    const parts = s.split('-');
    const a = vlanId(parts[0]),
      b = parts[1] ? vlanId(parts[1]) : a;
    if (b < a) throw new Error('Intervalo de VLAN inválido');
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
  return [...new Set(list)];
}
export function makeRegistry() {
  const r = new CommandRegistry();
  registerHostCommands(r);
  registerDiscoveryCommands(r);
  registerHsrpCommands(r);
  registerLocalSecurityCommands(r);
  registerCampusCommands(r);
  registerIosOperations(r);
  registerMonitoring(r);
  registerRoutingPolicy(r);
  registerMqc(r);
  registerRemoteCommands(r);
  registerApplicationCommands(r);
  registerAaaCommands(r);
  registerWirelessCommands(r);
  registerTunnelCommands(r);
  registerForwardingCommands(r);
  registerVxlanCommands(r);
  registerIpv6Commands(r);
  registerLayer3Commands(r);
  registerLacpCommands(r);
  registerDhcpCommands(r);
  registerDnsCommands(r);
  registerStpCommands(r);
  registerPolicyCommands(r);
  registerTcpCommands(r);
  registerOspfCommands(r);
  registerRipCommands(r);
  registerVrrpCommands(r);
  registerStateSyncCommands(r);
  registerBgpCommands(r);
  registerManagementCommands(r);
  r.register({
    pattern: /^(help|\?)$/i,
    modes: all,
    run: (_m, _e, d, c) =>
      [
        terminalIdentity(d).family + ' · ' + terminalIdentity(d).name + ' · terminal simulado',
        'Os comandos atuam somente neste laboratório. Use as abas do equipamento para configuração guiada.',
        ...deviceCommandHelp(d, c).map(
          (entry) => entry.command + '\n  ' + entry.description + '\n  Exemplo: ' + entry.example
        ),
      ].join('\n'),
  });
  r.register({
    pattern: /^enable$/i,
    modes: ['user', 'privileged'],
    run: (_m, _e, d, c) => {
      if (c.mode === 'user' && d.enableSecret) {
        c.auth = { kind: 'enable', attempts: 0 };
        return;
      }
      c.mode = 'privileged';
    },
  });
  r.register({
    pattern: /^disable$/i,
    modes: ['privileged'],
    run: (_m, _e, _d, c) => {
      c.mode = 'user';
    },
  });
  r.register({
    pattern: /^(configure terminal|conf t)$/i,
    syntax: 'configure terminal',
    modes: privileged,
    run: (_m, _e, _d, c) => {
      c.mode = 'config';
    },
  });
  r.register({
    pattern: /^end$/i,
    modes: config,
    run: (_m, _e, _d, c) => {
      c.mode = 'privileged';
    },
  });
  r.register({
    pattern: /^exit$/i,
    modes: all,
    run: (_m, _e, _d, c) => {
      c.mode =
        c.mode==='key-chain-key'?'key-chain':c.mode === 'policy-class'
          ? 'policy-map'
          : c.mode === 'address-family'
            ? c.vrf
              ? 'vrf'
              : 'router'
            : config.includes(c.mode) && c.mode !== 'config'
              ? 'config'
              : c.mode === 'config'
                ? 'privileged'
                : 'user';
    },
  });
  r.register({
    pattern: /^hostname ([a-z0-9][a-z0-9_-]{0,31})$/i,
    modes: config,
    run: (m, _e, d) => {
      d.hostname = m[1];
    },
  });
  r.register({
    pattern: /^interface range (.+)$/i,
    syntax: 'interface range <interfaces...>',
    modes: config,
    run: (m, _e, d, c) => {
      const selected = new Set<string>();
      for (const group of m[1].split(',')) {
        const normalized = interfaceName(group.trim());
        // The optional end prefix must start with a non-digit; otherwise "Gi0/1-20" splits 20 into 2+0.
        const range = /^(.*?)(\d+)-(?:(\D.*?))?(\d+)$/.exec(normalized);
        if (range) {
          const first = Number(range[2]),
            last = Number(range[4]);
          if (
            last < first ||
            last - first > 48 ||
            (range[3] && interfaceName(range[3]).toLowerCase() !== range[1].toLowerCase())
          )
            throw new Error('Invalid interface range');
          for (let n = first; n <= last; n++) {
            const p = d.interfaces.find((p) => p.name.toLowerCase() === (range[1] + n).toLowerCase());
            if (!p) throw new Error('Interface inexistente: ' + range[1] + n);
            selected.add(p.id);
          }
        } else {
          const p = d.interfaces.find((p) => p.name.toLowerCase() === normalized.toLowerCase());
          if (!p) throw new Error('Interface inexistente: ' + normalized);
          selected.add(p.id);
        }
      }
      c.port = [...selected][0];
      c.ports = [...selected];
      c.mode = 'interface';
    },
  });
  r.register({
    pattern: /^interface\s+(.+)$/i,
    syntax: 'interface <interface>',
    modes: config,
    run: (m, e, d, c) => {
      const name = interfaceName(m[1]);
      let p = d.interfaces.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!p && /^Vlan\d+$/i.test(name)) p = e.addSvi(d.id, Number(name.slice(4)));
      if (!p && /^Loopback\d+$/i.test(name)) p = e.addLoopback(d.id, Number(name.slice(8)));
      if (!p && /^.+\.\d+$/.test(name)) {
        const [parentName, vlan] = name.split('.');
        const parent = d.interfaces.find((p) => p.name.toLowerCase() === parentName.toLowerCase());
        if (parent) p = e.addSubinterface(d.id, parent.id, Number(vlan));
      }
      if (!p) throw new Error('Interface inexistente');
      c.port = p.id;
      delete c.ports;
      c.mode = 'interface';
    },
  });
  r.register({
    pattern: /^(no )?shutdown$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      e.setPort(d.id, currentPort(d, c).id, !!m[1]);
    },
  });
  r.register({
    pattern: /^no description$/i,
    syntax: 'no description',
    modes: ['interface'],
    run: (_m, _e, d, c) => {
      currentPort(d, c).description = '';
    },
  });
  r.register({
    pattern: /^description (.{1,160})$/i,
    syntax: 'description <text...>',
    modes: ['interface'],
    run: (m, _e, d, c) => {
      currentPort(d, c).description = m[1];
    },
  });
  r.register({
    pattern: /^duplex (full|half)$/i,
    syntax: ['duplex full', 'duplex half'],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      currentPort(d, c).duplex = m[1].toLowerCase() as NetworkInterface['duplex'];
    },
  });
  r.register({
    pattern: /^(no )?speed(?: (auto|100|1000|10000|40000|100000))?$/i,
    syntax: ['speed <mbps>', 'speed auto', 'no speed'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        value = m[2]?.toLowerCase();
      if (!m[1] && !value) throw new Error('Incomplete command.');
      const hardware = hardwareSpeed(p);
      if (m[1] || value === 'auto') {
        delete p.speedAuto;
        delete p.maxSpeed;
        p.speed = hardware;
      } else {
        const speed = Number(value) as NetworkInterface['speed'];
        p.speedAuto = false;
        p.speed = speed;
        if (p.media === 'rj45' && speed < hardware) p.maxSpeed = hardware;
        else delete p.maxSpeed;
      }
      e.renegotiatePort(d.id, p.id);
    },
  });
  r.register({
    pattern: /^transceiver (single-mode|multi-mode|dac|none)$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (!['sfp', 'qsfp'].includes(p.media)) throw new Error('Transceiver exige SFP/QSFP.');
      if (m[1].toLowerCase() === 'none') delete p.transceiver;
      else p.transceiver = m[1].toLowerCase() as NetworkInterface['transceiver'];
    },
  });
  r.register({
    pattern: /^mtu (\d+)$/i,
    syntax: 'mtu <bytes>',
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const n = Number(m[1]);
      if (n < 576 || n > 9216) throw new Error('MTU entre 576 e 9216');
      currentPort(d, c).mtu = n;
    },
  });
  r.register({
    pattern: /^ip address ([\d.]+)(?:\/|\s+)([\d.]+)$/i,
    syntax: ['ip address <address> <mask>', 'ip address <address/prefix>'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      if (d.type === 'switch' && currentPort(d, c).mode !== 'routed')
        throw new Error('Use SVI ou no switchport para configurar IPv4.');
      const ip = ipv4Schema.parse(m[1]),
        prefix = parsePrefix(m[2]);
      const net = subnet(ip, prefix);
      if (prefix < 31 && (ip === net.network || ip === net.broadcast))
        throw new Error('Use um endereço de host, não network/broadcast');
      const p = currentPort(d, c);
      if (
        e.state.devices.some((v) =>
          v.interfaces.some((i) => i.ip === ip && i.vrf === p.vrf && (v.id !== d.id || i.id !== p.id))
        )
      )
        throw new Error('IP já usado por outra interface');
      if (p.dhcp) e.disableDhcp(d.id, p.id);
      p.ip = ip;
      p.prefix = prefix;
      d.arpTable = [];
      clearArpPending(e, d);
    },
  });
  r.register({
    pattern: /^no ip address$/i,
    modes: ['interface'],
    run: (_matches, engine, device, context) => {
      const port = currentPort(device, context);
      if (port.dhcp) engine.disableDhcp(device.id, port.id);
      delete port.ip;
      delete port.prefix;
      device.arpTable = [];
      clearArpPending(engine, device);
    },
  });
  r.register({
    pattern: /^ip default-gateway ([\d.]+)$/i,
    modes: config,
    run: (m, _e, d) => {
      if (d.type === 'router' || (d.type === 'switch' && d.ipRouting))
        throw new Error('Use ip route no roteador; gateway é configuração de host');
      d.gateway = ipv4Schema.parse(m[1]);
    },
  });
  r.register({
    pattern: /^no ip default-gateway$/i,
    modes: config,
    run: (_m, _e, d) => {
      delete d.gateway;
    },
  });
  r.register({
    pattern: /^vlan (\d+)$/i,
    modes: config,
    run: (m, e, d, c) => {
      if (d.type !== 'switch') throw new Error('VLANs são configuradas no switch');
      const id = vlanId(m[1]);
      if (!d.vlans.some((v) => v.id === id)) {
        if (d.vlans.length >= 256) throw new Error('Limite de VLANs');
        d.vlans.push({ id, name: 'VLAN' + id });
        syncPvstInstances(e, d);
      }
      c.vlan = id;
      c.mode = 'vlan';
    },
  });
  r.register({
    pattern: /^no vlan (\d+)$/i,
    modes: config,
    run: (m, e, d) => {
      const id = vlanId(m[1]);
      if (id === 1) throw new Error('VLAN 1 é reservada');
      d.vlans = d.vlans.filter((v) => v.id !== id);
      d.macTable = d.macTable.filter((v) => v.vlan !== id);
      syncPvstInstances(e, d);
    },
  });
  r.register({
    pattern: /^name ([\w-]{1,32})$/i,
    modes: ['vlan'],
    run: (m, _e, d, c) => {
      const v = d.vlans.find((v) => v.id === c.vlan);
      if (v) v.name = m[1];
    },
  });
  r.register({
    pattern: /^switchport mode (access|trunk)$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      if (d.type !== 'switch') throw new Error('Comando exclusivo de switch');
      currentPort(d, c).mode = m[1].toLowerCase() as 'access' | 'trunk';
      d.macTable = [];
    },
  });
  r.register({
    pattern: /^switchport access vlan (\d+)$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      if (d.type !== 'switch') throw new Error('Comando exclusivo de switch');
      currentPort(d, c).accessVlan = vlanId(m[1]);
      d.macTable = [];
    },
  });
  r.register({
    pattern: /^switchport trunk native vlan (\d+)$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      if (d.type !== 'switch') throw new Error('Comando exclusivo de switch');
      currentPort(d, c).nativeVlan = vlanId(m[1]);
      d.macTable = [];
    },
  });
  r.register({
    pattern: /^switchport trunk allowed vlan (?:(add|remove|except) )?([\d,-]+|all|none)$/i,
    syntax: [
      'switchport trunk allowed vlan <vlans>',
      'switchport trunk allowed vlan add <vlans>',
      'switchport trunk allowed vlan remove <vlans>',
      'switchport trunk allowed vlan except <vlans>',
    ],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      if (d.type !== 'switch') throw new Error('Comando exclusivo de switch');
      const p = currentPort(d, c),
        list =
          m[2].toLowerCase() === 'all'
            ? Array.from({ length: 4094 }, (_, i) => i + 1)
            : m[2].toLowerCase() === 'none'
              ? []
              : vlanList(m[2]);
      p.allowedVlans =
        m[1]?.toLowerCase() === 'add'
          ? [...new Set([...p.allowedVlans, ...list])].sort((a, b) => a - b)
          : m[1]?.toLowerCase() === 'remove'
            ? p.allowedVlans.filter((v) => !list.includes(v))
            : m[1]?.toLowerCase() === 'except'
              ? Array.from({ length: 4094 }, (_, i) => i + 1).filter((v) => !list.includes(v))
              : list;
      d.macTable = [];
    },
  });
  r.register({
    pattern: /^(no )?ip route ([\d.]+)(?:\/|\s+)([\d.]+) ([\d.]+)(?: (\d+))?(?: track (\d+))?$/i,
    syntax: [
      'ip route <network> <mask> <next-hop>',
      'ip route <network> <mask> <next-hop> <distance>',
      'ip route <cidr> <next-hop>',
      'ip route <cidr> <next-hop> <distance>',
      'no ip route <network> <mask> <next-hop>',
    ],
    modes: config,
    run: (m, _e, d) => {
      if (!['router', 'switch'].includes(d.type))
        throw new Error('Rotas estáticas exigem roteador ou switch L3');
      const network = ipv4Schema.parse(m[2]),
        prefix = parsePrefix(m[3]),
        nextHop = ipv4Schema.parse(m[4]);
      if (subnet(network, prefix).network !== network)
        throw new Error('Informe endereço de rede alinhado ao prefixo');
      d.routes = d.routes.filter(
        (r) => !(r.vrf === undefined && r.network === network && r.prefix === prefix && r.nextHop === nextHop)
      );
      if (!m[1]) {
        if (d.routes.length >= 256) throw new Error('Limite de rotas');
        const distance = m[5] ? Number(m[5]) : undefined;
        if (distance !== undefined && (distance < 1 || distance > 255))
          throw new Error('Administrative distance must be between 1 and 255.');
        d.routes.push({
          network,
          prefix,
          nextHop,
          metric: 1,
          ...(distance !== undefined ? { distance } : {}),
          ...(m[6] ? { track: Number(m[6]) } : {}),
        });
      }
    },
  });
  r.register({
    pattern: /^show (interfaces|ip interface brief)(?: (.+))?$/i,
    syntax: [
      'show interfaces',
      'show interfaces <interface>',
      'show interfaces trunk',
      'show interfaces status',
      'show interfaces description',
      'show ip interface brief',
    ],
    modes: all,
    run: (m, e, d) => {
      if (m[2]?.toLowerCase() === 'trunk')
        return (
          'Port           Status        Native vlan  Vlans allowed on trunk\n' +
          d.interfaces
            .filter((p) => p.mode === 'trunk')
            .map(
              (p) =>
                `${p.name.padEnd(15)}${(interfaceOperational(e.state, d, p) ? 'trunking' : 'not-trunking').padEnd(14)}${p.nativeVlan}            ${p.allowedVlans.join(',')}`
            )
            .join('\n')
        );
      if (m[1].toLowerCase() === 'interfaces' && m[2]?.toLowerCase() === 'status') return showInterfacesStatus(e, d);
      if (m[1].toLowerCase() === 'interfaces' && m[2]?.toLowerCase() === 'description')
        return showInterfacesDescription(e, d);
      return showInterfaces(e, d, m[1].toLowerCase() === 'ip interface brief', m[2]);
    },
  });
  r.register({
    pattern: /^show vlan(?: (brief))?$/i,
    syntax: ['show vlan', 'show vlan brief'],
    modes: all,
    run: (m, _e, d) => showVlan(d, !!m[1]),
  });
  r.register({
    pattern: /^show mac address-table$/i,
    modes: all,
    run: (_m, _e, d) =>
      'VLAN   MAC                PORT\n' +
      d.macTable
        .map((m) => String(m.vlan).padEnd(7) + m.mac + '  ' + d.interfaces.find((i) => i.id === m.port)?.name)
        .join('\n'),
  });
  r.register({
    pattern: /^show arp$/i,
    modes: all,
    run: (_m, _e, d) =>
      'IP                MAC                PORT\n' +
      d.arpTable
        .map((a) => a.ip.padEnd(18) + a.mac + '  ' + d.interfaces.find((i) => i.id === a.port)?.name)
        .join('\n') +
      (d.arpResolutions?.length
        ? '\nINCOMPLETE\n' +
          d.arpResolutions
            .map(
              (entry) =>
                entry.ip +
                ' ' +
                d.interfaces.find((port) => port.id === entry.port)?.name +
                ' attempt=' +
                entry.attempts +
                '/3'
            )
            .join('\n')
        : ''),
  });
  r.register({
    pattern: /^show ip route$/i,
    syntax: 'show ip route',
    modes: all,
    run: (_m, e, d) => showRoutes(e, d),
  });
  r.register({
    pattern: /^show version$/i,
    syntax: 'show version',
    modes: all,
    run: (_m, e, d) =>
      `${terminalIdentity(d).family}\nshLab educational behavioral simulator; supported IOS/IOS XE command subset.\nVirtual hardware: ${terminalIdentity(d).name}\n${d.hostname} uptime: ${(Math.max(0, e.state.clock - (d.bootStartedAt ?? 0)) / 1000).toFixed(3)} simulated seconds\n${d.interfaces.length} network interfaces; no vendor firmware is executed.`,
  });
  r.register({
    pattern: /^show running-config$/i,
    syntax: 'show running-config',
    modes: all,
    run: (_m, _e, d) =>
      [
        'hostname ' + d.hostname,
        ...iosSystemRunning(d),
        ...monitoringRunning(d),
        ...routingPolicyRunning(d),
        ...mqcDefinitions(d),
        ...(d.enableSecret ? ['enable secret ' + d.enableSecret[1] + ' ' + d.enableSecret] : []),
        ...layer3RunningConfig(d),
        ...lacpRunningConfig(d),
        ...ipv6RunningConfig(d),
        ...wirelessRunningConfig(d),
        ...tunnelRunningConfig(d),
        ...forwardingRunningConfig(d),
        ...aaaRunningConfig(d),
        ...vxlanRunningConfig(d),
        ...policyRunningConfig(d).filter((line) => !/^(?:no )?(?:ip nat|service nat)/.test(line)),
        ...stateSyncRunningConfig(_e.state, d),
        ...(d.type === 'switch' ? d.vlans.flatMap((v) => ['vlan ' + v.id, ' name ' + v.name, 'exit']) : []),
        ...d.interfaces.flatMap((i) => [
          'interface ' + i.name,
          ...(i.description ? [' description ' + i.description] : []),
          // Loopbacks use a 9216-byte MTU by default; only explicit changes are configuration.
          ...(i.mtu !== (i.loopback ? 9216 : 1500) ? [' mtu ' + i.mtu] : []),
          ...(i.duplex === 'half' && !i.logical && !i.loopback ? [' duplex half'] : []),
          ...(i.logical?.kind === 'subinterface' ? [' encapsulation dot1q ' + i.logical.vlan] : []),
          ...(d.type === 'switch' && !i.logical && i.mode === 'routed' ? [' no switchport'] : []),
          ...(i.vrf ? [' vrf forwarding ' + i.vrf] : []),
          ' ' + (i.adminUp ? 'no shutdown' : 'shutdown'),
          ...(i.speedAuto === false && !i.logical && !i.loopback ? [' speed ' + i.speed] : []),
          ...(i.transceiver ? [' transceiver ' + i.transceiver] : []),
          ...(i.aclIn ? [' ip access-group ' + i.aclIn + ' in'] : []),
          ...(i.aclOut ? [' ip access-group ' + i.aclOut + ' out'] : []),
          ...(i.natRole ? [' ip nat ' + i.natRole] : []),
          ...(i.udld ? [' udld port' + (i.udld.mode === 'aggressive' ? ' aggressive' : '')] : []),
          ...(i.bfd
            ? [
                ` bfd interval ${i.bfd.intervalMs} min_rx ${i.bfd.minRxMs} multiplier ${i.bfd.multiplier}`,
                ...(i.bfd.ospf ? [' ip ospf bfd'] : []),
              ]
            : []),
          ...(i.ospfAuthentication?.key
            ? [` ip ospf message-digest-key ${i.ospfAuthentication.keyId} md5 0 ${i.ospfAuthentication.key}`]
            : []),
          ...(i.ospfAuthentication?.enabled ? [' ip ospf authentication message-digest'] : []),
          ...(i.ipv4Mode === 'dhcp'
            ? [' ip address dhcp']
            : i.ip
              ? [' ip address ' + i.ip + ' ' + ipString(mask(i.prefix!))]
              : []),
          ...(i.ipv4Mode !== 'dhcp' && i.dns?.length ? [' ip name-server ' + i.dns.join(' ')] : []),
          ...(i.stpEdge ? [' spanning-tree portfast'] : []),
          ...(i.stpGuard ? [' spanning-tree guard ' + i.stpGuard] : []),
          ...(i.bpduGuard !== undefined
            ? [' spanning-tree bpduguard ' + (i.bpduGuard ? 'enable' : 'disable')]
            : []),
          ...(i.stpCost ? [' spanning-tree cost ' + i.stpCost] : []),
          ...(d.type === 'switch' && !i.logical && i.mode !== 'routed'
            ? [
                ' switchport mode ' + i.mode,
                ' switchport access vlan ' + i.accessVlan,
                ' switchport trunk native vlan ' + i.nativeVlan,
                ' switchport trunk allowed vlan ' +
                  (i.allowedVlans.length ? i.allowedVlans.join(',') : 'none'),
              ]
            : []),
          'exit',
        ]),
        ...campusRunningConfig(d),
        ...mqcAttachments(d),
        ...(d.loopGuardDefault ? ['spanning-tree loopguard default'] : []),
        ...(d.gateway ? ['ip default-gateway ' + d.gateway] : []),
        ...policyRunningConfig(d).filter((line) => /^(?:no )?(?:ip nat|service nat)/.test(line)),
        ...d.routes.map(
          (r) =>
            'ip route ' +
            (r.vrf ? 'vrf ' + r.vrf + ' ' : '') +
            r.network +
            ' ' +
            ipString(mask(r.prefix)) +
            ' ' +
            (r.port
              ? d.interfaces.find((p) => p.id === r.port)!.name +
                (r.nextHop === '0.0.0.0' ? '' : ' ' + r.nextHop)
              : r.nextHop) +
            (r.distance !== undefined ? ' ' + r.distance : '') +
            (r.track ? ' track ' + r.track : '')
        ),
        ...dhcpRunningConfig(d),
        ...dnsRunningConfig(d),
        ...tcpRunningConfig(d),
        ...(d.firewall?.application
          ? [
              'firewall application configure ' +
                JSON.stringify({
                  ...d.firewall.application,
                  flows: [],
                  rules: d.firewall.application.rules.map((r) => ({ ...r, hits: 0 })),
                }),
            ]
          : []),
        ...ospfRunningConfig(d),
        ...ripRunningConfig(d),
        ...vrrpRunningConfig(d),
        ...bgpRunningConfig(d),
        ...remoteRunningConfig(d),
        ...managementRunningConfig(d),
        ...stpRunningConfig(d),
        ...discoveryRunningConfig(d),
        ...hsrpRunningConfig(d),
      ].join('\n'),
  });
  // Synchronous ping/traceroute advance the simulation until replies arrive (IOS and host formats).
  registerPingCommands(r);
  r.register({
    pattern: /^(write memory|copy (?:system:)?running-config (?:nvram:)?startup-config)$/i,
    syntax: ['write memory', 'copy running-config startup-config'],
    modes: ['privileged'],
    run: (_m, e, d) => saveStartup(e, d, r),
  });
  r.register({
    pattern: /^show startup-config$/i,
    syntax: 'show startup-config',
    modes: ['privileged'],
    run: (_m, _e, d) => d.startupConfig?.commands.join('\n') ?? 'startup-config is not present',
  });
  r.register({
    pattern: /^(erase startup-config|write erase)$/i,
    syntax: ['erase startup-config', 'write erase'],
    modes: ['privileged'],
    run: (_m, _e, d) => {
      delete d.startupConfig;
      d.bootManaged = true;
      d.booted = true;
      return 'Erase of nvram: complete';
    },
  });
  r.register({
    pattern: /^reload$/i,
    syntax: 'reload',
    modes: ['privileged'],
    run: (_m, e, d, c) => {
      // The terminal asks "Save? [yes/no]" only when the reload would lose running-config changes.
      c.confirm = { kind: reloadLosesChanges(e, d, r) ? 'save' : 'reload' };
      return '';
    },
  });
  return r;
}
