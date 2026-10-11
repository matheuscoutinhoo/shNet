import type { LabId } from '@shlab/engine';

function concept<T extends string>(
  id: T,
  name: string,
  explanation: string,
  example: string,
  observe: string[],
  model: string
) {
  return { id, name, explanation, example, observe, model };
}

export const networkConcepts = [
  concept(
    'physical',
    'Cabos, portas e transceivers',
    'Uma conexão precisa de portas ligadas e de uma mídia compatível nas duas pontas. Cobre, fibra e módulos SFP/QSFP têm limites de distância e velocidade. Ter um endereço IP não corrige uma falha física.',
    'Um cabo pode estar conectado e o enlace continuar desligado porque uma porta está desativada ou os módulos não combinam.',
    [
      'Abra a conexão e compare mídia, velocidade e distância.',
      'Desative uma porta, teste o tráfego e observe os eventos de queda do enlace.',
    ],
    'Distância, capacidade, latência e perda são parâmetros do modelo, sem medição física real.'
  ),
  concept(
    'ethernet',
    'Ethernet e tabela MAC',
    'Ethernet entrega frames dentro da rede local. O switch aprende o endereço MAC de origem e a porta por onde o frame entrou. Quando conhece o destino, encaminha por essa porta; quando não conhece, distribui o frame pelas portas elegíveis da VLAN.',
    'No primeiro tráfego entre dois computadores, o switch pode ainda não saber em qual porta está o destinatário.',
    [
      'Envie um ping e consulte a tabela MAC do switch.',
      'Repita o tráfego e compare as portas que transmitiram frames.',
    ],
    'A tabela MAC é aprendida a partir do tráfego da simulação; não é preenchida por um resultado pronto.'
  ),
  concept(
    'ipv4',
    'IPv4, máscara e sub-rede',
    'O endereço identifica uma interface. A máscara separa a parte da rede da parte do host. Antes de enviar, o equipamento compara a rede do destino com a sua: um destino local é alcançado diretamente; outro exige uma rota, normalmente pelo gateway.',
    '192.168.10.10/24 e 192.168.10.20/24 estão na mesma rede. Para chegar a 192.168.20.10, o primeiro host precisa de um gateway ou de uma rota correspondente.',
    [
      'Compare IP, prefixo e gateway nas portas dos hosts.',
      'Altere a máscara e confira como muda a decisão de encaminhamento.',
    ],
    'Os endereços e as rotas pertencem ao laboratório; o simulador não usa a rede real do computador.'
  ),
  concept(
    'arp',
    'ARP: de IPv4 para MAC',
    'Para transmitir um pacote IPv4 por Ethernet, é necessário saber o MAC do próximo salto. ARP pergunta na rede local quem possui aquele IP. A resposta alimenta uma tabela temporária. Para destinos remotos, resolve-se o MAC do gateway, não o do host remoto.',
    'Um PC que envia para outra sub-rede pergunta pelo MAC do roteador conectado à sua LAN.',
    [
      'Envie o primeiro ping e abra os eventos ARP antes do ICMP.',
      'Compare a tabela ARP do host com o IP do próximo salto da rota.',
    ],
    'Perguntas, respostas, espera e timeout percorrem os mesmos enlaces que o restante do tráfego.'
  ),
  concept(
    'icmp',
    'ICMP e ping',
    'Ping envia uma solicitação ICMP Echo e espera uma resposta. O sucesso confirma conectividade IP de ida e volta naquele momento. ICMP também informa problemas de encaminhamento, como destino inacessível ou limite de saltos esgotado. Esse limite se chama TTL em IPv4 e Hop Limit em IPv6. Uma resposta de ping não garante que HTTP esteja permitido.',
    'Um firewall pode permitir ping e bloquear TCP/80. Nesse caso o host responde, mas a página não chega.',
    [
      'Compare origem, destino, TTL ou Hop Limit e resultado de um ping.',
      'Use um limite de saltos baixo em uma rede roteada e examine quem devolve o erro.',
    ],
    'O RTT é calculado pelo relógio virtual, pelas latências e pelo processamento dos eventos.'
  ),
  concept(
    'routing',
    'Rotas e gateway',
    'O roteador procura a rota com o prefixo mais específico que corresponde ao destino. Essa rota define a saída e, quando necessário, o próximo salto. A rota padrão atende aos destinos sem uma correspondência mais específica. A resposta também precisa de um caminho de retorno.',
    'Uma rota /24 ganha de uma rota padrão /0 para o mesmo destino. Uma rota apenas na ida pode deixar a conexão sem resposta.',
    [
      'Consulte a tabela de rotas e identifique a saída de cada pacote.',
      'Remova uma rota de retorno e compare os eventos antes e depois.',
    ],
    'Rotas conectadas, estáticas e aprendidas são usadas no encaminhamento efetivo do motor.'
  ),
  concept(
    'vlan',
    'VLAN, access e trunk',
    'VLANs separam domínios de broadcast no mesmo switch. Uma porta access associa os frames à VLAN configurada. Um trunk transporta várias VLANs, normalmente identificadas por tags 802.1Q. Para comunicar VLANs diferentes, é necessário roteamento.',
    'Dois PCs na VLAN 20 podem ficar isolados se o trunk entre os switches não permitir essa VLAN.',
    [
      'Compare a VLAN access dos hosts com as VLANs permitidas no trunk.',
      'Abra um frame no enlace entre switches e observe a tag 802.1Q.',
    ],
    'A VLAN participa da aprendizagem MAC e das decisões de encaminhamento; não é apenas uma etiqueta visual.'
  ),
  concept(
    'svi',
    'SVI e subinterfaces',
    'Uma SVI é uma interface IP associada a uma VLAN no switch. Uma subinterface divide uma porta física em interfaces lógicas, cada uma com sua VLAN. Ambas podem servir de gateway; o equipamento precisa ter roteamento habilitado e as VLANs precisam alcançar a interface.',
    'A SVI da VLAN 20 pode ser o gateway 192.168.20.1, enquanto a SVI da VLAN 30 atende outra sub-rede.',
    [
      'Compare o gateway do host com o endereço da SVI ou subinterface.',
      'Confira ip routing e a passagem das VLANs pelos enlaces.',
    ],
    'As interfaces lógicas usam as portas e o encaminhamento da topologia simulada.'
  ),
  concept(
    'stp',
    'STP/RSTP e prevenção de loops',
    'Enlaces redundantes entre switches podem fazer um frame circular indefinidamente. STP escolhe uma raiz e bloqueia caminhos que formariam loops. RSTP acelera a transição para outro caminho quando ocorre uma falha. Um enlace conectado pode estar bloqueado para dados por essa decisão.',
    'Em um triângulo de switches, um dos caminhos fica sem encaminhar dados até ser necessário para a recuperação.',
    [
      'Compare a raiz, o custo e o estado forwarding/discarding das portas.',
      'Desligue um uplink e acompanhe a mudança de caminho antes de repetir o ping.',
    ],
    'Estados de portas e BPDUs fazem parte da simulação; a reconvergência depende dos eventos processados.'
  ),
  concept(
    'spanning-instances',
    'PVST e MSTP: árvores por VLAN ou instância',
    'PVST mantém uma árvore de spanning tree por VLAN, permitindo escolher raízes e caminhos diferentes. MSTP reúne VLANs em instâncias que compartilham uma árvore. Switches da mesma região MST precisam concordar no nome, revisão e mapeamento de VLANs; configurações diferentes criam fronteiras de região.',
    'As VLANs 10 e 20 podem usar uplinks diferentes com raízes distintas no PVST, ou compartilhar o caminho se pertencerem à mesma instância MST.',
    [
      'Compare raízes e estados das portas por VLAN ou instância.',
      'Mude o mapeamento de VLANs de um switch e confira a região e os caminhos resultantes.',
    ],
    'O motor modela instâncias, estados e BPDUs; a troca de modo altera as árvores da topologia.'
  ),
  concept(
    'lacp',
    'LACP e agregação de enlaces',
    'LACP negocia quais portas podem participar de um enlace lógico agregado. Pelo menos um lado deve iniciar a negociação em modo active; dois lados passive não a iniciam. Os membros precisam ser compatíveis. A perda de um membro pode manter o agregado operacional pelos restantes.',
    'Dois cabos entre switches não viram automaticamente um único enlace; a negociação e a configuração devem combinar.',
    [
      'Confira os membros selecionados e os modos active/passive.',
      'Desative um membro e envie uma nova conexão para testar o caminho restante.',
    ],
    'A agregação é um modelo de negociação e encaminhamento, sem reproduzir todos os comportamentos de um ASIC.'
  ),
  concept(
    'vrrp',
    'VRRP e gateway redundante',
    'VRRP apresenta um IP virtual como gateway dos hosts. Os roteadores elegem um responsável por esse IP; outro pode assumir quando ele falha. A prioridade influencia a eleição. Tracking reduz a prioridade quando uma interface ou rota monitorada perde conectividade.',
    'O PC mantém o mesmo gateway enquanto dois roteadores alternam a responsabilidade por ele.',
    [
      'Compare IP virtual, prioridade e estado de cada participante.',
      'Provoque uma falha no uplink e teste uma nova conexão após a eleição.',
    ],
    'A implementação cobre VRRP IPv4 e tracking no relógio virtual.'
  ),
  concept(
    'vrf',
    'VRF: tabelas de roteamento separadas',
    'Uma VRF mantém uma tabela de rotas independente. A interface de entrada determina em qual tabela o pacote será consultado. Isso permite redes com IPs sobrepostos sem misturar o tráfego. A existência de uma rota em uma VRF não a torna disponível em outra.',
    'BLUE e RED podem usar o mesmo IP de servidor e responder por caminhos diferentes.',
    [
      'Consulte as rotas e interfaces de cada VRF.',
      'Envie tráfego nas duas tabelas e compare qual servidor responde.',
    ],
    'Não há troca automática de rotas entre VRFs; cada fluxo usa sua tabela.'
  ),
  concept(
    'dhcp',
    'DHCPv4 e concessões',
    'DHCP fornece endereço, máscara e outras opções ao cliente por uma concessão temporária. O fluxo inicial usa Discover, Offer, Request e ACK. Um relay encaminha as mensagens quando o servidor está em outra rede; o servidor usa essa informação para escolher o pool adequado.',
    'Dois clientes podem receber endereços distintos do mesmo pool e usar o gateway entregue pelo servidor.',
    [
      'Coloque a interface em DHCP e acompanhe as quatro mensagens.',
      'Compare pool, concessão, gateway e renovação no cliente e no servidor.',
    ],
    'Pools, reservas, relay, expiração e conflitos são avaliados pelos eventos do laboratório.'
  ),
  concept(
    'dns',
    'DNS: nomes e registros',
    'DNS consulta registros associados a um nome. Um registro A indica IPv4, AAAA indica IPv6 e CNAME aponta para outro nome. O cache evita repetir consultas enquanto o TTL é válido. Resolver um nome não confirma que o serviço nesse endereço esteja disponível.',
    'app.lab pode resolver para 192.168.10.20 e ainda assim não responder a HTTP se TCP/80 estiver bloqueado.',
    [
      'Consulte um nome e examine pergunta, resposta e registros.',
      'Repita a consulta e confira o cache e o TTL antes de alterar o registro.',
    ],
    'O servidor e os caches são locais à simulação; consultas não são enviadas à Internet.'
  ),
  concept(
    'tcp',
    'TCP e HTTP',
    'TCP cria uma conexão com SYN, SYN-ACK e ACK. Os dados têm sequência e confirmação; perdas podem causar retransmissão. Janela e controle de congestionamento limitam o envio. HTTP usa essa conexão para pedir um recurso e receber uma resposta: o handshake sozinho não prova que a aplicação respondeu.',
    'Uma requisição GET atravessa TCP/80; é possível acompanhar separadamente a abertura da conexão e a resposta HTTP.',
    [
      'Abra uma conexão e compare SYN, ACK, dados e FIN nos pacotes.',
      'Introduza perda e observe segmentos em voo, retransmissões e o resultado HTTP.',
    ],
    'TCP possui timers e estados persistidos; HTTP é um subconjunto de aplicação do laboratório.'
  ),
  concept(
    'udp',
    'UDP e portas',
    'UDP entrega datagramas identificados por portas de origem e destino, sem estabelecer uma conexão nem confirmar a entrega. A aplicação precisa lidar com perdas e repetição quando necessário. DNS, DHCP e vários serviços de monitoramento usam UDP, cada um com suas próprias regras.',
    'Uma consulta DNS pode ficar sem resposta se o datagrama de retorno for perdido, mesmo com o enlace ligado.',
    [
      'Abra um pacote e compare as portas de origem e destino.',
      'Introduza perda e confira o timeout ou a repetição feitos pela aplicação.',
    ],
    'Datagramas percorrem enlaces, rotas, ACL e NAT do mesmo modo que os demais pacotes IP.'
  ),
  concept(
    'ospf',
    'OSPF e custo de caminho',
    'OSPF forma adjacências e troca informações sobre os enlaces da área. Cada roteador calcula caminhos pelo custo acumulado e instala as rotas resultantes. Encontrar um vizinho não basta: a adjacência, os anúncios e a tabela de encaminhamento precisam estar corretos.',
    'Depois de uma falha, uma rota pode mudar para um caminho de custo maior que ainda alcance o destino.',
    [
      'Compare vizinhos, adjacência e rotas aprendidas.',
      'Desative um enlace e confira a nova rota antes de testar HTTP.',
    ],
    'Áreas e anúncios são modelados por PDUs do simulador; não há sessão com roteadores externos.'
  ),
  concept(
    'rip',
    'RIP e distância em saltos',
    'RIP anuncia redes e sua distância em saltos aos vizinhos. O roteador seleciona os anúncios utilizáveis, acrescenta o salto local e instala as rotas. Temporizadores removem informações antigas; anúncios de rota inacessível ajudam a propagar uma falha. O limite utilizável é 15 saltos.',
    'Se um vizinho deixa de anunciar uma rede, a rota pode continuar por um período até expirar.',
    [
      'Compare os anúncios recebidos com a distância da rota instalada.',
      'Interrompa o protocolo e avance o tempo virtual para observar a expiração.',
    ],
    'O motor modela RIPv2, filtros e temporizadores; não consulta redes externas.'
  ),
  concept(
    'bgp',
    'BGP e políticas de anúncios',
    'BGP troca prefixos entre vizinhos e aplica políticas para escolher e anunciar caminhos. AS_PATH registra os sistemas autônomos percorridos e ajuda a evitar loops. Uma sessão estabelecida não garante tráfego: o prefixo precisa ser aceito e o próximo salto precisa ser alcançável.',
    'Um filtro pode retirar uma rede dos anúncios enquanto a sessão TCP entre os roteadores continua ativa.',
    [
      'Confira a sessão, os prefixos recebidos e AS_PATH.',
      'Altere uma política e compare a rota instalada com o resultado de uma nova conexão.',
    ],
    'BGP usa mensagens tipadas pela rede simulada, sem interoperabilidade com uma sessão externa.'
  ),
  concept(
    'ipv6',
    'IPv6, NDP e SLAAC',
    'IPv6 usa endereços de 128 bits. NDP resolve vizinhos e verifica duplicação com DAD. Roteadores enviam RA para anunciar prefixos e gateways; com SLAAC, o host forma um endereço a partir do prefixo. Um endereço ainda tentative não está pronto para uso normal.',
    'Um PC pode aprender o prefixo por RA e resolver o MAC do gateway por NDP antes de enviar o ping.',
    [
      'Compare endereços tentative/preferred, anúncios RA e tabela de vizinhos.',
      'Envie ping IPv6 entre sub-redes e observe o Hop Limit.',
    ],
    'NDP substitui ARP nesse fluxo; TCP e UDP IPv6 usam as mesmas decisões de encaminhamento.'
  ),
  concept(
    'dhcp6',
    'DHCPv6 e delegação de prefixo',
    'DHCPv6 pode entregar endereços e opções, ou delegar um prefixo para outra rede. Ele não fornece o gateway padrão: essa função pertence aos anúncios RA. IA_NA representa uma associação de endereços; IA_PD representa uma associação de prefixos delegados.',
    'Um cliente pode ter endereço concedido por DHCPv6 e ainda precisar de RA para alcançar outra sub-rede.',
    [
      'Compare as concessões de endereço/prefixo no cliente e no servidor.',
      'Confira RA e a rota padrão separadamente da concessão DHCPv6.',
    ],
    'Concessões, renovação e relay usam datagramas IPv6 na topologia.'
  ),
  concept(
    'wireless',
    'Wi-Fi: associação, sinal e autenticação',
    'O cliente precisa encontrar um AP compatível e concluir a autenticação antes de trocar dados pela rede sem fio. SSID, segurança e credenciais devem combinar. Distância, canal e interferência afetam o sinal, as perdas e a capacidade; associar não substitui configurar o IP.',
    'Um notebook pode ver o SSID e não associar por causa de uma chave incorreta. Depois de associar, ainda precisa alcançar seu gateway.',
    [
      'Confira associação, chave, canal e intensidade do sinal.',
      'Afaste o cliente ou altere o canal e compare as perdas no tráfego.',
    ],
    'O rádio é um modelo de cobertura/interferência, sem controle de um adaptador Wi-Fi real.'
  ),
  concept(
    'capwap',
    'WLC e CAPWAP',
    'Um controlador WLC centraliza a configuração de APs. CAPWAP transporta controle e, no modo centralizado, os dados dos clientes até o controlador. O AP precisa alcançar o WLC pela rede IP antes de receber uma WLAN utilizável.',
    'Um AP pode ter rádio ligado e não oferecer a WLAN esperada porque não alcança o controlador.',
    [
      'Confira descoberta, sessão do AP e perfis WLAN no WLC.',
      'Interrompa o caminho IP até o controlador e observe o efeito no tráfego dos clientes.',
    ],
    'Controle e dados percorrem a rede do modelo; não há interoperabilidade CAPWAP externa.'
  ),
  concept(
    'mesh',
    'Rede wireless mesh',
    'Em uma mesh, APs formam vizinhanças sem fio para encaminhar dados até uma raiz ou saída. O enlace entre APs é distinto da associação dos clientes. Identidade, segurança e caminho da mesh precisam estar corretos para evitar um cliente associado sem acesso à rede de destino.',
    'Um cliente pode associar a um AP remoto cujo caminho mesh até a raiz está indisponível.',
    [
      'Compare vizinhos e caminho até a raiz da mesh.',
      'Desligue um AP intermediário e confira se existe outro caminho utilizável.',
    ],
    'A descoberta e o encaminhamento mesh são limitados às regras do motor.'
  ),
  concept(
    'vpn',
    'VPN e rede de transporte',
    'Um túnel VPN transporta pacotes internos por uma rede externa, chamada underlay. Os participantes precisam se alcançar e negociar parâmetros compatíveis antes de proteger os dados. Uma rota pela interface do túnel não resolve uma falha na rota até o outro participante.',
    'Uma chave incorreta pode impedir a negociação mesmo quando os endereços externos têm conectividade IP.',
    [
      'Compare participantes, credenciais e estado de negociação.',
      'Abra o tráfego externo e compare com o destino do pacote encapsulado.',
    ],
    'Criptografia e estados são modelados no laboratório; o túnel não se conecta a uma VPN real.'
  ),
  concept(
    'sdwan',
    'SD-WAN e seleção de caminho',
    'SD-WAN distribui políticas e escolhe transportes de acordo com a aplicação e as condições medidas. RTT, perda e disponibilidade podem mudar qual túnel será usado. Uma política recebida não cria conectividade: os transportes e as rotas de cada túnel também precisam funcionar.',
    'HTTP pode trocar de transporte quando o primeiro caminho deixa de cumprir o limite de perda da política.',
    [
      'Compare política recebida e medições dos transportes.',
      'Provoque uma falha e observe o caminho de uma nova conexão.',
    ],
    'Medições e políticas dependem dos eventos virtuais e dos túneis configurados.'
  ),
  concept(
    'qos',
    'QoS, classificação e filas',
    'Quando a saída recebe mais tráfego do que consegue transmitir, frames aguardam em filas ou são descartados. QoS classifica esse tráfego e define como as filas compartilham a capacidade. DSCP é uma marca de classificação; marcar um pacote não aumenta a capacidade do enlace.',
    'Uma classe prioritária pode ter menos espera enquanto outra acumula drops em uma saída congestionada.',
    [
      'Reduza a capacidade e compare marcação, filas e descartes.',
      'Altere a política e observe o atraso e a quantidade de frames transmitidos.',
    ],
    'As filas e sua capacidade são simplificadas; não representam um hardware específico.'
  ),
  concept(
    'mpls',
    'MPLS e labels',
    'MPLS associa o tráfego a um caminho de labels. O ingresso adiciona um label, os equipamentos intermediários consultam a LFIB e o trocam, e a saída remove o encapsulamento. A correspondência entre label de entrada, saída e próxima interface precisa formar um caminho completo.',
    'Um label errado no roteador intermediário pode interromper o caminho mesmo com rotas IP corretas nas extremidades.',
    ['Acompanhe push, swap e pop nos pacotes.', 'Compare os labels observados com as entradas da LFIB.'],
    'Os caminhos MPLS são configurados estaticamente; não há LDP/RSVP no modelo.'
  ),
  concept(
    'vxlan',
    'VXLAN e VNI',
    'VXLAN encapsula um frame Ethernet em UDP para atravessar uma rede IP. O VNI identifica a rede lógica e os VTEPs fazem a encapsulação e a entrega. As VLANs locais podem ser diferentes, mas VNI, participantes e conectividade do underlay precisam combinar.',
    'Dois switches podem estender uma rede local por UDP/4789 sem usar a mesma VLAN numérica em cada ponta.',
    [
      'Compare VNI e endereços dos VTEPs.',
      'Abra o pacote UDP externo e o frame Ethernet transportado dentro dele.',
    ],
    'VXLAN usa enlaces e rotas IP reais do modelo, sem criar conectividade externa.'
  ),
  concept(
    'evpn',
    'EVPN e localização de MAC/IP',
    'EVPN usa anúncios BGP para informar onde um MAC/IP pode ser alcançado. Route targets determinam quais anúncios uma rede importa. Isso permite direcionar o tráfego ao VTEP correto; uma sessão BGP ativa com route targets incompatíveis pode deixar os destinos sem rota.',
    'O MAC remoto é anunciado por um switch, mas o outro não o importa porque usa outro route target.',
    [
      'Compare anúncios MAC/IP e seus route targets.',
      'Corrija a importação e observe o VTEP escolhido para o tráfego.',
    ],
    'O modelo cobre um subconjunto MAC/IP, sem todos os serviços e formas de redundância de EVPN.'
  ),
  concept(
    'dot1x',
    '802.1X, RADIUS e acesso à rede',
    '802.1X controla a entrada de um cliente na rede. O cliente é o supplicant, o switch/AP atua como authenticator e o servidor RADIUS avalia a autenticação. Uma autorização pode liberar a porta e atribuir uma VLAN. Em Wi-Fi empresarial, PEAP/TLS também exige validar certificados e credenciais.',
    'Um cabo ligado não garante passagem de dados: a porta pode continuar não autorizada até o servidor aceitar o cliente.',
    [
      'Compare o estado da porta antes e depois da resposta RADIUS.',
      'Teste credenciais incorretas e confira a VLAN e a autorização resultantes.',
    ],
    'Credenciais de rede pertencem ao laboratório; não são a conta usada para entrar no shLab.'
  ),
  concept(
    'tacacs',
    'AAA e TACACS+: acesso ao terminal',
    'AAA reúne autenticação, autorização e registro de uso. TACACS+ pode verificar quem acessa um equipamento e quais comandos essa pessoa pode executar. Autenticar não significa ter autorização para alterar configurações; a política também precisa permitir a ação.',
    'Um usuário pode consultar rotas e receber uma negativa ao tentar mudar uma interface.',
    [
      'Compare privilégio e políticas de comandos no servidor.',
      'Execute um comando de leitura e outro de configuração e consulte o accounting.',
    ],
    'A autorização controla o terminal dos equipamentos simulados e não altera a conta do aplicativo.'
  ),
  concept(
    'acl',
    'ACL: regras e ordem de avaliação',
    'Uma ACL compara o pacote com regras de origem, destino, protocolo e portas. A ordem importa: a primeira regra correspondente decide o resultado. Uma ACL convencional não acompanha toda a conexão como um firewall stateful; o tráfego de retorno pode precisar de regras próprias.',
    'Uma regra geral de bloqueio antes de uma exceção específica impede que a exceção seja usada.',
    [
      'Compare a regra aplicada e seus contadores com o pacote.',
      'Teste ida e retorno após mudar a ordem ou a interface da ACL.',
    ],
    'Regras e bloqueios são aplicados no caminho do pacote, incluindo decisões de NAT quando configuradas.'
  ),
  concept(
    'nat',
    'NAT e PAT',
    'NAT reescreve endereços entre redes; PAT também usa portas para distinguir conexões que compartilham um endereço externo. A tabela de traduções permite encaminhar a resposta ao host original. NAT depende de rotas e não substitui uma política de segurança.',
    'Dois PCs podem acessar o mesmo servidor usando um único IP externo, com portas traduzidas diferentes.',
    [
      'Compare endereço e porta antes e depois da tradução.',
      'Confira a entrada NAT e o caminho de retorno até o host original.',
    ],
    'Traduções, expiração e hairpin fazem parte do estado do laboratório.'
  ),
  concept(
    'firewall',
    'Firewall stateful e inspeção de aplicação',
    'Um firewall stateful acompanha o estado dos fluxos e pode distinguir respostas de novas conexões. Políticas de zonas controlam caminhos entre redes. A inspeção de aplicação usa dados como Host/path HTTP ou o nome DNS para decidir, além dos endereços e portas.',
    'Dois pedidos para o mesmo servidor TCP/80 podem ter resultados diferentes por usarem nomes Host distintos.',
    [
      'Compare sessões, zonas e a regra que aceitou ou bloqueou o fluxo.',
      'Mude somente o Host HTTP e confira a decisão de inspeção.',
    ],
    'A inspeção observa os protocolos suportados em claro; não decifra aplicações externas.'
  ),
  concept(
    'ids',
    'IDS e IPS',
    'IDS detecta comportamentos e assinaturas e registra alertas. IPS também pode impedir a passagem do tráfego correspondente. Taxas elevadas podem acionar uma regra mesmo sem uma assinatura no conteúdo. Um alerta descreve uma correspondência com a regra, não uma prova de ataque em uma rede real.',
    'Uma regra de taxa pode alertar no IDS e descartar o mesmo fluxo quando configurada como prevenção no IPS.',
    [
      'Compare assinaturas, limiar e contadores de alerta.',
      'Repita o tráfego em modos de detecção e prevenção e observe os drops.',
    ],
    'Regras e assinaturas são limitadas ao conteúdo dos pacotes do modelo.'
  ),
  concept(
    'netconf',
    'NETCONF/RESTCONF e configuração remota',
    'Protocolos de gerenciamento permitem consultar e alterar a configuração pela rede. No NETCONF, candidate separa uma proposta da configuração ativa; validate verifica a proposta e commit a aplica. RESTCONF usa recursos HTTP e pode controlar concorrência por ETag. Conectividade e autorização continuam necessárias.',
    'Editar candidate não altera imediatamente o encaminhamento; o efeito aparece depois do commit bem-sucedido.',
    [
      'Compare candidate e configuração ativa antes e depois do commit.',
      'Consulte a resposta do job e teste acesso sem autorização adequada.',
    ],
    'XML/framing e recursos HTTP são modelados com um conjunto limitado de configurações.'
  ),
  concept(
    'telemetry',
    'SNMP, syslog e telemetria',
    'Monitoramento observa a rede sem precisar ler a tela de cada equipamento. SNMP consulta valores, syslog envia registros de eventos e telemetria publica medições de sensores. A ausência de dados pode indicar falha no caminho até o coletor, não ausência de atividade no dispositivo.',
    'Uma interface pode transmitir frames enquanto o coletor fica sem amostras por uma ACL que bloqueia o envio.',
    [
      'Compare contadores locais com os dados recebidos pelo coletor.',
      'Interrompa o caminho até o coletor e confira consultas, mensagens e timeouts.',
    ],
    'Coletores, eventos e sensores estão dentro da topologia simulada.'
  ),
  concept(
    'ntp',
    'NTP e sincronização de relógios',
    'NTP troca timestamps para estimar atraso e diferença de relógio entre cliente e servidor. O cliente escolhe referências utilizáveis e ajusta seu offset. Stratum indica a distância lógica até uma referência; um número baixo sozinho não confirma que o servidor esteja acessível ou correto.',
    'Um equipamento com offset alto pode corrigi-lo após receber respostas de um servidor configurado.',
    [
      'Compare offset, atraso, stratum e servidor selecionado.',
      'Desative o servidor e acompanhe a perda de sincronização.',
    ],
    'O ajuste usa tempo virtual e não modifica o relógio do computador ou do sistema operacional.'
  ),
  concept(
    'poe',
    'PoE e orçamento de potência',
    'PoE fornece energia pelo enlace Ethernet. O fornecedor de energia é o PSE e o consumidor é o PD. Classe, padrão e potência disponível precisam combinar. Um switch com orçamento esgotado pode deixar um equipamento sem alimentação mesmo com o cabo de dados conectado.',
    'Dois APs podem disputar o orçamento do switch; a prioridade determina qual permanece alimentado.',
    [
      'Compare classe, consumo, potência reservada e orçamento total.',
      'Aumente o consumo ou reduza o orçamento e observe os dispositivos dependentes.',
    ],
    'Potência e negociação são valores do modelo, sem efeitos elétricos físicos.'
  ),
  concept(
    'serial',
    'Serial WAN, DCE e clock',
    'Um enlace serial ponto a ponto exige configurações compatíveis e uma origem de clock. O lado DCE fornece a temporização usada pelo DTE. A taxa de clock limita a transmissão. O tráfego IP entre as duas pontas não usa ARP como em uma LAN Ethernet.',
    'Duas interfaces ligadas podem não trocar dados se nenhuma ponta fornecer o clock exigido.',
    [
      'Compare papéis DCE/DTE e velocidade nas duas pontas.',
      'Envie tráfego e observe serialização e verificação de frames.',
    ],
    'O motor usa um envelope HDLC e verificação FCS simplificados.'
  ),
  concept(
    'console',
    'Console e acesso local',
    'Uma conexão de console oferece acesso ao terminal sem depender de endereço IP, gateway ou rota. As portas e a velocidade serial devem ser compatíveis. Esse caminho é útil para configurar um equipamento antes de existir conectividade de rede.',
    'Um roteador sem IP pode receber comandos por console a partir de um equipamento conectado à sua porta de console.',
    [
      'Conecte portas console com baud compatível.',
      'Execute um comando no equipamento remoto e confira a configuração resultante.',
    ],
    'O console opera dentro do laboratório; não abre uma porta serial real do computador.'
  ),
  concept(
    'fragmentation',
    'MTU e fragmentação IPv4',
    'A MTU limita o tamanho do pacote que cabe em um enlace. IPv4 pode fragmentar um pacote maior e o destino precisa remontá-lo. Com DF ativo, o roteador não fragmenta e pode responder com ICMP Fragmentation Needed. Perder um fragmento impede a remontagem completa.',
    'Um ping pequeno pode funcionar enquanto um pacote maior falha ao atravessar um enlace com MTU menor.',
    [
      'Compare tamanho do pacote e MTU do caminho.',
      'Repita o envio com e sem DF e abra o erro ICMP ou os fragmentos.',
    ],
    'Fragmentos e remontagem têm limites e temporizadores no motor.'
  ),
  concept(
    'dnssecurity',
    'DNSSEC e EDNS',
    'DNSSEC permite verificar a autenticidade dos registros por assinaturas e uma cadeia de confiança; não criptografa a consulta. EDNS amplia o formato de mensagens DNS e permite anunciar capacidades, como um limite UDP maior. Uma resposta grande ou truncada pode exigir transporte TCP.',
    'Uma assinatura inválida pode fazer o resolvedor rejeitar um registro mesmo que o servidor responda à consulta.',
    [
      'Compare assinatura, confiança e resultado da validação.',
      'Altere limites EDNS e confira truncamento e repetição por TCP.',
    ],
    'DNSSEC usa uma representação assinada própria do simulador, sem validação de zonas reais da Internet.'
  ),
  concept(
    'proxy',
    'Proxy HTTP',
    'Um proxy recebe um pedido do cliente e cria outra conexão para o servidor de destino. São dois fluxos separados, com suas próprias rotas, estados TCP e políticas. O cliente alcançar o proxy não garante que o proxy consiga alcançar o servidor.',
    'O pedido chega ao proxy, mas o acesso falha porque o destino não está permitido ou sua rota está ausente.',
    [
      'Compare a conexão cliente–proxy com a conexão proxy–servidor.',
      'Mude a lista de destinos permitidos e consulte o resultado HTTP.',
    ],
    'O proxy trata o subconjunto HTTP do laboratório e não navega na Internet.'
  ),
  concept(
    'balance',
    'Balanceador de carga',
    'Um balanceador recebe pedidos em uma entrada comum e escolhe um servidor de destino. Round-robin alterna os destinos e least-connections considera conexões ativas. Health checks ajudam a retirar servidores indisponíveis; eles também precisam de conectividade até cada backend.',
    'Novos pedidos podem ir para o segundo servidor depois que o primeiro falha no health check.',
    [
      'Compare o algoritmo, os backends e seu estado de saúde.',
      'Desative um servidor e observe o destino escolhido para novos pedidos.',
    ],
    'A seleção e os health checks usam conexões HTTP simuladas.'
  ),
  concept(
    'voice',
    'Telefone IP, SIP e RTP',
    'SIP sinaliza o estabelecimento e encerramento de chamadas. SDP descreve parâmetros de mídia e RTP transporta o áudio por um fluxo separado. Completar a sinalização não garante que o caminho da mídia esteja funcionando nos dois sentidos.',
    'Uma chamada pode ser aceita e ficar sem áudio se os datagramas de mídia forem bloqueados.',
    [
      'Compare o estado SIP com os endereços e portas negociados para RTP.',
      'Interrompa o caminho de mídia e confira o resultado da chamada.',
    ],
    'O laboratório modela sinalização e amostras PCMU, sem chamar um telefone externo.'
  ),
  concept(
    'printing',
    'Impressora IP e IPP',
    'Uma impressora de rede recebe trabalhos por um serviço IP. IPP, transportado sobre HTTP, permite enviar, consultar e cancelar trabalhos. A fila pode aceitar um pedido e ainda aguardar papel ou processamento; conectividade e conclusão da impressão são estados diferentes.',
    'Um trabalho entra no spool, mas permanece pendente quando a impressora fica sem papel.',
    [
      'Envie um trabalho e consulte seu estado na fila.',
      'Altere a disponibilidade de papel e acompanhe a conclusão ou cancelamento.',
    ],
    'Páginas, fila e papel são simulados; não é enviada impressão para um equipamento real.'
  ),
  concept(
    'mqtt',
    'IoT e MQTT',
    'MQTT conecta clientes a um broker. Um cliente publica mensagens em tópicos e outros as recebem por assinaturas. Wildcards selecionam famílias de tópicos e uma mensagem retained pode ser entregue a um novo assinante. O sensor não precisa conhecer o endereço de cada consumidor.',
    'Um sensor publica em sala/temperatura e um cliente assina sala/# para receber suas medições.',
    [
      'Compare tópicos publicados, assinaturas e mensagens recebidas.',
      'Reconecte um assinante e confira retained e keepalive.',
    ],
    'O motor implementa um subconjunto MQTT 3.1.1 para os clientes e brokers do laboratório.'
  ),
  concept(
    'database',
    'Serviço de banco de dados pela rede',
    'Um cliente precisa alcançar e autenticar-se no serviço antes de consultar dados. O transporte levar o pedido até o servidor não garante que a consulta seja válida ou permitida. Separar falha de rede, autenticação e consulta facilita identificar a causa de uma resposta de erro.',
    'O servidor pode responder ao HTTP, mas rejeitar uma consulta por chave incorreta ou tabela inexistente.',
    [
      'Compare conexão, chave de acesso e resposta da consulta.',
      'Altere um registro e consulte novamente a tabela pelo cliente.',
    ],
    'O serviço oferece SQL limitado por HTTP/TCP e não acessa o banco de contas do aplicativo.'
  ),
] as const;

export type ConceptId = (typeof networkConcepts)[number]['id'];
const ipv4: ConceptId[] = ['physical', 'ethernet', 'ipv4', 'arp'];
const routed: ConceptId[] = [...ipv4, 'routing'];
const localHttp: ConceptId[] = [...ipv4, 'tcp'];
const http: ConceptId[] = [...routed, 'tcp'];
export const labConcepts: Record<LabId, readonly ConceptId[]> = {
  'lan-foundations': [...ipv4, 'icmp'],
  'routing-repair': [...routed, 'icmp'],
  'dhcp-basics': [...ipv4, 'dhcp', 'udp', 'icmp'],
  'vlan-segmentation': [...ipv4, 'vlan', 'icmp'],
  'nat-boundary': [...routed, 'nat', 'acl', 'dns', 'udp', 'icmp'],
  'rstp-failover': [...ipv4, 'stp', 'icmp'],
  'bgp-repair': [...http, 'bgp'],
  'ospf-repair': [...http, 'ospf'],
  'rip-repair': [...http, 'rip', 'udp'],
  'svi-repair': [...http, 'vlan', 'svi'],
  'vrf-isolation': [...http, 'vrf'],
  'lacp-repair': [...localHttp, 'stp', 'lacp'],
  'gateway-tracking': [...http, 'vrrp'],
  'ipv6-slaac': ['physical', 'ethernet', 'ipv6', 'icmp'],
  'wireless-repair': [...localHttp, 'wireless'],
  'vpn-repair': [...http, 'vpn', 'udp'],
  'sdwan-repair': [...http, 'vpn', 'sdwan', 'udp'],
  'qos-repair': [...http, 'qos'],
  'mpls-repair': [...http, 'mpls'],
  'evpn-repair': [...http, 'vlan', 'vxlan', 'evpn', 'bgp', 'udp'],
  'aaa-repair': [...localHttp, 'vlan', 'dot1x', 'udp'],
  'inspection-repair': [...http, 'firewall'],
  'automation-repair': [...http, 'netconf', 'telemetry', 'ntp', 'udp'],
};

export function conceptsForLab(mode: 'free' | 'guided' | 'challenge', labId: LabId | null) {
  if (mode === 'free') return networkConcepts;
  const ids = labId ? labConcepts[labId] : ipv4;
  return networkConcepts.filter((topic) => ids.includes(topic.id));
}
