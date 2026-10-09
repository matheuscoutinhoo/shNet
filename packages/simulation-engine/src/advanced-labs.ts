import type { SimulationEngine } from './core/engine';
import type { LabId, LabTaskResult } from './labs';
import { bgpConfig } from './protocols/bgp';
import { ipv6Config } from './protocols/ipv6-control';
import { wirelessConfig } from './protocols/wireless';
import { tunnelConfig } from './protocols/tunnel';
import { qosConfig } from './protocols/qos';
import { supplicantConfig } from './protocols/dot1x';
import { remoteConfig } from './protocols/remote';
export const advancedLabs = [
  {
    id: 'bgp-repair',
    name: 'Anúncios entre sistemas autônomos',
    category: 'Roteamento',
    template: 'bgp',
    objective: 'Reative BGP no primeiro roteador. Valide sessão, rota aprendida e HTTP.',
    difficulty: 'Avançado',
  },
  {
    id: 'ospf-repair',
    name: 'Adjacência e caminho OSPF',
    category: 'Roteamento',
    template: 'ospf',
    objective: 'Reative OSPF no último roteador e valide adjacência, rota e HTTP.',
    difficulty: 'Avançado',
  },
  {
    id: 'rip-repair',
    name: 'A rota precisa ser anunciada',
    category: 'Roteamento',
    template: 'rip',
    objective: 'Reative RIP no último roteador; valide anúncio, tabela e tráfego.',
    difficulty: 'Avançado',
  },
  {
    id: 'svi-repair',
    name: 'O switch é o gateway',
    category: 'Switching',
    template: 'svi',
    objective: 'Habilite ip routing em SW-L3 e valide HTTP entre VLANs.',
    difficulty: 'Avançado',
  },
  {
    id: 'vrf-isolation',
    name: 'Dois destinos com o mesmo IP',
    category: 'Virtualização',
    template: 'vrf',
    objective: 'Reative Gi0/1 em R-VRF. Consulte HTTP em BLUE e RED, mantendo as respostas isoladas.',
    difficulty: 'Avançado',
  },
  {
    id: 'lacp-repair',
    name: 'Agregação precisa negociar',
    category: 'Switching',
    template: 'lacp',
    objective:
      'SW-A foi colocado em passive, como SW-B. Configure active e valide HTTP após falha de um membro.',
    difficulty: 'Avançado',
  },
  {
    id: 'gateway-tracking',
    name: 'Eleição com falha no uplink',
    category: 'Redundância',
    template: 'vrrp-track',
    objective:
      'Restabeleça o gateway 192.168.10.1 do PC. Valide redução de prioridade e HTTP após falha no uplink do primário.',
    difficulty: 'Avançado',
  },
  {
    id: 'ipv6-slaac',
    name: 'O anúncio cria o endereço',
    category: 'IPv6',
    template: 'ipv6',
    objective: 'Ative SLAAC no PC-V6-A. Valide RA, endereço, NDP e ping entre sub-redes.',
    difficulty: 'Avançado',
  },
  {
    id: 'wireless-repair',
    name: 'A credencial abre o rádio',
    category: 'Wireless',
    template: 'wireless',
    objective: 'Corrija a chave do NOTEBOOK para Wireless-123; valide associação e HTTP pelo rádio.',
    difficulty: 'Avançado',
  },
  {
    id: 'vpn-repair',
    name: 'Um túnel precisa de dois peers',
    category: 'VPN',
    template: 'vpn',
    objective: 'Corrija a chave do túnel de WAN-A para Tunnel-Key-123. Valide negociação e HTTP encapsulado.',
    difficulty: 'Avançado',
  },
  {
    id: 'sdwan-repair',
    name: 'Política distribuída e caminho medido',
    category: 'SD-WAN',
    template: 'sdwan',
    objective:
      'Reative o controller WAN-CONTROLLER. Valide política recebida, seleção por SLA e HTTP após falha do primeiro transporte.',
    difficulty: 'Avançado',
  },
  {
    id: 'qos-repair',
    name: 'O tráfego entra na fila',
    category: 'QoS',
    template: 'qos',
    objective: 'Reative QoS em Gi0/2 de QOS-EDGE. Valide marcação DSCP e transmissão pela fila.',
    difficulty: 'Avançado',
  },
  {
    id: 'mpls-repair',
    name: 'A LFIB encaminha o label',
    category: 'MPLS',
    template: 'mpls',
    objective: 'Reative MPLS no roteador intermediário. Valide swap/pop e HTTP entre LANs.',
    difficulty: 'Avançado',
  },
  {
    id: 'evpn-repair',
    name: 'Route targets precisam combinar',
    category: 'EVPN',
    template: 'evpn',
    objective: 'Corrija o route target de VTEP-A para 65000:10010. Valide anúncio MAC/IP e HTTP pelo VNI.',
    difficulty: 'Avançado',
  },
  {
    id: 'aaa-repair',
    name: 'Autorização antes do tráfego',
    category: 'Segurança',
    template: 'aaa',
    objective: 'Corrija a senha do supplicant PC-8021X para rede123. Valide RADIUS, VLAN 20 e HTTP.',
    difficulty: 'Avançado',
  },
  {
    id: 'inspection-repair',
    name: 'A regra conhece a aplicação',
    category: 'Segurança',
    template: 'inspection',
    objective:
      'Reative a inspeção de aplicação na borda. Permita allowed.lab e bloqueie blocked.lab pelo Host HTTP.',
    difficulty: 'Avançado',
  },
  {
    id: 'automation-repair',
    name: 'Candidate até commit',
    category: 'Automação',
    template: 'automation',
    objective:
      'Reative NETCONF/RESTCONF em R-EDGE-01. A avaliação executa edit-config, validate e commit; verifica NTP e telemetria.',
    difficulty: 'Avançado',
  },
] as const;
export function prepareAdvancedLab(id: string, e: SimulationEngine) {
  const routers = e.state.devices.filter((d) => d.type === 'router'),
    pc = e.state.devices.find((d) => d.type === 'pc')!;
  if (id === 'bgp-repair') {
    const d = routers[0];
    e.configureBgp(d.id, { ...bgpConfig(d)!, enabled: false });
  }
  if (id === 'ospf-repair') {
    const d = routers.at(-1)!;
    e.configureOspf(d.id, { enabled: false, routerId: d.ospf!.routerId, interfaces: d.ospf!.interfaces });
  }
  if (id === 'rip-repair') {
    const d = routers.at(-1)!;
    e.configureRip(d.id, { enabled: false, interfaces: d.rip!.interfaces });
  }
  if (id === 'svi-repair') e.state.devices.find((d) => d.type === 'switch')!.ipRouting = false;
  if (id === 'vrf-isolation') e.setPort(routers[0].id, 'p0', false);
  if (id === 'lacp-repair')
    e.configureLacp(e.state.devices.find((d) => d.hostname === 'SW-A')!.id, 1, 'passive', ['p0', 'p1']);
  if (id === 'gateway-tracking') pc.gateway = '192.168.10.99';
  if (id === 'ipv6-slaac') e.configureIpv6(pc.id, 'p0', { ...ipv6Config(pc.interfaces[0]), auto: false });
  if (id === 'wireless-repair') e.configureWireless(pc.id, { ...wirelessConfig(pc), key: 'incorrect-key' });
  if (id === 'vpn-repair') {
    const p = routers[0].interfaces.find((p) => p.tunnel)!;
    e.configureTunnel(routers[0].id, { ...tunnelConfig(p), key: 'incorrect-key' });
  }
  if (id === 'sdwan-repair') {
    const d = e.state.devices.find((d) => d.sdwanController)!;
    e.configureSdwanController(d.id, { ...d.sdwanController, enabled: false });
  }
  if (id === 'qos-repair') {
    const d = routers[0],
      p = d.interfaces.find((p) => p.qos)!;
    e.configureQos(d.id, p.id, { ...qosConfig(p), enabled: false });
  }
  if (id === 'mpls-repair') {
    const d = routers[1];
    e.configureMpls(d.id, { ...d.mpls!, enabled: false });
  }
  if (id === 'evpn-repair') {
    const d = e.state.devices.find((d) => d.hostname === 'VTEP-A')!,
      p = d.interfaces.find((p) => p.vxlan)!;
    p.vxlan!.routeTarget = '65000:999';
  }
  if (id === 'aaa-repair') {
    const p = pc.interfaces.find((p) => p.supplicant)!;
    e.configureSupplicant(pc.id, p.id, { ...supplicantConfig(p), password: 'incorrect' });
  }
  if (id === 'inspection-repair') routers[0].firewall!.application!.enabled = false;
  if (id === 'automation-repair')
    e.configureRemote(routers[0].id, { ...remoteConfig(routers[0]), enabled: false });
  const spec = advancedLabs.find((l) => l.id === id);
  if (spec)
    e.state.notes =
      spec.objective +
      '\n\nA avaliação cria tráfego novo em uma cópia: resultados anteriores não concluem tarefas. Consulte o painel do protocolo, a CLI e a timeline para encontrar a causa.';
}
export function evaluateAdvancedLab(id: string, e: SimulationEngine) {
  const tasks: LabTaskResult[] = [],
    add = (id: string, label: string, passed: boolean) => tasks.push({ id, label, passed });
  const routers = e.state.devices.filter((d) => d.type === 'router'),
    pc = e.state.devices.find((d) => d.type === 'pc'),
    server = e.state.devices.find(
      (d) => d.type === 'server' && d.tcpServices?.some((s) => s.kind === 'http' && s.enabled)
    );
  const safe = (fn: () => boolean) => {
    try {
      return fn();
    } catch {
      return false;
    }
  };
  const advance = (ms = 3000) => e.advanceTo(e.state.clock + ms, 20000);
  const http = (host?: string, source = pc, target = server?.interfaces[0].ip, vrf?: string) =>
    safe(() => {
      if (!source || !target) return false;
      const q = e.httpGet(source.id, target, 80, '/', vrf, host);
      advance(id === 'qos-repair' ? 12000 : 3000);
      return (
        e
          .device(source.id)
          .tcpConnections?.find((c) => c.id === q)
          ?.received.startsWith('HTTP/1.1 200') ?? false
      );
    });
  const seen = (type: string) => e.state.events.some((v) => v.type === type);
  if (['bgp-repair', 'ospf-repair', 'rip-repair'].includes(id)) {
    const protocol = id.split('-')[0] as 'bgp' | 'ospf' | 'rip';
    add(
      'control',
      'Restabelecer troca do protocolo de roteamento',
      routers.length >= 2 &&
        routers.every((d) =>
          protocol === 'bgp'
            ? d.bgp?.peers.some((p) => p.state === 'Established')
            : protocol === 'ospf'
              ? d.ospf?.neighbors.some((n) => n.state === 'Full')
              : d.rip?.enabled
        )
    );
    add('forwarding', 'Entregar HTTP por rotas aprendidas', http());
    add(
      'routes',
      'Instalar rotas dinâmicas de alcance remoto',
      routers.some((d) =>
        protocol === 'bgp'
          ? !!d.bgp?.routes.length
          : protocol === 'ospf'
            ? !!d.ospf?.routes.length
            : !!d.rip?.table.some((r) => r.metric < 16)
      )
    );
  } else if (id === 'svi-repair') {
    add(
      'routing',
      'Habilitar roteamento no switch L3',
      e.state.devices.some((d) => d.type === 'switch' && d.ipRouting)
    );
    add('http', 'Entregar HTTP entre VLANs', http());
    add(
      'svi',
      'Resolver gateways de interfaces VLAN',
      e.state.devices.some(
        (d) => d.interfaces.some((p) => p.logical?.kind === 'svi') && d.arpTable.length >= 2
      )
    );
  } else if (id === 'vrf-isolation') {
    const r = routers[0];
    const blue = http(undefined, r, '10.0.0.2', 'BLUE'),
      red = http(undefined, r, '10.0.0.2', 'RED');
    add('http-blue', 'Entregar HTTP dentro da VRF BLUE', blue);
    add('http-red', 'Entregar HTTP dentro da VRF RED', red);
    add(
      'isolation',
      'Receber a resposta específica de cada tabela',
      !!r &&
        ['BLUE', 'RED'].every((v) =>
          r.tcpConnections?.some((c) => c.vrf === v && c.received.includes('Resposta da VRF ' + v))
        )
    );
  } else if (id === 'lacp-repair') {
    const sw = e.state.devices.filter((d) => d.type === 'switch');
    add(
      'negotiated',
      'Negociar dois membros LACP',
      sw.length >= 2 && sw.every((d) => d.interfaces.some((p) => p.aggregate?.selected.length === 2))
    );
    add('http', 'Entregar HTTP pelo agregado', http());
    safe(() => {
      const d = sw[0];
      if (!d) return false;
      e.setPort(d.id, 'p0', false);
      advance(4000);
      return true;
    });
    add(
      'failover',
      'Entregar novo HTTP com apenas um membro',
      http() &&
        sw.length >= 2 &&
        sw.every((d) => d.interfaces.some((p) => p.aggregate?.selected.length === 1))
    );
  } else if (id === 'gateway-tracking') {
    add('http', 'Entregar HTTP pelo gateway virtual', http());
    const r = e.state.devices.find((d) => d.hostname === 'R-PRIMARY');
    safe(() => {
      if (!r) return false;
      e.setPort(r.id, 'p1', false);
      advance(8000);
      return true;
    });
    add(
      'track',
      'Reduzir prioridade e eleger o backup com primário ligado',
      !!r &&
        r.power &&
        r.vrrp?.groups[0].effectivePriority === 70 &&
        e.state.devices.some((d) => d.hostname === 'R-BACKUP' && d.vrrp?.groups[0].state === 'ACTIVE')
    );
    add('failover', 'Entregar HTTP após falha no uplink', http());
  } else if (id === 'ipv6-slaac') {
    const hosts = e.state.devices.filter((d) => d.type === 'pc'),
      target = hosts[1]?.interfaces[0].ipv6?.addresses.find(
        (a) => a.origin === 'slaac' && a.state === 'preferred'
      );
    add(
      'slaac',
      'Receber endereço global por RA/SLAAC',
      hosts.length === 2 &&
        hosts.every((d) =>
          d.interfaces[0].ipv6?.addresses.some((a) => a.origin === 'slaac' && a.state === 'preferred')
        )
    );
    add(
      'ping6',
      'Entregar ping ICMPv6 entre sub-redes',
      safe(() => {
        if (!pc || !target) return false;
        const q = e.ping6(pc.id, target.ip);
        advance();
        return e.state.probes6?.find((p) => p.id === q)?.status === 'success';
      })
    );
    add('ndp', 'Resolver próximo salto por NDP', !!pc?.neighbors6?.length);
  } else if (id === 'wireless-repair') {
    add('association', 'Concluir autenticação e associação', pc?.wireless?.phase === 'associated');
    add('http', 'Entregar HTTP pelo enlace de rádio', http());
    add(
      'radio',
      'Transmitir frames protegidos no rádio',
      e.state.events.some((v) => v.frame?.etherType === '802.11-secure')
    );
  } else if (id === 'vpn-repair' || id === 'sdwan-repair') {
    add(
      'tunnel',
      'Estabelecer os peers do túnel',
      routers.length >= 2 && routers.every((d) => d.interfaces.some((p) => p.tunnel?.status === 'up'))
    );
    add('http', 'Entregar HTTP encapsulado no underlay', http());
    if (id === 'sdwan-repair') {
      const r = routers[0];
      add(
        'policy',
        'Receber política do controller e selecionar transporte',
        !!r?.sdwan?.receivedPolicies.length && !!r.sdwan.selected.length
      );
      safe(() => {
        if (!r) return false;
        e.setPort(r.id, 'p1', false);
        advance(7000);
        return true;
      });
      add(
        'failover',
        'Entregar novo HTTP pelo transporte restante',
        http() &&
          !!r?.sdwan?.selected.some((s) => s.port !== r.interfaces.find((p) => p.tunnel?.number === 1)?.id)
      );
    } else add('encapsulation', 'Observar transporte cifrado do modelo', seen('TUNNEL_SENT'));
  } else if (id === 'qos-repair') {
    add('http', 'Entregar HTTP passando pela fila', http());
    const p = routers[0]?.interfaces.find((p) => p.qos);
    add(
      'queue',
      'Classificar/enfileirar e servir frames novos',
      !!p?.qos?.stats.some((s) => s.name === 'WEB' && s.enqueued > 0 && s.dequeued > 0)
    );
    add(
      'dscp',
      'Marcar DSCP 46 no tráfego transmitido',
      e.state.events.some((v) => v.type === 'FRAME_SENT' && v.frame?.packet?.dscp === 46)
    );
  } else if (id === 'mpls-repair') {
    add('http', 'Entregar HTTP entre os LERs', http());
    add('swap', 'Trocar label na LFIB intermediária', seen('MPLS_SWAP'));
    add('pop', 'Remover label na saída', seen('MPLS_POP'));
  } else if (id === 'evpn-repair') {
    add('http', 'Entregar HTTP pelo VNI', http());
    add(
      'evpn',
      'Aprender MAC/IP remoto pelo BGP/EVPN',
      e.state.devices.filter((d) => d.interfaces.some((p) => p.vxlan)).length >= 2 &&
        e.state.devices
          .filter((d) => d.interfaces.some((p) => p.vxlan))
          .every((d) => d.interfaces.some((p) => p.vxlan?.routes.some((r) => !!r.ip)))
    );
    add('vxlan', 'Transportar frames em UDP/4789', seen('VXLAN_ENCAP'));
  } else if (id === 'aaa-repair') {
    const sw = e.state.devices.find((d) => d.type === 'switch');
    add(
      'radius',
      'Receber autorização RADIUS real',
      e.state.devices.some((d) => (d.aaaServer?.accepted ?? 0) > 0)
    );
    add(
      'vlan',
      'Abrir a porta e atribuir VLAN 20',
      !!sw?.interfaces.some((p) => p.dot1x?.phase === 'authorized' && p.accessVlan === 20)
    );
    add('http', 'Entregar HTTP após autorização', http(undefined, pc, '10.20.0.20'));
  } else if (id === 'inspection-repair') {
    add('allow', 'Entregar HTTP com Host permitido', http('allowed.lab'));
    const count = e.state.events.filter(
      (v) => v.type === 'FIREWALL_DENY' && v.reason.includes('Inspeção')
    ).length;
    http('blocked.lab');
    add(
      'deny',
      'Negar HTTP pelo conteúdo Host, mantendo o serviço acessível',
      e.state.events.filter((v) => v.type === 'FIREWALL_DENY' && v.reason.includes('Inspeção')).length > count
    );
    add('rule', 'Ativar inspeção de aplicação', !!routers[0]?.firewall?.application?.enabled);
  } else if (id === 'automation-repair') {
    const r = routers[0];
    add(
      'commit',
      'Executar candidate/validate/commit pela rede',
      safe(() => {
        if (!pc || !r) return false;
        const q = e.runAutomation(pc.id, {
          name: 'avaliação',
          username: 'admin',
          password: 'rede-admin',
          key: 'remote-key',
          steps: [
            {
              target: r.interfaces[0].ip,
              protocol: 'netconf',
              operation: 'edit-config',
              datastore: 'candidate',
              patch: { hostname: 'R-AUTOMATED' },
            },
            { target: r.interfaces[0].ip, protocol: 'netconf', operation: 'validate' },
            { target: r.interfaces[0].ip, protocol: 'netconf', operation: 'commit' },
          ],
        });
        advance(12000);
        return (
          pc.automationJobs?.find((j) => j.id === q)?.status === 'success' && r.remoteManagement!.commits > 0
        );
      })
    );
    add(
      'ntp',
      'Sincronizar offset e stratum por NTP',
      !!pc?.ntp?.synchronized && Math.abs(pc.networkClock!.offsetMs) < 1
    );
    add(
      'telemetry',
      'Coletar sensores pela rede',
      e.state.devices.some((d) => (d.telemetryCollector?.received ?? 0) > 0)
    );
    add('http', 'Preservar HTTP após o commit', http());
  }
  const passed = tasks.filter((t) => t.passed).length;
  return {
    labId: id as LabId,
    tasks,
    passed,
    total: tasks.length,
    complete: tasks.length > 0 && passed === tasks.length,
  };
}
