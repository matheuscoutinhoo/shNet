import { deviceCapabilities, devicePresentationProfile, type Device } from '@shlab/engine';

export type SectionLesson = { purpose: string; fields: [string, string][]; observe: string };
const lesson = (purpose: string, observe: string, ...fields: [string, string][]): SectionLesson => ({
  purpose,
  observe,
  fields,
});
export const sectionLessons: Record<string, SectionLesson> = {
  networkSummary: lesson(
    'Esta visão reúne os equipamentos do laboratório. Energia, quantidade de interfaces e contadores mostram condições distintas: um equipamento ligado ainda pode estar sem enlace ou endereço IP.',
    'Abra um equipamento, compare suas interfaces e envie tráfego para observar quais contadores mudam.',
    [
      'RX / TX',
      'Quantidade de quadros recebidos / enviados pelas interfaces do equipamento. Um envio não comprova recepção na outra ponta.',
    ],
    [
      'Energia',
      'Indica a alimentação do equipamento; não confirma portas ativas, configuração ou disponibilidade de serviços.',
    ]
  ),
  path: lesson(
    'O caminho é observado com um teste pela rede simulada. Cada linha registra uma transmissão; não é uma previsão de conectividade nem garante que todas as transmissões tiveram resposta.',
    'Compare ida e volta, mudanças de MAC no roteamento e a resposta final do teste.',
    [
      'MAC / IP',
      'MAC identifica a entrega no enlace atual. IP indica origem e destino do pacote; roteadores trocam o cabeçalho do enlace a cada salto.',
    ],
    [
      'Tag VLAN / TTL',
      'Tag identifica a VLAN quando presente; sem tag, a VLAN depende da porta. TTL diminui a cada roteador.',
    ],
    ['RTT', 'Tempo de ida e volta do teste, em milissegundos virtuais. Sem resposta, não há medida completa.']
  ),
  networkErrors: lesson(
    'Esta lista destaca descartes, recusas e operações sem resposta. O motivo descreve a condição observada; um timeout sozinho não determina em qual enlace ocorreu a falha.',
    'Abra o equipamento envolvido e compare endereços, rotas, políticas e os eventos de envio e resposta.',
    ['Descarte / recusa', 'Um equipamento ou uma regra impediu a continuidade do tráfego.'],
    ['Timeout', 'A operação não recebeu a resposta esperada dentro do prazo.']
  ),
  dependencies: lesson(
    'As dependências relacionam referências da configuração aos equipamentos do cenário, por exemplo um cliente apontando para um servidor DNS ou controlador.',
    'Confira se o endereço referenciado existe, depois teste comunicação e disponibilidade do serviço.',
    [
      'Presença / energia',
      'Mostram que a referência tem um equipamento correspondente e sua alimentação; não garantem uma rota, autorização ou serviço ativo.',
    ]
  ),
  networkProtocols: lesson(
    'Esta visão resume protocolos configurados e seu estado observado. Ativo pode indicar apenas habilitação; sessões, vizinhos e rotas mostram resultados diferentes do funcionamento.',
    'Abra o painel do protocolo no equipamento e compare configuração, negociação e tráfego de teste.',
    [
      'Vizinho / sessão',
      'Participante reconhecido ou comunicação de controle estabelecida; não comprova a presença de uma rota específica.',
    ],
    [
      'Rotas / concessões',
      'Informações aprendidas ou atribuídas durante a operação; compare prazos, destino e próximo salto.',
    ]
  ),
  networkOverlays: lesson(
    'Redes virtuais transportam tráfego sobre uma rede externa. QoS classifica e organiza seu atendimento; habilitar encapsulamento ou uma fila não comprova entrega.',
    'Teste a rede externa primeiro, depois compare as pontas virtuais, classes e contadores de tráfego.',
    [
      'Underlay / overlay',
      'Underlay é a rede que transporta os pacotes; overlay é a rede virtual oferecida sobre ela.',
    ],
    [
      'VNI / rótulo / classe',
      'Identificam rede VXLAN, decisão MPLS ou tratamento QoS; não substituem o caminho IP necessário.',
    ]
  ),
  networkSecurity: lesson(
    'Segurança reúne políticas de tráfego e identidade. Uma configuração habilitada não confirma autenticação, uma tradução ou o bloqueio de um pacote específico.',
    'Observe as regras correspondentes, a sessão de autenticação e os contadores antes de concluir que houve liberação ou bloqueio.',
    ['AAA / 802.1X', 'Identificam usuários e autorizam ações ou acesso à rede.'],
    ['ACL / firewall', 'Avaliam regras e, quando configurado, estado das conexões.'],
    ['NAT', 'Traduz endereços; a tradução por si só não é uma autorização de segurança.']
  ),
  interfaces: lesson(
    'Uma interface é o ponto de entrada ou saída do tráfego. Um cabo instalado não basta: equipamento, porta e mídia precisam estar ativos e compatíveis.',
    'Ligue as duas pontas, confira o estado do enlace e só então teste o IP.',
    [
      'IP / prefixo',
      'O IP identifica a interface; /24, por exemplo, indica quais endereços pertencem à mesma sub-rede.',
    ],
    [
      'Administrativo / operacional',
      'Administrativo é a escolha de ativar a porta. Operacional indica se ela consegue comunicar nas condições atuais.',
    ],
    [
      'MTU',
      'Maior pacote IP aceito pela interface, em bytes; valores diferentes podem impedir a entrega de pacotes grandes.',
    ]
  ),
  tables: lesson(
    'Estas tabelas mostram o que o equipamento sabe agora. MAC, ARP e rotas têm funções diferentes e são aprendidos ou configurados de formas diferentes.',
    'Faça um ping e compare as entradas antes e depois.',
    ['MAC', 'No switch, relaciona um MAC à porta e à VLAN onde ele foi aprendido.'],
    ['ARP', 'Relaciona um IPv4 local ou de próximo salto ao MAC necessário para enviar o quadro.'],
    [
      'Rota',
      'Escolhe a rede de destino, a saída e o próximo salto. A resposta também precisa de um caminho de retorno.',
    ]
  ),
  layer3: lesson(
    'VLANs separam redes locais. Uma SVI é a interface IP de uma VLAN; VRFs mantêm tabelas de rotas independentes no mesmo equipamento.',
    'Compare a VLAN do host, seu gateway e a SVI correspondente antes de testar comunicação entre VLANs.',
    ['Access / trunk', 'Access atende uma VLAN. Trunk transporta várias VLANs com identificação 802.1Q.'],
    ['SVI', 'Pode ser o gateway da VLAN se o equipamento tiver capacidade de roteamento.'],
    ['VRF', 'Separa as decisões de roteamento; não une redes por ter endereços iguais.']
  ),
  lacp: lesson(
    'LACP negocia a combinação de enlaces físicos em um enlace lógico. O tráfego é distribuído entre membros compatíveis; uma única comunicação não ganha automaticamente a soma de todas as velocidades.',
    'Desative um membro e confira se o grupo conserva membros suficientes para comunicar.',
    [
      'Active / passive',
      'Active inicia a negociação. Passive responde; duas pontas passive não iniciam um grupo.',
    ],
    ['Min-links', 'Quantidade mínima de membros ativos exigida para o grupo operar.']
  ),
  aaa: lesson(
    'AAA separa autenticação (quem é o usuário), autorização (o que ele pode fazer) e contabilização (registro de ações). 802.1X pode impedir tráfego numa porta até a autenticação.',
    'Confira servidor, chave compartilhada e credenciais. Observe os pedidos e respostas antes de considerar a porta autorizada.',
    [
      'RADIUS / TACACS+',
      'Protocolos usados para consultar o servidor de identidade; não são a mesma coisa que o login local.',
    ],
    ['Supplicant', 'Cliente que pede acesso à rede.'],
    ['VLAN autorizada', 'Rede à qual o cliente é associado após a resposta do servidor.']
  ),
  ipv6: lesson(
    'IPv6 usa endereços de 128 bits. NDP descobre vizinhos e roteadores na rede local; substitui a resolução de vizinhos feita por ARP em IPv4.',
    'Confira endereço, prefixo, próximo salto e vizinhos antes de testar ping IPv6.',
    [
      'Link-local',
      'Endereço usado no enlace local, normalmente no prefixo fe80::/10; não é roteado entre redes.',
    ],
    ['SLAAC', 'Forma um endereço a partir de um prefixo anunciado por um roteador.'],
    ['Hop Limit', 'Limita a quantidade de roteadores que o pacote pode atravessar.']
  ),
  forwarding: lesson(
    'QoS decide como classificar e atender tráfego quando há disputa por recursos. MPLS encaminha usando rótulos associados a caminhos.',
    'Compare os contadores das classes durante tráfego concorrente; uma classificação sem fila congestionada pode não mudar o resultado.',
    ['DSCP', 'Marca de classe de serviço no pacote IP; não garante prioridade por si só.'],
    ['Fila / limite', 'Controla como o equipamento atende ou descarta pacotes.'],
    ['Rótulo MPLS', 'Identifica uma decisão de encaminhamento, não um endereço IP.']
  ),
  vxlan: lesson(
    'VXLAN transporta uma rede Ethernet dentro de uma rede IP. EVPN distribui informações sobre MACs e IPs para os equipamentos que participam dessa rede virtual.',
    'Valide primeiro a comunicação IP entre os endpoints do túnel, depois VNI e rotas EVPN.',
    ['VNI', 'Identificador da rede virtual; as pontas precisam concordar sobre ele.'],
    ['Underlay', 'Rede IP que transporta os pacotes encapsulados.'],
    ['Overlay', 'Rede virtual oferecida sobre o transporte IP.']
  ),
  tunnels: lesson(
    'Um túnel coloca um pacote dentro de outro para alcançar uma rede remota. A proteção e as negociações exibidas aqui são modelos de laboratório, não uma VPN de produção.',
    'Teste o endereço remoto pelo transporte IP antes de testar os destinos dentro do túnel.',
    ['Underlay', 'Interface e rede usadas para alcançar a outra ponta.'],
    ['Prefixos remotos', 'Redes que devem ser alcançadas por dentro do túnel.'],
    ['SLA', 'Limites de atraso, variação e perda usados para escolher um caminho SD-WAN.']
  ),
  sdwanController: lesson(
    'O controlador distribui políticas aos sites. Os sites encaminham o tráfego e escolhem os caminhos de acordo com essas políticas.',
    'Confira se os sites alcançam o controlador e se receberam a versão esperada da política.',
    ['Site', 'Identifica uma unidade participante.'],
    ['Política', 'Relaciona destinos ou aplicações a caminhos e critérios de qualidade.']
  ),
  wireless: lesson(
    'O ponto de acesso anuncia uma rede. O cliente precisa detectar esse anúncio, associar-se e cumprir a autenticação antes de transportar dados. Estar conectado ao Wi-Fi não garante ter endereço IP.',
    'Confira SSID, segurança, canal e sinal; avance a simulação para observar a associação. Depois configure ou obtenha o IP.',
    ['SSID', 'Nome anunciado da rede Wi-Fi; não é uma senha nem prova de segurança.'],
    [
      'RSSI / SNR',
      'RSSI mede a potência recebida em dBm. SNR compara sinal e ruído; valores maiores favorecem a comunicação.',
    ],
    [
      'Canal / obstrução',
      'Rádios que disputam o mesmo canal e materiais no caminho podem reduzir a qualidade.',
    ]
  ),
  advancedNetwork: lesson(
    'Este painel reúne recursos específicos do equipamento: gerenciamento de APs, autenticação Wi-Fi ou inspeção de tráfego. Escolha o recurso e confira seus pré-requisitos antes de habilitá-lo.',
    'Aplique uma configuração, avance a simulação e compare estado, sessões e eventos. A configuração sozinha não prova que o serviço está funcionando.',
    ['CAPWAP / WLC', 'CAPWAP liga APs gerenciados ao controlador WLAN pela rede IP.'],
    ['Mesh', 'APs usam enlaces sem fio entre si para alcançar uma saída para a rede.'],
    [
      'IDS / IPS',
      'IDS registra correspondências com regras. IPS também pode descartar o tráfego que corresponde a uma regra de bloqueio.',
    ]
  ),
  hardware: lesson(
    'Módulos e alimentação fazem parte da comunicação. PoE fornece energia pelo cabo Ethernet; console permite administrar um equipamento pela conexão de gerenciamento local.',
    'Confira a mídia nas duas pontas e se o orçamento PoE atende ao consumo dos equipamentos.',
    ['SFP / QSFP', 'Módulos de interface que precisam ser compatíveis com cabo, modo óptico e velocidade.'],
    ['PoE', 'Fonte, padrão e potência disponível precisam atender ao equipamento alimentado.'],
    [
      'Serial / console',
      'Serial pode transportar uma ligação WAN. Console transporta comandos de administração, não pacotes IP comuns.',
    ]
  ),
  infrastructure: lesson(
    'Capacidade de processamento, memória e alimentação limitam o funcionamento do equipamento. Rack organiza a montagem; patch panel faz passagem física e não roteia pacotes.',
    'Compare a carga com a capacidade e observe os efeitos de perda de energia ou aquecimento no laboratório.',
    [
      'CPU / memória',
      'Indicam recursos usados pelo trabalho da simulação; não são medições do seu computador.',
    ],
    ['UPS', 'Fornece energia a cargas configuradas enquanto houver alimentação ou bateria.'],
    ['Temperatura', 'Relaciona carga, ambiente e refrigeração no modelo térmico.']
  ),
  database: lesson(
    'Um banco de dados atende requisições de clientes por um serviço de rede. O caminho IP e a conexão de transporte precisam funcionar antes de uma consulta.',
    'Confira endereço, porta e autenticação; envie uma consulta e examine resposta e contadores.',
    ['Tabela / linha', 'Tabela organiza registros; cada linha é um registro com valores por coluna.'],
    ['Porta / chave', 'A porta identifica o serviço; a chave controla o acesso no modelo do laboratório.']
  ),
  applications: lesson(
    'Os serviços disponíveis dependem deste equipamento. Telefone, impressora, broker MQTT, proxy e balanceador têm funções e fluxos próprios.',
    'Confira IP e porta do serviço; faça uma operação do cliente e acompanhe os eventos e sua resposta.',
    ['MQTT', 'Clientes publicam mensagens em tópicos e recebem mensagens dos tópicos assinados.'],
    [
      'Proxy / balanceador',
      'Proxy recebe pedidos e os encaminha. Balanceador escolhe entre servidores de destino.',
    ],
    [
      'Telefonia / impressão',
      'Chamadas têm sinalização e mídia; trabalhos de impressão entram numa fila e consomem recursos.',
    ]
  ),
  dhcp: lesson(
    'DHCP fornece configuração IP por um prazo. Cliente e servidor têm papéis distintos: o cliente solicita; o servidor escolhe uma concessão em um intervalo permitido.',
    'No cliente, solicite DHCP e avance a simulação. No servidor, confira oferta, confirmação e concessão; o gateway e o DNS precisam fazer sentido para a rede atendida.',
    ['Pool', 'Intervalo de endereços que o servidor pode conceder numa sub-rede.'],
    ['Lease', 'Prazo de uso do endereço; o cliente tenta renovar antes do vencimento.'],
    [
      'Relay',
      'Encaminha solicitações entre sub-redes, pois o broadcast local não atravessa um roteador comum.',
    ]
  ),
  dns: lesson(
    'DNS traduz nomes em informações, como endereços IP. Um cliente consulta um servidor; o servidor responde com registros conhecidos ou um erro.',
    'Use nslookup e confira servidor, nome consultado e resposta. Depois teste o IP retornado; DNS correto não garante que o serviço esteja acessível.',
    ['A / AAAA / CNAME', 'A publica IPv4; AAAA publica IPv6; CNAME indica outro nome.'],
    [
      'TTL do registro',
      'Prazo, em segundos, durante o qual a resposta pode ficar no cache. Não é o limite de saltos de um pacote IP.',
    ],
    [
      'DNSSEC / EDNS',
      'DNSSEC valida a autenticidade dos dados assinados. EDNS estende opções de DNS; nenhum dos dois cifra a consulta.',
    ]
  ),
  tcp: lesson(
    'TCP entrega um fluxo ordenado de bytes e retransmite dados não confirmados. HTTP usa esse fluxo para enviar pedidos e respostas de páginas.',
    'Confira IP, porta e serviço habilitado. Observe SYN, SYN-ACK e ACK, depois os dados; um ping bem-sucedido não prova que TCP esteja permitido.',
    [
      'Sequência / ACK',
      'Sequência localiza bytes do fluxo. ACK indica o próximo byte esperado pelo receptor.',
    ],
    [
      'Janela',
      'Quantidade de bytes que o receptor anuncia poder aceitar; é diferente da janela de congestionamento do emissor.',
    ],
    [
      'Reset / timeout',
      'Reset encerra ou recusa uma conexão. Timeout indica que uma resposta esperada não chegou a tempo.',
    ]
  ),
  stp: lesson(
    'STP evita loops em uma rede de switches com enlaces redundantes. Mantém alguns caminhos sem encaminhar dados e permite recuperação após uma falha.',
    'Observe a raiz e as portas antes de desativar um enlace; compare a nova topologia e a comunicação.',
    ['Root bridge', 'Switch eleito como referência da árvore. Menor identificador de bridge vence.'],
    ['Custo / papel', 'O custo escolhe caminhos até a raiz; o papel da porta define sua participação.'],
    [
      'Portfast',
      'Indica uma porta de borda para um host; não deve ser aplicado indiscriminadamente entre switches.',
    ]
  ),
  ospf: lesson(
    'OSPF troca informações sobre enlaces e calcula caminhos com base na topologia. Vizinhos precisam concordar com parâmetros de comunicação e área para formar adjacência.',
    'Confira interfaces, área e timers. Observe vizinhos e banco de enlaces antes de procurar as rotas aprendidas.',
    ['Router ID', 'Identificador do roteador dentro do protocolo; não é necessariamente o IP da saída.'],
    ['Área / custo', 'Área organiza a topologia; custo participa da escolha de caminhos.'],
    [
      'Hello / dead',
      'Hello mantém contato; dead define quanto esperar sem mensagens antes de considerar o vizinho perdido.',
    ]
  ),
  rip: lesson(
    'RIP anuncia distâncias até redes. A métrica é a quantidade de saltos; 16 representa destino inalcançável.',
    'Habilite as interfaces participantes e observe anúncios, aprendizagem e expiração após uma falha.',
    ['Métrica', 'Número de saltos até o destino, com limite de 15 saltos alcançáveis.'],
    [
      'Poison reverse',
      'Anuncia uma rota como inalcançável de volta ao vizinho de onde foi aprendida, para reduzir loops.',
    ]
  ),
  vrrp: lesson(
    'VRRP oferece um gateway virtual atendido por um dos roteadores do grupo. Se o ativo deixa de anunciar, outro participante pode assumir.',
    'Configure os hosts para usar o IP virtual e compare qual roteador responde antes e depois de uma falha.',
    ['VRID / VIP', 'VRID identifica o grupo; VIP é o endereço virtual utilizado pelos hosts.'],
    [
      'Prioridade / preempt',
      'Prioridade participa da eleição. Preempt permite recuperar o papel ativo quando apropriado.',
    ],
    [
      'Tracking',
      'Reduz a prioridade quando um recurso monitorado falha, evitando manter um gateway sem saída útil.',
    ]
  ),
  bgp: lesson(
    'BGP troca rotas entre participantes, normalmente de sistemas autônomos diferentes. A escolha considera atributos e políticas, não apenas a menor distância.',
    'Confira conectividade TCP/179 e ASN do vizinho. Observe a sessão antes de investigar anúncios e filtros.',
    [
      'ASN / AS_PATH',
      'ASN identifica o sistema autônomo; AS_PATH registra os sistemas atravessados pela rota.',
    ],
    ['Next hop', 'Endereço do próximo salto necessário para usar uma rota recebida.'],
    ['Local preference / MED', 'Atributos usados pela política para comparar caminhos.']
  ),
  policy: lesson(
    'ACL permite ou bloqueia tráfego segundo regras. NAT traduz endereços; firewall com estado acompanha conexões e pode permitir tráfego de retorno.',
    'Observe a regra que corresponde ao pacote, seus contadores e a tradução ou sessão criada. Uma regra sem correspondência não mudou aquele tráfego.',
    ['Sequência / ação', 'A ordem define qual regra é avaliada primeiro; permit libera e deny bloqueia.'],
    ['Inside / outside', 'Identificam os lados da tradução NAT, não um nível de confiança universal.'],
    ['Hits / sessão', 'Hits contam correspondências. Sessão registra o estado que pode autorizar o retorno.']
  ),
  management: lesson(
    'Gerenciamento consulta estado, registra acontecimentos e sincroniza tempo. Esses protocolos dependem de comunicação IP e das credenciais corretas.',
    'Compare o pedido do cliente com a resposta ou registro no servidor; um serviço habilitado não prova que o destino esteja alcançável.',
    ['SNMP', 'Consulta objetos de gerenciamento identificados por OID.'],
    ['Syslog', 'Envia registros com severidade; números menores representam maior urgência.'],
    ['NTP / telemetria', 'NTP sincroniza relógios. Telemetria envia medições aos coletores.']
  ),
  logs: lesson(
    'Os registros mostram decisões e acontecimentos deste equipamento no tempo virtual do laboratório. Uma mensagem enviada não prova que foi recebida ou que a operação terminou.',
    'Compare envio, recepção, resposta e resultado final. Abra o evento para entender a decisão e o caminho do pacote.',
    ['Tempo virtual', 'Avança com a simulação; não é o horário do computador.'],
    ['Tipo / motivo', 'Tipo classifica o evento; motivo descreve a decisão específica observada.']
  ),
};

export function devicePurpose(d: Device): string {
  const c = deviceCapabilities(d),
    p = devicePresentationProfile(d);
  const specific: Record<string, string> = {
    phone:
      'Um telefone IP usa a rede para sinalizar chamadas e transportar áudio. Endereço, servidor ou destinatário e portas de telefonia precisam estar corretos; ligar o aparelho não inicia uma chamada.',
    printer:
      'Uma impressora de rede recebe trabalhos por um serviço IP e os processa numa fila. Endereço, serviço ativo, papel e capacidade de impressão influenciam o resultado.',
    iot: 'Um dispositivo IoT envia ou recebe dados de uma aplicação, por exemplo por MQTT. Ele é um cliente da rede; não substitui o switch, o roteador ou o broker de mensagens.',
    dns: sectionLessons.dns.purpose,
    dhcp: sectionLessons.dhcp.purpose,
    ntp: 'Este servidor fornece uma referência de tempo por NTP. Os clientes precisam alcançá-lo e receber respostas para sincronizar seus relógios.',
    aaa: sectionLessons.aaa.purpose,
    radius:
      'O servidor RADIUS recebe consultas de autenticação e autorização de equipamentos clientes. Configure quem pode consultá-lo, a chave compartilhada e as identidades permitidas antes de testar acesso.',
    tacacs:
      'O servidor TACACS+ pode autenticar administradores, autorizar comandos e registrar ações. Um equipamento cliente precisa alcançá-lo e compartilhar a configuração de confiança.',
    database: sectionLessons.database.purpose,
    syslog:
      'Este servidor recebe registros de outros equipamentos. Configure o serviço e o endereço de destino nos remetentes; compare origem, severidade e conteúdo das mensagens recebidas.',
    snmp: 'Este equipamento pode coletar ou responder consultas de gerenciamento. OID identifica a informação procurada; endereço, serviço e credenciais permitem a consulta.',
    remote:
      'Este servidor oferece acesso de gerenciamento por protocolos representados no laboratório. Configure transporte, serviço e autenticação; uma sessão alcançável é necessária antes de consultar ou alterar dados.',
    'sdwan-controller': sectionLessons.sdwanController.purpose,
    web: 'Este servidor atende pedidos HTTP quando o serviço está habilitado. Cliente e servidor precisam de comunicação IP de ida e volta e acesso à porta configurada.',
    proxy:
      'O proxy recebe pedidos do cliente e os encaminha ao destino permitido. Ele depende de comunicação com o cliente e com o servidor de destino.',
    'load-balancer':
      'O balanceador recebe pedidos e escolhe um servidor de destino conforme o algoritmo e a disponibilidade. A resposta depende de um backend alcançável e habilitado.',
    mqtt: 'O broker MQTT intermedeia mensagens por tópicos. Um cliente publica; outros clientes recebem se tiverem uma assinatura correspondente.',
    ids: 'Este equipamento inspeciona tráfego encaminhado e registra alertas conforme as regras configuradas. Um alerta informa uma correspondência; não significa que o pacote foi bloqueado.',
    ips: 'Este equipamento pode bloquear tráfego encaminhado conforme regras de inspeção. O bloqueio depende do modo IPS e de uma regra com ação de descarte.',
    wlc: 'O controlador WLAN gerencia APs por CAPWAP através de uma rede IP. Neste perfil, não existe rádio local; o anúncio Wi-Fi vem dos APs gerenciados.',
    mesh: 'Este AP pode atender clientes Wi-Fi e usar outros APs como caminho sem fio até uma saída cabeada. A rede mesh precisa de identidade, chave, canal e raiz compatíveis.',
    rack: 'Um rack organiza equipamentos em posições físicas. Ele não aprende MACs, não possui endereço IP e não encaminha pacotes.',
    'patch-panel':
      'Um patch panel interliga portas de forma passiva. Configure os pares físicos: ele não aprende MACs nem faz roteamento.',
    ups: 'Uma UPS alimenta as cargas conectadas e pode sustentá-las pela bateria quando a alimentação principal falha. Ela não é um servidor de aplicação.',
  };
  if (p && specific[p.id]) return specific[p.id];
  if (c.ap)
    return 'O ponto de acesso anuncia uma rede Wi-Fi e liga seus clientes à rede local. Associação, autenticação e endereço IP são etapas diferentes; um beacon apenas anuncia a rede.';
  if (c.switching)
    return (
      'O switch aprende MACs e encaminha quadros entre portas da mesma VLAN. Cada VLAN separa o tráfego de broadcast.' +
      (c.routing
        ? ' Este perfil também pode rotear entre redes quando interfaces IP e roteamento estiverem configurados.'
        : ' Para alcançar outra rede, os hosts precisam de um roteador ou switch com capacidade L3.')
    );
  if (c.routing)
    return 'Este equipamento encaminha pacotes entre redes conforme suas rotas. Ele escolhe o prefixo mais específico; cabos ativos, endereços e um caminho de retorno continuam necessários.';
  if (c.endpoint)
    return 'Este equipamento é uma ponta da comunicação. Precisa de uma interface ativa e de endereço IP; usa um gateway para alcançar outras redes. MAC identifica a interface local, enquanto IP identifica sua participação na rede.';
  return p?.description ?? 'Confira as interfaces e os serviços disponíveis antes de iniciar a comunicação.';
}

/** Explain only roles actually offered by this device's panel. */
export function sectionLesson(section: string, d?: Device): SectionLesson | undefined {
  const base = sectionLessons[section];
  if (!base) return undefined;
  if (!d) return base;
  const c = deviceCapabilities(d);
  if (section === 'advancedNetwork') {
    const fields: [string, string][] = [];
    if (c.advancedKinds.some((k) => ['wlc', 'wtp'].includes(k)))
      fields.push([
        'CAPWAP / WLC',
        'O AP usa a rede IP para localizar e negociar com o controlador WLAN; o estado RUN indica a sessão operacional do modelo.',
      ]);
    if (c.advancedKinds.includes('mesh'))
      fields.push([
        'Mesh',
        'APs usam enlaces sem fio entre si. A raiz oferece a saída para a rede cabeada; vizinhos precisam de identidade, chave e rádio compatíveis.',
      ]);
    if (c.advancedKinds.includes('ids'))
      fields.push([
        'IDS / IPS',
        'IDS registra correspondências com regras. IPS também pode descartar tráfego; observe modo, ação da regra e contadores.',
      ]);
    if (c.advancedKinds.some((k) => k.startsWith('eap')))
      fields.push([
        'EAP / PEAP / TLS',
        'Cliente, autenticador e servidor verificam identidade. Configure credenciais, certificados e confiança conforme o método; acompanhe a autorização antes de testar dados.',
      ]);
    return {
      ...base,
      purpose:
        'Este painel configura ' +
        fields.map((f) => f[0]).join(', ') +
        '. Habilitar um recurso não comprova que suas negociações e dependências já funcionam.',
      fields,
    };
  }
  if (section === 'applications') {
    const fields: [string, string][] = [];
    if (c.applicationKinds.includes('phone'))
      fields.push([
        'Telefonia',
        'Sinalização inicia e encerra chamadas; a mídia transporta áudio. Confira número, destino, porta e estado da chamada.',
      ]);
    if (c.applicationKinds.includes('printer'))
      fields.push([
        'Impressão',
        'Trabalhos entram numa fila. Serviço ativo, papel e capacidade afetam a impressão e seu prazo.',
      ]);
    if (c.applicationKinds.includes('proxy'))
      fields.push([
        'Proxy / balanceador',
        'Proxy encaminha pedidos a destinos permitidos; balanceador escolhe um backend disponível. As duas conexões precisam funcionar.',
      ]);
    if (c.applicationKinds.includes('broker') || c.clientApplications)
      fields.push([
        'MQTT',
        'O broker recebe publicações em tópicos. Clientes conectados recebem mensagens de tópicos assinados.',
      ]);
    if (c.clientApplications)
      fields.push([
        'Clientes de serviços',
        'Este equipamento pode solicitar páginas, enviar trabalhos de impressão e publicar mensagens; isso não faz dele o servidor desses serviços.',
      ]);
    return {
      ...base,
      purpose:
        'Configure os serviços ou clientes disponíveis neste equipamento e acompanhe pedido, resposta e estado da operação. IP, porta e caminho de retorno são pré-requisitos.',
      fields,
    };
  }
  return base;
}
