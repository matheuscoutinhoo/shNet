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
import { registerAcl6Commands, acl6RunningConfig } from './acl6';
import { registerAaaLoginCommands } from './aaa-login';
import { registerLayer3Commands, layer3RunningConfig, staticRouteLine } from './layer3';
import { registerLacpCommands, lacpRunningConfig } from './lacp';
import { registerBgpCommands, bgpRunningConfig } from './bgp';
import { registerVrrpCommands, vrrpRunningConfig } from './vrrp';
import { registerStateSyncCommands, stateSyncRunningConfig } from './state-sync';
import { ALL_MODES, CONFIG_MODES, CommandRegistry, currentPort, type Mode } from './registry';
import { ipv4Schema } from '../model';
import { parsePrefix, subnet, ipString, mask, sameSubnet } from '../protocols/ipv4';
import { dhcpRunningConfig, registerDhcpCommands } from './dhcp';
import { dnsRunningConfig, registerDnsCommands } from './dns';
import { registerStpCommands, stpRunningConfig } from './stp';
import { registerPolicyCommands, policyRunningConfig } from './policy';
import { registerTcpCommands, tcpRunningConfig } from './tcp';
import { registerOspfCommands, ospfRunningConfig } from './ospf';
import { registerRipCommands, ripRunningConfig } from './rip';
import { syncPvstInstances } from '../protocols/stp';
import { hardwareSpeed } from '../links/physical';
import { registerManagementCommands, managementRunningConfig } from './management';
import { clearArpPending } from '../protocols/arp';
import {
  interfaceName,
  showInterfaces,
  showInterfacesDescription,
  showInterfacesStatus,
  showRoutes,
} from './operational';
import { saveStartup, reloadLosesChanges } from './startup';
import { registerDiscoveryCommands, discoveryRunningConfig } from './discovery';
import { registerHsrpCommands, hsrpRunningConfig } from './hsrp';
import { registerLocalSecurityCommands } from './local-security';
import { registerCampusCommands, campusRunningConfig } from './campus';
import { registerIosOperations, iosSystemRunning } from './ios-operations';
import {
  registerIosManagementCommands,
  iosManagementHead,
  iosManagementTail,
  stormControlRunningConfig,
} from './ios-management';
import { bannerRunningConfig } from './banner';
import { registerIosManagementShow } from './ios-management-show';
import { registerIosTunnelCommands, iosTunnelInterfaceLines, cryptoRunningConfig } from './ios-tunnel';
import { edgePort } from '../protocols/stp-scope';
import { registerMonitoring, monitoringRunning } from './monitoring';
import { registerRoutingPolicy, routingPolicyRunning } from './routing-policy';
import { registerMqc, mqcDefinitions, mqcAttachments } from './mqc';
import { showInterfacesTrunk, showVlan } from './ios-show';
import { allVlansAllowed, vlanRangeText } from '../protocols/trunk';
import { defaultVlanName, longInterfaceName } from '../protocols/interface-name';
import { registerPingCommands } from './ping';
import { registerConfigDiff } from './config-diff';
import { composeRunningConfig, iosConfigText, withConfigHeader } from './running-config';
import { printSecret } from './secrets';
import { bfdInterfaceRunningConfig, bfdTemplateRunningConfig } from './bfd';
import { keyChainRunningConfig } from './key-chain';
import { registerIosExec, showIosArp, showIosMacTable } from './ios-exec';
import { registerZbfCommands, zbfRunningConfig } from './zbf';
import { registerIosShow2 } from './ios-show2';
import { registerDebugCommands } from './debug';
import { eigrpRunningConfig, registerEigrpCommands } from './eigrp';
import { ospf3RunningConfig, registerOspf3Commands } from './ospf3';
import { registerVtyCommands } from './vty';
import { registerIpInterfaceCommands, urpfRunningConfig } from './ip-interface';
import { showVersion } from './ios-version';
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
  // Before the simulator's legacy management forms, so the IOS syntax wins.
  registerIosManagementCommands(r);
  registerIosManagementShow(r);
  registerIosTunnelCommands(r);
  registerIosOperations(r);
  registerIosExec(r);
  registerIosShow2(r);
  registerDebugCommands(r);
  // Before OSPF/RIP/BGP: shared router-mode words (network, passive-interface...) are EIGRP's here.
  registerEigrpCommands(r);
  registerOspf3Commands(r);
  registerVtyCommands(r);
  registerIpInterfaceCommands(r);
  registerConfigDiff(r);
  registerMonitoring(r);
  registerRoutingPolicy(r);
  registerZbfCommands(r);
  registerMqc(r);
  registerRemoteCommands(r);
  registerApplicationCommands(r);
  registerAaaCommands(r);
  registerWirelessCommands(r);
  registerTunnelCommands(r);
  registerForwardingCommands(r);
  registerVxlanCommands(r);
  registerIpv6Commands(r);
  registerAcl6Commands(r);
  registerAaaLoginCommands(r);
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
        c.mode === 'key-chain-key'
          ? 'key-chain'
          : c.mode === 'ikev2-keyring-peer'
            ? 'ikev2-keyring'
            : c.mode === 'policy-class'
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
  // Lines IOS writes into every configuration file; replaying them changes nothing.
  r.register({
    pattern: /^(?:version \d+(?:\.\d+)*|boot-start-marker|boot-end-marker)$/i,
    modes: config,
    run: () => '',
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
    // IOS accepts a space between the type and the number ("interface GigabitEthernet 0/1").
    syntax: 'interface <interface...>',
    modes: config,
    run: (m, e, d, c) => {
      const name = interfaceName(m[1]);
      let p = d.interfaces.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!p && /^Vlan\d+$/i.test(name)) p = e.addSvi(d.id, Number(name.slice(4)));
      if (!p && /^Loopback\d+$/i.test(name)) p = e.addLoopback(d.id, Number(name.slice(8)));
      if (!p && /^Tunnel\d+$/i.test(name)) p = e.addIosTunnel(d.id, Number(name.slice(6)));
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
      // IOS refuses only overlapping subnets on the same device (and VRF); two devices may share
      // an address, which shows up at run time as %IP-4-DUPADDR.
      const overlap = d.interfaces.find(
        (i) =>
          i.id !== p.id &&
          i.ip &&
          i.prefix !== undefined &&
          i.vrf === p.vrf &&
          (sameSubnet(i.ip, ip, Math.min(i.prefix, prefix)) || i.ip === ip)
      );
      if (overlap) throw new Error(`${net.network} overlaps with ${longInterfaceName(overlap.name)}`);
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
        d.vlans.push({ id, name: defaultVlanName(id) });
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
      const p = currentPort(d, c);
      p.mode = m[1].toLowerCase() as 'access' | 'trunk';
      p.explicitMode = true;
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
        every = Array.from({ length: 4094 }, (_, i) => i + 1),
        current = allVlansAllowed(p) ? every : p.allowedVlans,
        verb = m[1]?.toLowerCase(),
        word = m[2].toLowerCase(),
        list = word === 'all' ? every : word === 'none' ? [] : vlanList(m[2]);
      const next =
        verb === 'add'
          ? [...new Set([...current, ...list])].sort((a, b) => a - b)
          : verb === 'remove'
            ? current.filter((v) => !list.includes(v))
            : verb === 'except'
              ? every.filter((v) => !list.includes(v))
              : list;
      // The full range is the IOS default ("all"), kept without listing 4094 VLANs.
      p.allVlansAllowed = next.length === 4094;
      p.allowedVlans = next.length === 4094 ? [] : next;
      d.macTable = [];
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
      if (m[2]?.toLowerCase() === 'trunk') return showInterfacesTrunk(e, d);
      if (m[1].toLowerCase() === 'interfaces' && m[2]?.toLowerCase() === 'status')
        return showInterfacesStatus(e, d);
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
    pattern: /^show mac address-table((?: (?:dynamic|static|address \S+|interface \S+|vlan \d+))*)$/i,
    syntax: [
      'show mac address-table',
      'show mac address-table dynamic',
      'show mac address-table interface <interface>',
      'show mac address-table vlan <vlan>',
      'show mac address-table address <mac>',
    ],
    modes: all,
    run: (m, _e, d) =>
      terminalIdentity(d).host
        ? 'VLAN   MAC                PORT\n' +
          d.macTable
            .map(
              (m) => String(m.vlan).padEnd(7) + m.mac + '  ' + d.interfaces.find((i) => i.id === m.port)?.name
            )
            .join('\n')
        : showIosMacTable(d, m[1]),
  });
  r.register({
    pattern: /^show (ip )?arp(?: (\S+))?$/i,
    syntax: ['show arp', 'show ip arp', 'show ip arp <address>', 'show ip arp <interface>'],
    modes: all,
    run: (m, e, d) =>
      !terminalIdentity(d).host
        ? showIosArp(e, d, m[2])
        : 'IP                MAC                PORT\n' +
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
      terminalIdentity(d).host
        ? `${terminalIdentity(d).family}\nshLab educational behavioral simulator.\nVirtual hardware: ${terminalIdentity(d).name}\n${d.hostname} uptime: ${(Math.max(0, e.state.clock - (d.bootStartedAt ?? 0)) / 1000).toFixed(3)} simulated seconds\n${d.interfaces.length} network interfaces.`
        : showVersion(e, d),
  });
  r.register({
    pattern: /^show running-config$/i,
    syntax: 'show running-config',
    modes: all,
    run: (_m, _e, d) => {
      const lines = composeRunningConfig(
        d,
        [
          'hostname ' + d.hostname,
          ...iosSystemRunning(d),
          ...iosManagementHead(d),
          ...cryptoRunningConfig(d),
          ...monitoringRunning(d),
          ...routingPolicyRunning(d),
          ...mqcDefinitions(d),
          ...zbfRunningConfig(d),
          ...keyChainRunningConfig(d),
          ...bfdTemplateRunningConfig(d),
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
          ...acl6RunningConfig(d),
          ...stateSyncRunningConfig(_e.state, d),
          // VLANs live in vlan.dat; IOS lists them in running-config only in VTP transparent/off mode.
          ...(d.type === 'switch' && ['transparent', 'off'].includes(d.iosSystem?.vtp?.mode ?? '')
            ? d.vlans
                .filter((v) => v.id !== 1 && (v.id < 1002 || v.id > 1005))
                .flatMap((v) => [
                  'vlan ' + v.id,
                  ...(v.name !== defaultVlanName(v.id) ? [' name ' + v.name] : []),
                  'exit',
                ])
            : []),
        ],
        d.interfaces.flatMap((i) => {
          const switchport = d.type === 'switch' && !i.logical && i.mode !== 'routed';
          // A routed interface without IPv4 shows "no ip address", as IOS prints it.
          const unaddressed =
            ['router', 'switch'].includes(d.type) &&
            !switchport &&
            !i.ip &&
            i.ipv4Mode !== 'dhcp' &&
            !i.aggregate &&
            !i.iosTunnel &&
            !i.tunnel &&
            !i.vxlan;
          return [
            'interface ' + i.name,
            ...(i.description ? [' description ' + i.description] : []),
            // Loopbacks use a 9216-byte MTU by default; only explicit changes are configuration.
            ...(!i.iosTunnel && i.mtu !== (i.loopback ? 9216 : 1500) ? [' mtu ' + i.mtu] : []),
            ...(i.logical?.kind === 'subinterface' ? [' encapsulation dot1Q ' + i.logical.vlan] : []),
            ...(d.type === 'switch' && !i.logical && !i.iosTunnel && i.mode === 'routed'
              ? [' no switchport']
              : []),
            ...(i.vrf ? [' vrf forwarding ' + i.vrf] : []),
            ...(i.ipv4Mode === 'dhcp'
              ? [' ip address dhcp']
              : i.ip
                ? [' ip address ' + i.ip + ' ' + ipString(mask(i.prefix!))]
                : unaddressed
                  ? [' no ip address']
                  : []),
            ...(i.aclIn ? [' ip access-group ' + i.aclIn + ' in'] : []),
            ...(i.aclOut ? [' ip access-group ' + i.aclOut + ' out'] : []),
            ...urpfRunningConfig(i),
            ...(i.natRole ? [' ip nat ' + i.natRole] : []),
            ...(i.zoneMember ? [' zone-member security ' + i.zoneMember] : []),
            ...(i.ospfAuthentication?.key
              ? [
                  ` ip ospf message-digest-key ${i.ospfAuthentication.keyId} md5 ${printSecret(d, i.ospfAuthentication.key)}`,
                ]
              : []),
            ...(i.ospfAuthentication?.enabled === true
              ? [' ip ospf authentication message-digest']
              : i.ospfAuthentication?.enabled === false
                ? [' ip ospf authentication null']
                : []),
            ...iosTunnelInterfaceLines(i),
            ...(i.ipv4Mode !== 'dhcp' && i.dns?.length ? [' ip name-server ' + i.dns.join(' ')] : []),
            ...(switchport
              ? [
                  ...(i.trunkEncapsulation
                    ? [' switchport trunk encapsulation ' + i.trunkEncapsulation]
                    : []),
                  // IOS shows only what differs from the defaults (VLAN 1, all VLANs allowed).
                  ...(i.accessVlan !== 1 ? [' switchport access vlan ' + i.accessVlan] : []),
                  ...(i.nativeVlan !== 1 ? [' switchport trunk native vlan ' + i.nativeVlan] : []),
                  ...(allVlansAllowed(i)
                    ? []
                    : [' switchport trunk allowed vlan ' + (vlanRangeText(i.allowedVlans) || 'none')]),
                  ...(i.mode === 'trunk' || i.explicitMode ? [' switchport mode ' + i.mode] : []),
                  ...(i.nonegotiate ? [' switchport nonegotiate'] : []),
                ]
              : []),
            ...(i.adminUp ? [] : [' shutdown']),
            ...(i.duplex === 'half' && !i.logical && !i.loopback ? [' duplex half'] : []),
            ...(i.speedAuto === false && !i.logical && !i.loopback ? [' speed ' + i.speed] : []),
            ...(i.delayTens !== undefined ? [' delay ' + i.delayTens] : []),
            ...(i.udld ? [' udld port' + (i.udld.mode === 'aggressive' ? ' aggressive' : '')] : []),
            ...bfdInterfaceRunningConfig(i),
            ...(i.stpEdge
              ? [' spanning-tree portfast']
              : i.stpEdge === false && edgePort(d, { ...i, stpEdge: undefined })
                ? [' spanning-tree portfast disable']
                : []),
            ...(i.stpGuard ? [' spanning-tree guard ' + i.stpGuard] : []),
            ...(i.bpduGuard !== undefined
              ? [' spanning-tree bpduguard ' + (i.bpduGuard ? 'enable' : 'disable')]
              : []),
            ...(i.stpCost ? [' spanning-tree cost ' + i.stpCost] : []),
            ...stormControlRunningConfig(i),
            'exit',
          ];
        }),
        [
          ...campusRunningConfig(d),
          ...mqcAttachments(d),
          ...(d.loopGuardDefault ? ['spanning-tree loopguard default'] : []),
          ...(d.gateway ? ['ip default-gateway ' + d.gateway] : []),
          ...policyRunningConfig(d).filter((line) => /^(?:no )?(?:ip nat|service nat)/.test(line)),
          ...d.routes.map((r) => staticRouteLine(d, r)),
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
          ...eigrpRunningConfig(d),
          ...ospf3RunningConfig(d),
          ...vrrpRunningConfig(d),
          ...bgpRunningConfig(d),
          ...managementRunningConfig(d),
          ...iosManagementTail(d, bannerRunningConfig(d)),
          ...remoteRunningConfig(d),
          ...stpRunningConfig(d),
          ...discoveryRunningConfig(d),
          ...hsrpRunningConfig(d),
        ]
      );
      // Endpoints keep the simulator's plain listing; IOS devices print the IOS text.
      return terminalIdentity(d).host
        ? lines.join('\n')
        : withConfigHeader(iosConfigText(d, lines).join('\n'));
    },
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
    run: (_m, _e, d) => {
      if (!d.startupConfig) return 'startup-config is not present';
      const text = d.startupConfig.commands.join('\n');
      return `Using ${new TextEncoder().encode(text).length} out of 33554432 bytes\n${text}`;
    },
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
