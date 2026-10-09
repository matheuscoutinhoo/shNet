import type { Snapshot } from './model';
import { deviceProfile } from './devices/profiles';
export interface AnalysisRow {
  device: string;
  values: string[];
}
export const analysisViews = [
  { id: 'protocols', label: 'Protocolos' },
  { id: 'overlays', label: 'Overlays / QoS' },
  { id: 'security', label: 'Segurança / AAA' },
  { id: 'monitoring', label: 'Automação / relógio' },
  { id: 'dependencies', label: 'Dependências' },
];
export function networkAnalysis(s: Snapshot, view: string): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  for (const d of s.devices) {
    const add = (feature: string, state: string, details: string) =>
      rows.push({ device: d.id, values: [d.hostname, feature, state, details] });
    if (view === 'protocols') {
      if (d.bgp)
        for (const peer of d.bgp.peers)
          add(
            'BGP ' + peer.ip,
            peer.state,
            'AS ' +
              d.bgp.neighbors.find((n) => n.ip === peer.ip)?.remoteAs +
              ' · ' +
              d.bgp.routes.length +
              ' rotas'
          );
      if (d.ospf)
        add(
          'OSPF',
          d.ospf.enabled ? 'ativo' : 'desativado',
          d.ospf.routes.length + ' rotas · ' + d.ospf.neighbors.length + ' vizinhos'
        );
      if (d.rip) add('RIP', d.rip.enabled ? 'ativo' : 'desativado', d.rip.table.length + ' entradas');
      if (d.vrrp) for (const g of d.vrrp.groups) add('VRRP ' + g.vrid, g.state, 'VIP ' + g.vip);
      for (const p of d.interfaces) {
        if (p.aggregate)
          add(
            'LACP ' + p.name,
            p.aggregate.selected.length >= p.aggregate.minLinks ? 'up' : 'down',
            p.aggregate.selected.length + '/' + p.aggregate.members.length + ' membros'
          );
        if (p.ipv6)
          add(
            'IPv6 ' + p.name,
            p.adminUp ? 'ativo' : 'desativado',
            p.ipv6.addresses.map((a) => a.ip + '/' + a.prefix + ' ' + a.state).join(', ')
          );
      }
    } else if (view === 'overlays') {
      for (const p of d.interfaces) {
        if (p.tunnel)
          add(
            'Túnel ' + p.name,
            p.tunnel.status,
            p.tunnel.remote + ' · ' + p.tunnel.sent + '/' + p.tunnel.received + ' TX/RX'
          );
        if (p.vxlan)
          add(
            'VNI ' + p.vxlan.vni,
            p.vxlan.enabled ? 'ativo' : 'desativado',
            'VLAN ' +
              p.vxlan.vlan +
              ' · RT ' +
              p.vxlan.routeTarget +
              ' · ' +
              p.vxlan.routes.length +
              ' MACs EVPN · ' +
              p.vxlan.sent +
              '/' +
              p.vxlan.received +
              ' TX/RX'
          );
        if (p.qos)
          add(
            'QoS ' + p.name,
            p.qos.enabled ? p.qos.scheduler : 'desativado',
            p.qos.queues.length + ' em fila · ' + p.qos.stats.reduce((n, c) => n + c.dropped, 0) + ' drops'
          );
      }
      if (d.sdwan)
        add(
          'SD-WAN',
          d.sdwan.enabled ? 'ativo' : 'desativado',
          d.sdwan.selected.map((p) => p.policy + ' → ' + p.port).join(', ')
        );
      if (d.mpls)
        add(
          'MPLS',
          d.mpls.enabled ? 'ativo' : 'desativado',
          d.mpls.ingress.length + ' FECs · ' + d.mpls.lfib.length + ' labels'
        );
      if (d.wireless)
        add(
          'Wi-Fi ' + d.wireless.ssid,
          d.wireless.phase,
          d.wireless.role + ' · canal ' + d.wireless.channel + ' · ' + d.wireless.security
        );
    } else if (view === 'security') {
      if (d.firewall)
        add(
          'Firewall',
          d.firewall.enabled ? 'ativo' : 'desativado',
          d.firewall.sessions.length + ' sessões · ' + d.firewall.dropped + ' drops'
        );
      if (d.firewall?.application)
        add(
          'HTTP/DNS',
          d.firewall.application.enabled ? 'ativo' : 'desativado',
          d.firewall.application.rules.map((r) => r.sequence + ' ' + r.application + ': ' + r.hits).join(', ')
        );
      if (d.aaaServer)
        add(
          'AAA',
          d.aaaServer.enabled ? 'ativo' : 'desativado',
          d.aaaServer.accepted + '/' + d.aaaServer.rejected + ' aceitos/rejeitados'
        );
      if (d.networkAuth)
        add('Login de rede', d.networkAuth.username, 'Privilégio ' + d.networkAuth.privilege);
      for (const p of d.interfaces)
        if (p.dot1x)
          add(
            '802.1X ' + p.name,
            p.dot1x.phase,
            'VLAN ' + p.accessVlan + ' · ' + (p.dot1x.mac ?? 'sem cliente')
          );
    } else if (view === 'monitoring') {
      if (d.remoteManagement)
        add(
          'NETCONF/RESTCONF',
          d.remoteManagement.enabled ? 'ativo' : 'desativado',
          'rev ' +
            d.remoteManagement.revision +
            ' · commits ' +
            d.remoteManagement.commits +
            ' · candidate ' +
            (d.remoteManagement.candidate ? 'pendente' : 'vazio')
        );
      for (const j of d.automationJobs ?? [])
        add('Job ' + j.name, j.status, j.index + '/' + j.steps.length + ' passos');
      if (d.telemetry)
        add(
          'Telemetria',
          d.telemetry.enabled ? 'ativo' : 'desativado',
          d.telemetry.sent + ' datagramas → ' + d.telemetry.collector
        );
      if (d.telemetryCollector)
        add(
          'Coletor',
          d.telemetryCollector.enabled ? 'ativo' : 'desativado',
          d.telemetryCollector.received + '/' + d.telemetryCollector.rejected + ' aceitos/rejeitados'
        );
      if (d.networkClock)
        add(
          'Relógio',
          d.ntp?.synchronized ? 'sincronizado' : d.networkClock.server ? 'servidor' : 'local',
          'offset ' +
            d.networkClock.offsetMs.toFixed(3) +
            ' ms · stratum ' +
            (d.ntp?.stratum ?? d.networkClock.stratum)
        );
      if (d.snmpAgent) add('SNMP', d.snmpAgent.enabled ? 'ativo' : 'desativado', 'GET/GETNEXT em UDP/161');
      if (d.syslogServer)
        add(
          'Syslog',
          d.syslogServer.enabled ? 'ativo' : 'desativado',
          d.syslogServer.entries.length + ' registros'
        );
    } else if (view === 'dependencies') {
      const dependency = (feature: string, ip: string) => {
        const peers = s.devices.filter(
          (n) => n.interfaces.some((p) => p.ip === ip) || n.vrrp?.groups.some((g) => g.vip === ip)
        );
        add(
          feature,
          peers.length
            ? peers.some((n) => n.power)
              ? 'equipamento presente'
              : 'desligado'
            : 'não localizado',
          ip + ' · ' + peers.map((n) => n.hostname).join(', ')
        );
      };
      if (d.gateway) dependency('Gateway do equipamento', d.gateway);
      for (const p of d.interfaces) {
        if (p.gateway) dependency('Gateway ' + p.name, p.gateway);
        for (const ip of p.dns ?? []) dependency('DNS ' + p.name, ip);
        if (p.tunnel) dependency('Underlay ' + p.name, p.tunnel.remote);
        for (const ip of p.vxlan?.peers ?? []) dependency('VTEP ' + p.vxlan!.vni, ip);
        if (p.dot1x) dependency('RADIUS ' + p.name, p.dot1x.server);
      }
      for (const r of d.routes) dependency('Rota ' + r.network + '/' + r.prefix, r.nextHop);
      for (const p of d.bgp?.peers ?? []) dependency('Peer BGP', p.ip);
      for (const ip of d.ntp?.servers ?? []) dependency('NTP', ip);
      if (d.telemetry) dependency('Coletor de telemetria', d.telemetry.collector);
      if (d.aaaClient) dependency('AAA', d.aaaClient.server);
    }
  }
  return rows;
}
export function deviceModel(s: Snapshot, id: string) {
  const d = s.devices.find((d) => d.id === id);
  return d ? (deviceProfile(d)?.model ?? d.type) : 'desconhecido';
}
