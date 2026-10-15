import { deviceProfile, deviceProfiles } from './profiles';
import type { Device } from '../model';
import { managementEnabled } from '../protocols/layer3';

export function devicePresentationProfile(d: Device) {
  const explicit = deviceProfile(d);
  if (explicit) return explicit;
  const role =
    d.infrastructure?.kind ??
    (d.wlc
      ? 'wlc'
      : d.mesh
        ? 'mesh'
        : d.wireless?.role === 'ap'
          ? 'ap'
          : d.type === 'switch' && d.ipRouting
            ? 'switch-l3'
            : undefined);
  return deviceProfiles.find((profile) => profile.id === role);
}

/** Profile roles take precedence over the engine's forwarding implementation type. */
export function deviceCapabilities(d: Device) {
  const profile = deviceProfile(d);
  const generic =
    !profile ||
    [
      'desktop',
      'laptop',
      'server',
      'router',
      'switch-l2',
      'switch-l3',
      'edge',
      'branch',
      'virtual-router',
      'isp',
    ].includes(profile.id);
  const infrastructure = d.infrastructure?.kind;
  const active = !infrastructure;
  const ap = active && (d.wireless?.role === 'ap' || ['ap', 'mesh'].includes(d.profile ?? ''));
  const clientRadio = active && (d.wireless?.role === 'client' || profile?.feature === 'wireless-client');
  const controller = active && (d.profile === 'wlc' || !!d.wlc);
  const switching = active && d.type === 'switch' && !ap && !controller;
  const routing =
    active && (d.type === 'router' || (switching && (profile?.feature === 'l3' || !!d.ipRouting)));
  const routingProtocols = routing && !['ids', 'ips'].includes(d.profile ?? '');
  const server = active && d.type === 'server' && generic;
  const endpoint = active && ['pc', 'server'].includes(d.type);
  const advancedKinds = [
    ...(server || !!d.eapServer || ['aaa', 'radius'].includes(d.profile ?? '')
      ? (['eapServer'] as const)
      : []),
    ...(ap ? (['eapAuthenticator', 'mesh', 'wtp'] as const) : []),
    ...(clientRadio ? (['eapSupplicant'] as const) : []),
    ...(controller || (switching && !profile) ? (['wlc'] as const) : []),
    ...(routing || !!d.ids ? (['ids'] as const) : []),
  ];
  const applicationKinds = [
    ...(server || !!d.phone || d.profile === 'phone' ? (['phone'] as const) : []),
    ...(server || !!d.proxy || ['proxy', 'load-balancer'].includes(d.profile ?? '')
      ? (['proxy'] as const)
      : []),
    ...(server || !!d.printer || d.profile === 'printer' ? (['printer'] as const) : []),
    ...(server || !!d.broker || d.profile === 'mqtt' ? (['broker'] as const) : []),
  ];
  const aaaKinds = [
    ...(server || !!d.aaaServer || ['aaa', 'radius', 'tacacs'].includes(d.profile ?? '')
      ? (['server'] as const)
      : []),
    ...(routing || switching || ap || controller || server || !!d.aaaClient ? (['client'] as const) : []),
    ...(switching ? (['dot1x'] as const) : []),
    ...(endpoint && d.interfaces.some((p) => p.media === 'rj45') ? (['supplicant'] as const) : []),
  ];
  const clientApplications = endpoint && (generic || d.profile === 'iot' || !!d.iot);
  return {
    remoteKinds: [
      ...(server || switching || routing || ap || controller || !!d.remoteManagement || d.profile === 'remote'
        ? (['server'] as const)
        : []),
      ...((generic && endpoint) || routing || d.profile === 'remote' || !!d.automationJobs?.length
        ? (['request', 'automation'] as const)
        : []),
      ...(server || switching || routing || ap || controller || !!d.telemetry
        ? (['telemetry'] as const)
        : []),
      ...(server || !!d.telemetryCollector || d.profile === 'snmp' ? (['collector'] as const) : []),
      ...(server || routing || d.profile === 'ntp' ? (['clock'] as const) : []),
      'ntp' as const,
    ],
    syslogServer:
      server ||
      !!d.syslogServer ||
      d.profile === 'syslog' ||
      (routing && d.type === 'router') ||
      (switching && managementEnabled(d)),
    active,
    ap,
    controller,
    switching,
    routing,
    routingProtocols,
    endpoint,
    advancedKinds,
    applicationKinds,
    aaaKinds,
    power: infrastructure !== 'rack' && infrastructure !== 'patch-panel',
    ports: d.interfaces.length > 0 && infrastructure !== 'rack',
    layer3: active && (switching || ap || controller || d.type === 'router'),
    vrf: routing || !!d.vrfs?.length,
    lacp:
      active && (switching || (d.type === 'router' && generic) || d.interfaces.some((p) => !!p.aggregate)),
    bond: endpoint && d.profile !== 'smartphone',
    vrrp: active && ((d.type === 'router' && routingProtocols) || d.type === 'server'),
    vxlan:
      active &&
      ((switching && (generic || profile?.feature === 'l3')) || d.interfaces.some((p) => !!p.vxlan)),
    wireless: ap || clientRadio,
    clientApplications,
    tcpServer: active && ((endpoint && generic) || d.profile === 'web' || !!d.tcpServices?.length),
    dhcpServer:
      active &&
      (server ||
        (routing && d.type === 'router') ||
        d.profile === 'dhcp' ||
        !!d.dhcpServer ||
        !!d.dhcp6Server),
    dnsServer: active && (server || (routing && d.type === 'router') || d.profile === 'dns' || !!d.dnsServer),
    poeSupply: active && ((switching && d.interfaces.some((p) => p.media === 'rj45')) || !!d.poeSupply),
    poeLoad: active && (ap || ['phone', 'iot'].includes(d.profile ?? '') || !!d.poeDevice),
    serial: active && d.type === 'router' && d.profile !== 'virtual-router',
    console: active && !['smartphone', 'virtual-router'].includes(d.profile ?? ''),
    sdwanController: active && (server || d.profile === 'sdwan-controller' || !!d.sdwanController),
    database: active && (server || d.profile === 'database' || !!d.database),
  };
}

export function inspectorTabIds(d: Device): string[] {
  const c = deviceCapabilities(d);
  if (!c.active) return ['overview', ...(c.ports ? ['interfaces'] : []), 'infrastructure', 'logs'];
  return [
    'overview',
    'interfaces',
    ...(c.lacp ? ['lacp'] : []),
    ...(c.bond ? ['bond'] : []),
    ...(c.layer3 ? ['layer3'] : []),
    'cli',
    'tables',
    ...(c.aaaKinds.length ? ['aaa'] : []),
    'ipv6',
    ...(c.switching || c.routing || d.interfaces.some((p) => !!p.qos) ? ['forwarding'] : []),
    ...(c.vxlan ? ['vxlan'] : []),
    ...(d.type === 'router' && c.routingProtocols ? ['tunnels'] : []),
    ...(c.sdwanController ? ['sdwanController'] : []),
    ...(c.wireless ? ['wireless'] : []),
    ...(c.advancedKinds.length ? ['advancedNetwork'] : []),
    ...(c.console || c.serial || c.poeSupply || c.poeLoad ? ['hardware'] : []),
    ...(d.system ? ['infrastructure'] : []),
    ...(c.database ? ['database'] : []),
    ...(c.applicationKinds.length || c.clientApplications ? ['applications'] : []),
    'dhcp',
    'dns',
    'tcp',
    ...(c.switching ? ['stp'] : []),
    ...(d.type === 'router' && c.routingProtocols ? ['ospf', 'rip'] : []),
    ...(c.vrrp ? ['vrrp'] : []),
    ...(c.routingProtocols ? ['bgp'] : []),
    ...(c.routing ? ['policy'] : []),
    'management',
    'logs',
  ];
}

/** Imported labs keep their cabling. Report legacy hardware instead of deleting connected ports. */
export function deviceIntegrityIssues(d: Device): string[] {
  const profile = deviceProfile(d);
  if (!profile) return [];
  const issues: string[] = [];
  const physical = d.interfaces.filter(
    (p) =>
      !p.logical &&
      !p.aggregate &&
      !p.bond &&
      !p.installedNic &&
      !p.tunnel &&
      !p.vxlan &&
      !p.capwapPeer &&
      !p.meshPeer &&
      ['rj45', 'sfp', 'qsfp'].includes(p.media)
  );
  if (
    ['ap', 'mesh', 'wlc', 'phone', 'printer'].includes(profile.id) &&
    physical.some((p) => p.media !== 'rj45')
  ) {
    issues.push(
      'Há portas ópticas herdadas que não pertencem a este perfil. Revise o cabeamento e substitua o equipamento pelo perfil atual do catálogo.'
    );
  }
  if (profile.ports && physical.length > profile.ports) {
    issues.push(
      'A quantidade de portas de rede difere do perfil atual (' +
        profile.ports +
        '). As portas e conexões antigas foram preservadas para revisão.'
    );
  }
  if (profile.id === 'smartphone' && physical.length) {
    issues.push(
      'Este smartphone conserva uma porta Ethernet do modelo antigo. O perfil atual usa somente rádio Wi-Fi.'
    );
  }
  if (['ap', 'mesh', 'wlc'].includes(profile.id) && /^SW-\d+$/.test(d.hostname)) {
    issues.push(
      'O nome automático antigo identifica este equipamento como switch. Use Renomear para identificar seu papel de AP ou controlador WLAN.'
    );
  }
  if (profile.id === 'wlc' && d.wireless)
    issues.push(
      'Um controlador WLC deste perfil não possui rádio local. Os rádios pertencem aos APs gerenciados.'
    );
  return issues;
}
