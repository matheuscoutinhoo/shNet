import type { NetworkEvent } from '@shlab/engine';

export const wifiMessages: Record<string, string> = {
  beacon: 'Anúncio da rede (beacon)',
  'auth-request': 'Pedido de autenticação',
  'auth-response': 'Resposta de autenticação',
  'association-request': 'Pedido de associação',
  'association-response': 'Resposta de associação',
  'sae-commit': 'Troca inicial de autenticação SAE',
  'sae-confirm': 'Confirmação SAE',
  authorized: 'Acesso autorizado',
  reject: 'Acesso recusado',
  deauth: 'Encerramento da autenticação',
  keepalive: 'Verificação de presença',
  eap: 'Mensagem de autenticação empresarial EAP',
  key1: 'Negociação de chave — etapa 1',
  key2: 'Negociação de chave — etapa 2',
  key3: 'Negociação de chave — etapa 3',
  key4: 'Negociação de chave — etapa 4',
};
export const ipv6Messages: Record<string, string> = {
  ns: 'Solicitação de vizinho: procura ou verifica uma interface IPv6 local',
  na: 'Anúncio de vizinho: informa a presença e o MAC de uma interface IPv6',
  rs: 'Solicitação de roteador: pede informação de configuração da rede',
  ra: 'Anúncio de roteador: informa presença, prefixos e seus prazos',
  'echo-request': 'Pedido de resposta para testar comunicação IPv6',
  'echo-reply': 'Resposta ao teste de comunicação IPv6',
  unreachable: 'Aviso de destino inalcançável',
  'time-exceeded': 'Aviso de limite de saltos esgotado',
  'packet-too-big': 'Aviso de pacote maior que a MTU do caminho',
  tcp: 'Segmento TCP transportado por IPv6',
  udp: 'Datagrama UDP transportado por IPv6',
};
const stages: Record<string, string> = {
  SENT: 'mensagem enviada',
  RECEIVED: 'mensagem recebida',
  FLOODED: 'quadro distribuído às portas elegíveis',
  REQUEST: 'solicitação iniciada',
  RESPONSE: 'resposta registrada',
  QUERY: 'consulta iniciada',
  ANSWER: 'resposta processada',
  PERMIT: 'tráfego permitido pela regra',
  TRANSLATED: 'endereço traduzido',
  EXPIRED: 'validade encerrada',
  STATE: 'estado registrado',
  CHANGED: 'estado alterado',
  SCAN: 'ciclo executado',
  SAMPLE: 'amostra recebida',
  SELECTED: 'caminho escolhido',
  UPDATED: 'informação atualizada',
  ADDED: 'informação instalada',
  REMOVED: 'informação removida',
  WITHDRAW: 'anúncio retirado',
  ADVERTISE: 'informação anunciada',
  INSTALL: 'informação instalada',
  ENCAP: 'quadro encapsulado',
  DECAP: 'quadro desencapsulado',
  ENQUEUE: 'pacote colocado na fila',
  DEQUEUE: 'pacote retirado da fila para atendimento',
  MARK: 'classe de serviço marcada',
  PUSH: 'rótulo acrescentado',
  SWAP: 'rótulo substituído',
  POP: 'rótulo removido',
  DISCOVER: 'cliente procura um servidor',
  OFFER: 'servidor oferece configuração',
  ACK: 'servidor confirma a concessão',
  RELEASE: 'cliente libera a concessão',
  DECLINE: 'cliente informa conflito de endereço',
  PROBE: 'endereço verificado antes da concessão',
  RENEWING: 'cliente tenta renovar a concessão',
  REBINDING: 'cliente procura servidor para conservar a concessão',
  BOUND: 'concessão aplicada',
  REPLY: 'resposta enviada',
  REASSEMBLED: 'fragmentos reunidos',
  FRAGMENT: 'pacote dividido em fragmentos',
  CACHE_HIT: 'resposta encontrada no cache',
  TCP_FALLBACK: 'consulta repetida por TCP após truncamento',
  QUEUED: 'registro colocado na fila de envio',
  FILTERED: 'registro filtrado',
  UP: 'porta ou conexão habilitada',
  DOWN: 'porta ou conexão desabilitada',
};
const stageSuffixes = Object.keys(stages).sort((a, b) => b.length - a.length);
const families: [RegExp, string, string, string][] = [
  [
    /^WIFI/,
    'Wi-Fi',
    'O AP e o cliente trocam mensagens para descobrir a rede, associar e autenticar o acesso.',
    'Confira SSID, sinal e segurança. Depois da associação, verifique a configuração IP.',
  ],
  [
    /^(ARP|MAC|FRAME)/,
    'Rede local',
    'Quadros usam MACs para alcançar interfaces no enlace local. O switch aprende em qual porta cada MAC aparece.',
    'Compare MAC de destino, VLAN, tabela MAC e resposta ARP.',
  ],
  [
    /^(NDP|IPV6)/,
    'IPv6 e vizinhos',
    'NDP descobre vizinhos e roteadores no enlace IPv6. Um endereço configurado ainda precisa de um caminho utilizável.',
    'Confira endereço, prefixo, vizinho e próximo salto IPv6.',
  ],
  [
    /^DHCP/,
    'Configuração por DHCP',
    'O cliente solicita configuração IP; o servidor oferece um endereço e confirma uma concessão por um prazo.',
    'Compare solicitação, oferta, confirmação e concessão. Verifique pool, gateway e DNS.',
  ],
  [
    /^DNS/,
    'Consulta DNS',
    'DNS relaciona nomes a registros, como endereços IP. A consulta depende de comunicação com o servidor e pode usar cache.',
    'Compare nome consultado, tipo de registro, resposta e validade no cache.',
  ],
  [
    /^(TCP|APPLICATION)/,
    'Conexão TCP',
    'TCP estabelece uma conexão, numera os bytes e confirma sua recepção. Enviar um segmento não prova que a aplicação recebeu os dados.',
    'Compare SYN, confirmações ACK, sequência, janela e estado da conexão nas duas pontas.',
  ],
  [
    /^(PING|PACKET|IP_FRAGMENT|IP_REASSEMB)/,
    'Comunicação IP',
    'O equipamento escolhe uma rota para o destino. Cada salto precisa de um enlace utilizável e a resposta precisa de um caminho de retorno.',
    'Confira endereços, rotas, ARP ou NDP e o motivo registrado; compare envio e resposta.',
  ],
  [
    /^(BPDU|STP)/,
    'Prevenção de loops por STP',
    'Switches trocam BPDUs para escolher uma raiz e bloquear caminhos redundantes que causariam loops.',
    'Compare raiz, custo e papel das portas. Uma porta bloqueada por STP pode ter o cabo ativo.',
  ],
  [
    /^LACP/,
    'Agregação de enlaces',
    'LACP negocia quais portas compatíveis podem participar do mesmo enlace lógico.',
    'Confira grupo, parceiros, modo active/passive e membros selecionados nas duas pontas.',
  ],
  [
    /^(OSPF|RIP|BGP|ROUTE)/,
    'Aprendizado e escolha de rotas',
    'Roteadores anunciam e comparam caminhos. Ter um vizinho não garante que a rota desejada foi anunciada ou instalada.',
    'Confira vizinhos, anúncios e tabela de rotas, incluindo o caminho de retorno.',
  ],
  [
    /^(PLC|HMI|PROCESS)/,
    'Ciclo de processo e supervisão',
    'O PLC atualiza o processo no seu ciclo. HMI, SCADA e MES recebem valores por Modbus; o último valor pode estar desatualizado após falhas de comunicação.',
    'Compare nível, setpoint, atuador, estado do alarme, última recepção e prazo de leitura.',
  ],
  [
    /^BOND/,
    'NICs ativo/backup',
    'Uma NIC encaminha os dados do grupo. Carrier e, quando configurado, sondagens ARP determinam os caminhos elegíveis.',
    'Confira NIC ativa, respostas das sondagens, alvo ARP e falhas dos switches ou uplinks.',
  ],
  [
    /^VRRP/,
    'Gateway virtual',
    'Um participante atende ao IP virtual; anúncios e prioridades determinam qual equipamento assume esse papel.',
    'Confira IP virtual nos hosts e o papel de cada roteador antes e depois de uma falha.',
  ],
  [
    /^(ACL|NAT|FIREWALL|IDS)/,
    'Política de tráfego',
    'ACL e firewall avaliam regras; NAT traduz endereços. O resultado depende da regra correspondente e, quando aplicável, do estado da conexão.',
    'Compare a regra, os contadores, a tradução e a sessão. Um alerta de inspeção por si só não prova bloqueio.',
  ],
  [
    /^(AAA|DOT1X|EAP)/,
    'Identidade e acesso',
    'Autenticação verifica identidade; autorização define o acesso permitido. 802.1X pode manter a porta sem acesso aos dados até a autorização.',
    'Compare pedido, resposta, credenciais e estado de autorização da porta.',
  ],
  [
    /^(TUNNEL|SDWAN|VXLAN|EVPN|MPLS|MESH|CAPWAP|WLC)/,
    'Caminho virtual ou gerenciado',
    'Encapsulamento e controle criam caminhos sobre a rede de transporte. As pontas precisam alcançar umas às outras antes de oferecer esse caminho.',
    'Confira a rede de transporte, as identidades das pontas e o estado do caminho virtual.',
  ],
  [
    /^QOS/,
    'Tratamento de tráfego',
    'QoS classifica pacotes e organiza seu atendimento. Filas e limites podem atrasar ou descartar tráfego quando há disputa.',
    'Compare classe, fila, marcação e contadores durante tráfego concorrente.',
  ],
  [
    /^(SNMP|SYSLOG|TELEMETRY|NTP|REMOTE|AUTOMATION)/,
    'Gerenciamento',
    'Pedidos, registros e medições dependem de comunicação IP, serviço habilitado e credenciais compatíveis.',
    'Compare pedido e resposta, destino do serviço e os registros produzidos.',
  ],
  [
    /^(PHONE|SIP|RTP|PRINTER|PRINT|MQTT|PROXY|DATABASE|IOT)/,
    'Serviço de aplicação',
    'O cliente usa um serviço de rede. A operação depende do caminho IP, da porta e da configuração da aplicação.',
    'Compare requisição, resposta, estado do serviço e seus contadores.',
  ],
  [
    /^(LINK|POE|POWER|SYSTEM|THERMAL|CONFIG|HARDWARE|UPS)/,
    'Estado do equipamento',
    'Energia, portas, mídia e configuração determinam se o equipamento consegue comunicar.',
    'Confira energia, estado administrativo e operacional da porta e compatibilidade do cabo.',
  ],
];
export function explainEvent(event: NetworkEvent) {
  const failure = /DROPPED|DROP$|DENY|TIMEOUT|FAILED|REJECT|EXHAUSTED|NAK|RESET/.test(event.type);
  const family = families.find(([pattern]) => pattern.test(event.type));
  const [topic, meaning, next] = (family?.slice(1) as string[]) ?? [
    'Acontecimento do laboratório',
    'Este registro descreve uma mudança ou uma decisão da simulação. Consulte o motivo para identificar a condição observada.',
    'Compare os registros anteriores e seguintes do mesmo equipamento.',
  ];
  const stage = stageSuffixes.find((s) => event.type.endsWith('_' + s));
  let title = topic + (stage ? ': ' + stages[stage] : ''),
    summary = (stage ? 'Neste equipamento, foi registrado: ' + stages[stage] + '. ' : '') + meaning;
  const wifi = event.frame?.wifi;
  if (wifi && !failure) {
    title = wifiMessages[wifi.kind] ?? 'Mensagem Wi-Fi';
    if (wifi.kind === 'beacon')
      summary = `A rede “${wifi.ssid}” foi ${event.type.endsWith('RECEIVED') ? 'detectada nesta interface' : 'anunciada pelo ponto de acesso'}. Um beacon informa que a rede existe; não confirma associação, autenticação nem acesso à internet.`;
    else
      summary = `Foi registrada uma etapa de acesso à rede “${wifi.ssid}”. ${meaning} A mensagem isolada não confirma que todas as etapas terminaram.`;
  } else if (event.type === 'PING_SUCCESS') {
    title = 'O ping recebeu uma resposta';
    summary =
      'A resposta ICMP completou o teste de ida e volta para este destino. Isso verifica comunicação IP, mas não comprova que um serviço HTTP, DNS ou outro esteja disponível.';
  } else if (event.type === 'MAC_LEARNED') {
    title = 'O equipamento aprendeu um MAC';
    summary =
      'O endereço de origem do quadro foi associado à porta de entrada e à VLAN. O switch pode usar essa entrada para encaminhar próximos quadros destinados àquele MAC.';
  } else if (event.type === 'ARP_TABLE_UPDATED') {
    title = 'A tabela ARP foi atualizada';
    summary =
      'O equipamento registrou uma associação entre IPv4 e MAC no enlace local. Essa associação permite endereçar um quadro ao próximo salto, mas não garante o caminho completo até o destino.';
  } else if (event.type === 'DHCP_BOUND') {
    title = 'O cliente recebeu uma concessão DHCP';
    summary =
      'O cliente aplicou a configuração confirmada pelo servidor. O endereço tem prazo de uso; gateway e DNS ainda precisam estar alcançáveis para cumprir suas funções.';
  } else if (event.type === 'TCP_RETRANSMIT') {
    title = 'TCP reenviou dados sem confirmação';
    summary =
      'O remetente não recebeu a confirmação esperada no intervalo previsto e retransmitiu o segmento. Pode haver perda, atraso ou perda do ACK; este registro sozinho não distingue essas causas.';
  } else if (failure) {
    title = 'A operação encontrou uma falha ou bloqueio';
    summary = `${meaning} Neste registro, a operação foi recusada, descartada ou não recebeu a resposta esperada. Consulte o motivo específico abaixo antes de mudar a configuração.`;
  }
  return { title, summary, next, failure };
}

export function eventLayers(event: NetworkEvent, medium?: string): [number, string, string][] {
  const f = event.frame;
  if (!f) return [];
  const layers: [number, string, string][] = [];
  const packet = f.packet ?? f.ipv6;
  if (f.packet?.protocol === 'UDP') layers.push([7, 'Aplicação', f.packet.payload.protocol]);
  if (f.ipv6?.protocol === 'UDP') layers.push([7, 'Aplicação', f.ipv6.datagram.payload.protocol]);
  if ((f.packet?.protocol === 'TCP' && f.packet.data) || (f.ipv6?.protocol === 'TCP' && f.ipv6.segment.data))
    layers.push([7, 'Aplicação', 'Dados transportados por TCP']);
  if (packet && ['TCP', 'UDP'].includes(packet.protocol)) layers.push([4, 'Transporte', packet.protocol]);
  if (f.packet || f.fragment) layers.push([3, 'Rede', 'IPv4']);
  if (f.ipv6) layers.push([3, 'Rede', f.ipv6.protocol === 'ICMPv6' ? 'IPv6 / ICMPv6' : 'IPv6']);
  layers.push([
    2,
    'Enlace',
    f.wifi || f.secure || f.meshHello || medium === 'wireless' || medium === 'mesh'
      ? 'Wi-Fi / IEEE 802.11'
      : f.arp
        ? 'Ethernet / ARP'
        : f.bpdu
          ? 'IEEE 802.3 / LLC / STP'
          : f.vlan
            ? 'Ethernet / 802.1Q'
            : 'Ethernet',
  ]);
  layers.push([
    1,
    'Física',
    f.wifi || f.secure || f.meshHello || medium === 'wireless' || medium === 'mesh'
      ? 'Rádio'
      : ((
          {
            copper: 'Cabo de cobre',
            crossover: 'Cabo de cobre cruzado',
            'fiber-sm': 'Fibra monomodo',
            'fiber-mm': 'Fibra multimodo',
            dac: 'Cabo de cobre DAC',
            fiber: 'Fibra óptica',
            serial: 'Enlace serial',
            console: 'Cabo de console',
          } as Record<string, string>
        )[medium ?? ''] ?? 'Interface local; meio não identificado'),
  ]);
  return layers;
}
