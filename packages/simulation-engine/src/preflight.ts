import type { Snapshot } from './model';
import { linkOperational } from './links/physical';
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
  for (const d of s.devices) {
    for (const p of d.interfaces.filter((p) => p.ip)) {
      const key = `${p.vrf ?? 'default'}:${p.ip}`;
      addresses.set(key, [...(addresses.get(key) ?? []), d.id]);
    }
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
        'Verifique se pertencem ao mesmo domínio L2; corrija conflitos ou documente redes isoladas.'
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
