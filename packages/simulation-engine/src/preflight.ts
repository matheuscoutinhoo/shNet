import type { Snapshot } from './model';
import { linkOperational } from './links/physical';
import { networkDomains } from './network-domains';
import { ipNumber } from './protocols/ipv4';
export interface PreflightIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  devices: string[];
  message: string;
  recommendation: string;
}
export function preflight(s: Snapshot): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const add = (
    code: string,
    severity: PreflightIssue['severity'],
    devices: string[],
    message: string,
    recommendation: string
  ) => issues.push({ code, severity, devices, message, recommendation });
  const addresses = new Map<string, string[]>();
  const domain = networkDomains(s);
  for (const d of s.devices) {
    for (const p of d.interfaces.filter((p) => p.ip)) {
      const key = `${domain(d, p)}:${p.ip}`;
      addresses.set(key, [...(addresses.get(key) ?? []), d.id]);
      const gateway = p.gateway ?? (!p.vrf ? d.gateway : undefined);
      if (gateway) {
        const available = s.devices.some((x) =>
          x.interfaces.some(
            (q) =>
              domain(x, q) === domain(d, p) &&
              (q.ip === gateway || x.vrrp?.groups.some((g) => g.port === q.id && g.vip === gateway))
          )
        );
        if (!available)
          add(
            'GATEWAY_NOT_IN_DOMAIN',
            'warning',
            [d.id],
            `${d.hostname}/${p.name}: gateway ${gateway} não encontrado no domínio Ethernet.`,
            'Confira VLAN, máscara, associação Wi-Fi e gateway. A análise usa configuração potencial e associações presentes; não certifica alcance nem um gateway externo ao snapshot.'
          );
      }
    }
    for (const p of d.interfaces.filter((p) => p.vxlan)) {
      if (p.vxlan) {
        const source = d.interfaces.find((q) => q.id === p.vxlan!.underlay),
          carriers = source?.loopback
            ? d.interfaces.filter(
                (q) => q.mode === 'routed' && !q.loopback && !q.logical && !q.tunnel && !q.vxlan
              )
            : source
              ? [source]
              : [];
        for (const q of carriers)
          if (p.mtu + 50 > q.mtu)
            add(
              'VXLAN_UNDERLAY_MTU',
              'warning',
              [d.id],
              `${d.hostname}: MTU VXLAN ${p.mtu} + 50 excede ${q.name} (${q.mtu}).`,
              'Aumente a MTU dos caminhos de underlay ou reduza a MTU de tenant; teste pacotes DF e mensagens pequenas com padding Ethernet.'
            );
      }
    }

    if (d.interfaces.some((p) => p.ip) && !d.infrastructure) {
      const supplies = s.devices.filter(
        (x) => x.infrastructure?.kind === 'ups' && x.infrastructure.loads.some((l) => l.device === d.id)
      );
      if (supplies.length === 1)
        add(
          'SINGLE_POWER_SOURCE',
          'warning',
          [d.id, supplies[0].id],
          `${d.hostname}: uma única UPS alimenta a carga.`,
          'Se o SLA exige A/B, associe duas UPS independentes e teste a perda de cada uma e de ambas. Cada fonte reserva a potência nominal integral.'
        );
    }
    if (
      d.infrastructure?.kind === 'ups' &&
      d.infrastructure.loads.filter((l) => l.requested).reduce((n, l) => n + l.watts, 0) >
        d.infrastructure.maxWatts
    )
      add(
        'UPS_OVERLOAD',
        'error',
        [d.id],
        `${d.hostname}: cargas solicitadas excedem a potência máxima.`,
        'Redimensione a UPS e valide a carga integral com a outra fonte indisponível.'
      );
    if (
      !d.infrastructure &&
      d.interfaces.some((p) => p.ip) &&
      s.links.filter((l) => l.a.device === d.id || l.b.device === d.id).length === 1
    )
      add(
        'SINGLE_ATTACHMENT',
        'warning',
        [d.id],
        `${d.hostname}: apenas um caminho físico de acesso.`,
        'Verifique se o SLA exige interface, switch e alimentação redundantes.'
      );
    if (
      d.type === 'switch' &&
      !d.infrastructure &&
      s.links.filter((l) => l.a.device === d.id || l.b.device === d.id).length > 2
    )
      add(
        'SWITCH_FAILURE_DOMAIN',
        'info',
        [d.id],
        `${d.hostname}: múltiplos enlaces compartilham o mesmo equipamento.`,
        'Dois uplinks não protegem contra falha deste switch; teste a perda de equipamento e energia.'
      );
    for (const route of d.routes) {
      const gateway = route.nextHop;
      if (!gateway) continue;
      const peer = s.devices.find(
        (x) =>
          x.interfaces.some((p) => p.ip === gateway) &&
          x.vrrp?.groups.some((g) => x.interfaces.find((p) => p.id === g.port)?.ip === gateway)
      );
      if (peer)
        add(
          'PHYSICAL_HA_NEXT_HOP',
          'warning',
          [d.id, peer.id],
          `${d.hostname}: rota ${route.network}/${route.prefix} aponta para ${gateway}, IP físico de um participante VRRP.`,
          'Avalie usar o VIP como próximo salto e valide o caminho de retorno após failover.'
        );
    }
    for (const group of d.vrrp?.groups ?? []) {
      const p = d.interfaces.find((p) => p.id === group.port);
      if (!p?.dhcpRelay?.length) continue;
      const peers = s.devices.filter(
        (x) => x.id !== d.id && x.vrrp?.groups.some((g) => g.vip === group.vip && g.vrid === group.vrid)
      );
      for (const peer of peers) {
        const counterpart = peer.vrrp!.groups.find((g) => g.vip === group.vip && g.vrid === group.vrid)!;
        if (!peer.interfaces.find((p) => p.id === counterpart.port)?.dhcpRelay?.length)
          add(
            'RELAY_NOT_REDUNDANT',
            'warning',
            [d.id, peer.id],
            `VIP ${group.vip}: relay DHCP configurado somente em ${d.hostname}.`,
            'Configure o relay e pools compatíveis no backup; teste novas concessões após falha do primário.'
          );
      }
    }
    for (const p of d.interfaces.filter((p) => p.dhcpRelay?.length && p.ip)) {
      const servers = s.devices.filter(
        (x) => x.dhcpServer?.enabled && x.interfaces.some((q) => p.dhcpRelay!.includes(q.ip ?? ''))
      );
      if (servers.length < 2)
        add(
          'RELAY_SINGLE_SERVER',
          'warning',
          [d.id, ...servers.map((x) => x.id)],
          `${d.hostname}/${p.name}: relay depende de ${servers.length} servidor(es) DHCP disponível(is) na configuração.`,
          'Configure destinos e escopos redundantes; valide continuidade de leases, renovação e rebinding.'
        );
      for (const server of servers)
        if (
          !server.dhcpServer!.pools.some(
            (pool) => pool.relayAddress === p.ip || (pool.relayAddresses ?? []).includes(p.ip!)
          )
        )
          add(
            'RELAY_SCOPE_MISSING',
            'error',
            [d.id, server.id],
            `${d.hostname}/${p.name}: giaddr ${p.ip} sem pool em ${server.hostname}.`,
            'Inclua o giaddr do backup em relayAddresses do mesmo pool; para pools separados, use intervalos sem sobreposição.'
          );
    }
    for (const p of d.interfaces.filter((p) => p.vxlan?.enabled && p.vxlan.evpn)) {
      const v = p.vxlan!;
      if (v.peerPolicy !== 'evpn')
        add(
          'EVPN_STATIC_FLOODING',
          'warning',
          [d.id],
          `${d.hostname}: VNI ${v.vni} usa flooding/learning estático; RT limita importação de controle.`,
          'Use peerPolicy evpn para exigir membros IMET importados no plano de dados; valide isolamento também por VNI/VRF/ACL.'
        );
      for (const peer of s.devices.filter((x) => x.id !== d.id))
        for (const q of peer.interfaces.filter(
          (q) => q.vxlan?.vni === v.vni && q.vxlan.routeTarget !== v.routeTarget
        ))
          add(
            'EVPN_RT_MISMATCH',
            'warning',
            [d.id, peer.id],
            `VNI ${v.vni}: RT ${v.routeTarget}/${q.vxlan!.routeTarget} divergente.`,
            'Confira importação/exportação e política de flooding. RIB vazia não comprova isolamento no modo estático.'
          );
      const carrier = d.interfaces.find((q) => q.id === v.underlay);
      if (!carrier?.loopback)
        add(
          'VTEP_SINGLE_INTERFACE',
          'warning',
          [d.id],
          `${d.hostname}: VTEP vinculado à interface física ${carrier?.name ?? v.underlay}.`,
          'Use loopback /32 e rotas de retorno por caminhos operacionais independentes.'
        );
    }
    for (const rule of d.firewall?.zonePolicy?.rules ?? []) {
      if (
        d.firewall?.enabled &&
        /^(wifi|guest|guests|visitantes)$/i.test(rule.from) &&
        /^(dmz|ot|scada|a|b|cell.*|celula.*)$/i.test(rule.to) &&
        rule.action !== 'deny'
      )
        add(
          'GUEST_SENSITIVE_ZONE',
          'warning',
          [d.id],
          `${d.hostname}: regra ${rule.sequence} permite ${rule.from} → ${rule.to}.`,
          'Revise o acesso de visitantes a zonas sensíveis. Uma permissão por zona pode incluir MES e PLC; valide os destinos com cenários negativos.'
        );
    }
    if (d.firewall?.enabled && d.firewall.application?.enabled && d.interfaces.some((p) => p.ipv6))
      add(
        'IPV6_APPLICATION_INSPECTION_UNSUPPORTED',
        'warning',
        [d.id],
        `${d.hostname}: inspeção de aplicação usa somente IPv4; zonas de trânsito cobrem IPv4/IPv6.`,
        'Configure ACL/zonas IPv6 equivalentes ou recuse o caso que depende de inspeção de aplicação em IPv6.'
      );
    if (d.type === 'switch' && d.ipRouting && !d.firewall)
      add(
        'FIREWALL_CAPABILITY',
        'info',
        [d.id],
        `${d.hostname}: switch L3 encaminha IP; firewall stateful de trânsito requer roteador no modelo atual.`,
        'Use ACLs no switch ou um perfil firewall dedicado para inspeção stateful.'
      );
  }
  for (const [ip, devices] of addresses)
    if (devices.length > 1)
      add(
        'DUPLICATE_IP',
        'warning',
        [...new Set(devices)],
        `Endereço IPv4 repetido no contexto ${ip}.`,
        'Os endereços compartilham o domínio Ethernet inferido dos enlaces/VLANs/VNIs configurados; corrija a colisão.'
      );
  const pools = s.devices.flatMap((d) =>
    (d.dhcpServer?.enabled ? d.dhcpServer.pools : []).map((pool) => {
      const relay = s.devices
        .flatMap((x) => x.interfaces.map((p) => ({ d: x, p })))
        .find((x) => x.p.ip === pool.relayAddress);
      const p = d.interfaces.find((p) => p.id === pool.port)!;
      return { d, pool, context: relay ? domain(relay.d, relay.p) : domain(d, p) };
    })
  );
  for (const [i, a] of pools.entries())
    for (const b of pools.slice(i + 1))
      if (
        a.context === b.context &&
        ipNumber(a.pool.start) <= ipNumber(b.pool.end) &&
        ipNumber(b.pool.start) <= ipNumber(a.pool.end)
      )
        add(
          'DHCP_SCOPE_OVERLAP',
          'error',
          [a.d.id, b.d.id],
          `Pools ${a.pool.name}/${b.pool.name}: intervalos sobrepostos no mesmo domínio.`,
          'Use ranges distintos ou implemente replicação autoritativa de leases antes de habilitar ambos os servidores.'
        );
  for (const l of s.links) {
    const a = s.devices.find((d) => d.id === l.a.device)?.interfaces.find((p) => p.id === l.a.port);
    const b = s.devices.find((d) => d.id === l.b.device)?.interfaces.find((p) => p.id === l.b.port);
    if (!a || !b) {
      add(
        'INVALID_ENDPOINT',
        'error',
        [l.a.device, l.b.device],
        `Enlace ${l.id}: referência de interface inexistente.`,
        'Reconecte o enlace a interfaces válidas.'
      );
      continue;
    }
    if (a.mode === 'trunk' && b.mode === 'trunk' && a.nativeVlan !== b.nativeVlan)
      add(
        'NATIVE_VLAN_MISMATCH',
        'error',
        [l.a.device, l.b.device],
        `Enlace ${l.id}: VLANs nativas ${a.nativeVlan}/${b.nativeVlan} diferentes.`,
        'Alinhe as VLANs nativas nas duas extremidades.'
      );
    if (l.up && !linkOperational(s, l))
      add(
        'INOPERATIVE_LINK',
        'warning',
        [l.a.device, l.b.device],
        `Enlace ${l.id}: habilitado, porém fisicamente inoperante.`,
        'Verifique energia, interface, mídia e distância.'
      );
  }
  for (const service of ['dnsServer', 'dhcpServer', 'broker', 'database', 'proxy', 'syslogServer'] as const) {
    const instances = s.devices.filter((d) => d[service]?.enabled);
    if (instances.length === 1)
      add(
        'SINGLE_SERVICE',
        'warning',
        [instances[0].id],
        `${instances[0].hostname}: única instância habilitada de ${service}.`,
        'Verifique dependentes, estado/dados e estratégia de redundância; duplicar o dispositivo não basta.'
      );
  }
  const radios = s.devices.filter((d) => d.wireless);
  if (radios.some((d) => d.physicalPosition) && radios.some((d) => !d.physicalPosition))
    add(
      'MIXED_RF_COORDINATES',
      'warning',
      radios.filter((d) => !d.physicalPosition).map((d) => d.id),
      'Posições físicas RF não configuradas em todos os rádios.',
      'Configure todos os pares em metros; pares incompletos ainda usam as coordenadas do desenho.'
    );
  return issues;
}
