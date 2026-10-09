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
import { ALL_MODES, CONFIG_MODES, CommandRegistry, currentPort, type Mode } from './registry';
import { ipv4Schema } from '../model';
import { parsePrefix, resolveDefaultRoutes, subnet } from '../protocols/ipv4';
import { dhcpRunningConfig, registerDhcpCommands } from './dhcp';
import { dnsRunningConfig, registerDnsCommands } from './dns';
import { registerStpCommands, stpRunningConfig } from './stp';
import { registerPolicyCommands, policyRunningConfig } from './policy';
import { registerTcpCommands, tcpRunningConfig } from './tcp';
import { registerOspfCommands, ospfRunningConfig } from './ospf';
import { registerRipCommands, ripRunningConfig } from './rip';
import { ripRoutes } from '../protocols/rip';
import { registerManagementCommands, managementRunningConfig } from './management';
import { clearArpPending } from '../protocols/arp';
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
  registerBgpCommands(r);
  registerManagementCommands(r);
  r.register({
    pattern: /^(help|\?)$/i,
    modes: all,
    run: () =>
      [
        'NetOS — terminal simulado; nenhuma chamada ao sistema operacional.',
        'enable | configure terminal | exit | end',
        'hostname NAME | interface Gi0/1 | description TEXT',
        'ip address IPv4 MASK|PREFIX | no ip address | ip default-gateway IPv4',
        'ip address dhcp | ip dhcp renew [INTERFACE] | ip dhcp release [INTERFACE]',
        'ip dhcp pool NAME [interface INTERFACE] | no ip dhcp pool NAME',
        'ip dhcp pool NAME relay GIADDR/PREFIX [interface INTERFACE] | interface: ip helper-address SERVER',
        'DHCP pool: reservation MAC IPv4 | no reservation MAC | show ip dhcp relay',
        'DHCP pool: network IPv4/PREFIX | range START END | lease SECONDS',
        'DHCP pool: default-router IPv4 | dns-server IPv4... | excluded-address IPv4...',
        'service dhcp | no service dhcp | show ip dhcp pool | show ip dhcp binding | show dhcp lease',
        'service dns | no service dns | dns record NAME A|AAAA|CNAME VALUE [ttl SECONDS]',
        'service echo|http [PORT] | no service echo|http [PORT] | show services',
        'tcp connect IPv4 PORT | tcp echo IPv4 PORT TEXT | tcp send ID TEXT | tcp close|reset ID',
        'http get IPv4 [PORT] [/PATH] | show tcp [ID]',
        'router ospf ROUTER_ID | service ospf | no service ospf',
        'interface: ip ospf area NUMBER | ip ospf cost NUMBER | ip ospf network point-to-point|broadcast',
        'interface: ip ospf priority NUMBER | ip ospf passive | no ip ospf | ip ospf hello-interval|dead-interval SECONDS',
        'show ip ospf [neighbor|database|interface]',
        'router bgp ASN | bgp router-id IP | bgp hold-time SECONDS | bgp network CIDR',
        'neighbor IP remote-as ASN | neighbor IP passive|next-hop-self|route-reflector-client',
        'neighbor IP local-preference|metric|as-path-prepend NUMBER | neighbor IP prefix-filter in|out SEQ permit|deny CIDR [ge N] [le N]',
        'wireless ap|client ssid SSID security open|wpa2-psk|wpa3-sae [key KEY] channel N [band 2.4|5]',
        'tunnel configure JSON | [no] service tunnel N | show tunnels',
        'management configure JSON | management request JSON | automation run JSON | show management|automation',
        'telemetry|collector|clock|ntp configure JSON | show telemetry|ntp',
        'aaa server|client configure JSON | aaa login USER PASS | aaa logout | show aaa|dot1x',
        'interface: dot1x|supplicant configure JSON | no dot1x|supplicant',
        'vxlan configure JSON | [no] service vxlan VNI | no vxlan VNI | show vxlan|evpn',
        'qos configure JSON (interface) | show qos | mpls configure JSON | mpls ingress|lfib JSON | show mpls',
        'sdwan site SITE [controller IP underlay PORT key KEY] | sdwan policy JSON | sdwan controller JSON | show sdwan',
        'wireless tx-power|noise|attenuation N | show wireless [scan|clients|radio] | [no] service wireless',
        'ipv6 unicast-routing | interface: ipv6 enable | ipv6 address IPv6/PREFIX | ipv6 address autoconfig',
        'interface: ipv6 nd prefix CIDR [valid SECONDS preferred SECONDS] | ipv6 traffic-filter in|out permit|deny KIND SRC/CIDR DST/CIDR',
        'ipv6 route [vrf NAME] CIDR INTERFACE NEXT_HOP [metric N] | show ipv6 interface|neighbors|route|probes',
        'ping ipv6 IP [interface NAME] [vrf NAME] [hop-limit N] [size N] | traceroute ipv6 IP [vrf NAME]',
        'show ip bgp [summary|neighbors] | service bgp | no service bgp',
        'service vrrp | no service vrrp | show vrrp',
        'interface: vrrp VRID ip VIP | vrrp VRID priority NUMBER | vrrp VRID advertisement-interval MS',
        'interface: [no] vrrp VRID preempt | no vrrp VRID',
        'interface: [no] vrrp VRID track interface NAME|route IPv4 decrement NUMBER',
        'router rip | service rip | no service rip | show ip rip [database|interface]',
        'interface: ip rip enable | ip rip passive | ip rip poison-reverse | no ip rip',
        'firewall trust INTERFACE... | firewall protocols tcp udp icmp | service firewall | no service firewall | show firewall',
        'firewall mode trusted|zones | firewall zone NAME INTERFACE... | no firewall zone NAME | show firewall zones',
        'firewall rule SEQ FROM TO inspect|permit|deny ip|tcp|udp|icmp [eq PORT] | no firewall rule SEQ',
        'snmp-server community NAME | service snmp | snmp get|get-next IP COMMUNITY OID... | show snmp',
        'logging host IP | logging severity 0..7 | logging facility 0..23 | logging automatic | no logging host',
        'service syslog | syslog send SEVERITY TEXT | show syslog | clear syslog',
        'interface: ip name-server IPv4... | no ip name-server',
        'nslookup [-tcp|-udp] [-type=A|AAAA|CNAME] NAME [SERVER] | show dns records|cache|queries | clear dns cache',
        'shutdown | no shutdown | mtu BYTES | speed MBPS | transceiver single-mode/multi-mode/dac/none',
        'access-list NAME SEQ permit|deny ip|icmp|udp|tcp|ospf|vrrp SOURCE/CIDR DEST/CIDR [eq PORT]',
        'interface: ip access-group NAME in|out | ip nat inside|outside',
        'ip nat static LOCAL GLOBAL | ip nat pool NAME SOURCE/CIDR START END [overload]',
        'show access-lists | show ip nat translations | service nat | no service nat',
        'spanning-tree mode stp|rstp | spanning-tree priority NUMBER | no spanning-tree',
        'interface: spanning-tree cost NUMBER | spanning-tree portfast | show spanning-tree',
        'vlan ID | name NAME | no vlan ID',
        'switchport mode access|trunk | switchport access vlan ID',
        'switchport trunk native vlan ID | switchport trunk allowed vlan 10,20-30',
        'interface: channel-group NUMBER mode active|passive | no channel-group | lacp min-links NUMBER',
        'show etherchannel summary | show lacp neighbors | no port-channel NUMBER',
        'ip route NETWORK MASK NEXT_HOP | no ip route NETWORK MASK NEXT_HOP',
        'show interfaces | show ip interface brief | show vlan',
        'interface Gi0/1.VLAN | interface VlanID | encapsulation dot1q VLAN | no switchport | ip routing',
        'vrf definition NAME | interface: vrf forwarding NAME | show vrf | show ip route vrf NAME',
        'ip route vrf NAME CIDR NEXT_HOP | ping vrf NAME IPv4 | http get vrf NAME IPv4 [PORT] [/PATH]',
        'show mac address-table | show arp | show ip route | show running-config',
        'ping IPv4|HOSTNAME | traceroute IPv4|HOSTNAME',
        'write memory (estado salvo pelo workspace)',
      ].join('\n'),
  });
  r.register({
    pattern: /^enable$/i,
    modes: all,
    run: (_m, _e, _d, c) => {
      c.mode = 'privileged';
    },
  });
  r.register({
    pattern: /^(configure terminal|conf t)$/i,
    modes: privileged,
    run: (_m, _e, _d, c) => {
      c.mode = 'config';
    },
  });
  r.register({
    pattern: /^end$/i,
    modes: all,
    run: (_m, _e, _d, c) => {
      c.mode = 'privileged';
    },
  });
  r.register({
    pattern: /^exit$/i,
    modes: all,
    run: (_m, _e, _d, c) => {
      c.mode =
        c.mode === 'interface' || c.mode === 'vlan' || c.mode === 'dhcp'
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
    pattern: /^interface\s+(.+)$/i,
    modes: config,
    run: (m, e, d, c) => {
      const name = m[1].replace(/\s/g, '').replace(/^gigabitEthernet/i, 'Gi');
      let p = d.interfaces.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!p && /^Vlan\d+$/i.test(name)) p = e.addSvi(d.id, Number(name.slice(4)));
      if (!p && /^.+\.\d+$/.test(name)) {
        const [parentName, vlan] = name.split('.');
        const parent = d.interfaces.find((p) => p.name.toLowerCase() === parentName.toLowerCase());
        if (parent) p = e.addSubinterface(d.id, parent.id, Number(vlan));
      }
      if (!p) throw new Error('Interface inexistente');
      c.port = p.id;
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
    pattern: /^description (.{1,160})$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      currentPort(d, c).description = m[1];
    },
  });
  r.register({
    pattern: /^speed (100|1000|10000|40000|100000)$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      currentPort(d, c).speed = Number(m[1]) as NetworkInterface['speed'];
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
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const n = Number(m[1]);
      if (n < 576 || n > 9216) throw new Error('MTU entre 576 e 9216');
      currentPort(d, c).mtu = n;
    },
  });
  r.register({
    pattern: /^ip address ([\d.]+)(?:\/|\s+)([\d.]+)$/i,
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
      if (d.type === 'router' || d.type === 'switch')
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
    run: (m, _e, d, c) => {
      if (d.type !== 'switch') throw new Error('VLANs são configuradas no switch');
      const id = vlanId(m[1]);
      if (!d.vlans.some((v) => v.id === id)) {
        if (d.vlans.length >= 256) throw new Error('Limite de VLANs');
        d.vlans.push({ id, name: 'VLAN' + id });
      }
      c.vlan = id;
      c.mode = 'vlan';
    },
  });
  r.register({
    pattern: /^no vlan (\d+)$/i,
    modes: config,
    run: (m, _e, d) => {
      const id = vlanId(m[1]);
      if (id === 1) throw new Error('VLAN 1 é reservada');
      d.vlans = d.vlans.filter((v) => v.id !== id);
      d.macTable = d.macTable.filter((v) => v.vlan !== id);
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
    pattern: /^switchport trunk allowed vlan ([\d,-]+)$/i,
    modes: ['interface'],
    run: (m, _e, d, c) => {
      if (d.type !== 'switch') throw new Error('Comando exclusivo de switch');
      currentPort(d, c).allowedVlans = vlanList(m[1]);
      d.macTable = [];
    },
  });
  r.register({
    pattern: /^(no )?ip route ([\d.]+)(?:\/|\s+)([\d.]+) ([\d.]+)$/i,
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
        d.routes.push({ network, prefix, nextHop, metric: 1 });
      }
    },
  });
  r.register({
    pattern: /^show (interfaces|ip interface brief)$/i,
    modes: all,
    run: (_m, e, d) =>
      'Interface       IPv4                 Admin  Link  VLAN / Mode\n' +
      d.interfaces
        .map(
          (p) =>
            p.name.padEnd(16) +
            (p.ip ? p.ip + '/' + p.prefix : 'unassigned').padEnd(21) +
            (p.adminUp ? 'up' : 'down').padEnd(7) +
            (e.state.links.some((l) => l.up && [l.a, l.b].some((a) => a.device === d.id && a.port === p.id))
              ? 'cabled'
              : 'none'
            ).padEnd(6) +
            p.accessVlan +
            ' / ' +
            p.mode
        )
        .join('\n'),
  });
  r.register({
    pattern: /^show vlan(?: brief)?$/i,
    modes: all,
    run: (_m, _e, d) => 'VLAN   NAME\n' + d.vlans.map((v) => String(v.id).padEnd(7) + v.name).join('\n'),
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
    modes: all,
    run: (_m, _e, d) =>
      [
        ...d.interfaces
          .filter((i) => i.ip && !i.vrf)
          .map(
            (i) => 'C ' + subnet(i.ip!, i.prefix!).network + '/' + i.prefix + ' directly connected, ' + i.name
          ),
        ...d.routes.filter((r) => !r.vrf).map((r) => 'S ' + r.network + '/' + r.prefix + ' via ' + r.nextHop),
        ...(d.ospf?.routes ?? []).map(
          (r) =>
            `O${r.pathType === 'inter' ? ' IA' : ''} ${r.network}/${r.prefix} [${r.distance}/${r.metric}] via ${r.nextHop}, ${d.interfaces.find((p) => p.id === r.port)?.name}`
        ),
        ...(d.bgp?.routes ?? []).map(
          (route) =>
            `B ${route.network}/${route.prefix} [${route.distance}/${route.metric}] via ${route.nextHop}, ${d.interfaces.find((port) => port.id === route.port)?.name}`
        ),
        ...ripRoutes(d).map(
          (r) =>
            `R ${r.network}/${r.prefix} [120/${r.metric}] via ${r.nextHop}, ${d.interfaces.find((p) => p.id === r.port)?.name}`
        ),
        ...resolveDefaultRoutes(d).map(
          (route) =>
            (route.port.ipv4Mode === 'dhcp' ? 'D' : 'S') +
            ' 0.0.0.0/0 via ' +
            route.nextHop +
            ', ' +
            route.port.name
        ),
      ].join('\n') || 'Nenhuma rota',
  });
  r.register({
    pattern: /^show running-config$/i,
    modes: all,
    run: (_m, _e, d) =>
      [
        'hostname ' + d.hostname,
        ...layer3RunningConfig(d),
        ...lacpRunningConfig(d),
        ...ipv6RunningConfig(d),
        ...wirelessRunningConfig(d),
        ...tunnelRunningConfig(d),
        ...forwardingRunningConfig(d),
        ...aaaRunningConfig(d),
        ...vxlanRunningConfig(d),
        ...policyRunningConfig(d),
        ...d.vlans.flatMap((v) => ['vlan ' + v.id, ' name ' + v.name]),
        ...d.interfaces.flatMap((i) => [
          'interface ' + i.name,
          ...(i.logical?.kind === 'subinterface' ? [' encapsulation dot1q ' + i.logical.vlan] : []),
          ...(d.type === 'switch' && !i.logical && i.mode === 'routed' ? [' no switchport'] : []),
          ...(i.vrf ? [' vrf forwarding ' + i.vrf] : []),
          ' ' + (i.adminUp ? 'no shutdown' : 'shutdown'),
          ' speed ' + i.speed,
          ...(i.transceiver ? [' transceiver ' + i.transceiver] : []),
          ...(i.aclIn ? [' ip access-group ' + i.aclIn + ' in'] : []),
          ...(i.aclOut ? [' ip access-group ' + i.aclOut + ' out'] : []),
          ...(i.natRole ? [' ip nat ' + i.natRole] : []),
          ...(i.ipv4Mode === 'dhcp'
            ? [' ip address dhcp']
            : i.ip
              ? [' ip address ' + i.ip + '/' + i.prefix]
              : []),
          ...(i.ipv4Mode !== 'dhcp' && i.dns?.length ? [' ip name-server ' + i.dns.join(' ')] : []),
          ...(i.stpEdge ? [' spanning-tree portfast'] : []),
          ...(i.stpCost ? [' spanning-tree cost ' + i.stpCost] : []),
          ...(d.type === 'switch' && !i.logical && i.mode !== 'routed'
            ? [
                ' switchport mode ' + i.mode,
                ' switchport access vlan ' + i.accessVlan,
                ' switchport trunk native vlan ' + i.nativeVlan,
                ' switchport trunk allowed vlan ' + i.allowedVlans.join(','),
              ]
            : []),
        ]),
        ...(d.gateway ? ['ip default-gateway ' + d.gateway] : []),
        ...d.routes.map(
          (r) =>
            'ip route ' + (r.vrf ? 'vrf ' + r.vrf + ' ' : '') + r.network + '/' + r.prefix + ' ' + r.nextHop
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
      ].join('\n'),
  });
  r.register({
    pattern: /^ping ([a-z0-9_.-]+)(?: size (\d+))?(?: (df))?$/i,
    modes: all,
    run: (m, e, d) => {
      const id = e.ping(d.id, m[1], 64, undefined, Number(m[2] ?? 84), !!m[3]);
      if (id.startsWith('dns-query-'))
        return 'Resolução DNS enfileirada [' + id + ']; o ping será enviado após a resposta A.';
      return 'ICMP enfileirado [' + id + ']. Execute ou avance a simulação para receber o resultado.';
    },
  });
  r.register({
    pattern: /^traceroute ([a-z0-9_.-]+)$/i,
    modes: all,
    run: (m, e, d) => {
      for (let ttl = 1; ttl <= 8; ttl++) e.ping(d.id, m[1], ttl);
      return '8 probes ICMP com TTL 1…8 enfileirados. Resultados no painel Tráfego.';
    },
  });
  r.register({
    pattern: /^write memory$/i,
    modes: privileged,
    run: () => 'Configuração aplicada ao estado do laboratório. O workspace salva automaticamente.',
  });
  return r;
}
