import { Children, cloneElement, isValidElement, type ReactNode } from 'react';

const fields: Record<string, [string, string]> = {
  'Origem → destino': ['Origem → destino', 'Endereços IP do remetente e do destinatário deste datagrama.'],
  'Protocolo / TTL': [
    'Protocolo / limite de saltos',
    'O protocolo identifica o conteúdo transportado; TTL limita quantos roteadores o pacote pode atravessar.',
  ],
  'Tipo de mensagem': [
    'Tipo de mensagem',
    'Indica a função deste pacote no protocolo: descobrir vizinhos, anunciar configuração, testar ou transportar dados.',
  ],
  Sequência: [
    'Sequência da proteção',
    'Número usado pelo modelo de proteção do rádio para detectar reutilização de mensagens. Não é a sequência TCP.',
  ],
  Integridade: [
    'Verificação de integridade',
    'Valor usado para detectar alterações no conteúdo protegido do modelo.',
  ],
  'Payload cifrado': [
    'Conteúdo protegido',
    'Dados protegidos no enlace sem fio; seu destinatário precisa da associação e da chave correspondentes.',
  ],
  'Pilha externa → interna': [
    'Pilha de rótulos MPLS',
    'O rótulo mais externo é avaliado primeiro. Cada rótulo inclui limite de saltos e classe de tráfego.',
  ],
  'Pacote interno': [
    'Pacote encapsulado',
    'Conteúdo transportado dentro do encapsulamento; não é o cabeçalho da rede externa.',
  ],
  'Payload Ethernet interno': [
    'Quadro Ethernet encapsulado',
    'Quadro da rede virtual transportado dentro do túnel VXLAN.',
  ],
  'Domínio / instância': [
    'Domínio / instância STP',
    'Identifica o conjunto de VLANs ou a instância em que esta eleição de raiz ocorre.',
  ],
  'Cabeçalho citado': [
    'Pacote que provocou o erro',
    'Parte do pacote original retornada no aviso ICMP para que o remetente identifique a operação afetada.',
  ],
  'Sequência citada': [
    'Sequência do pacote que provocou o erro',
    'Relaciona o aviso ICMP ao segmento TCP original.',
  ],
  Equipamento: [
    'Equipamento',
    'Onde este registro foi produzido; não é necessariamente a origem inicial do pacote.',
  ],
  Interface: [
    'Interface',
    'Porta ou rádio relacionado ao registro. Mudanças gerais podem não ter uma interface específica.',
  ],
  'Source MAC': ['MAC de origem', 'Identifica a interface que enviou o quadro neste enlace.'],
  'Destination MAC': [
    'MAC de destino',
    'Indica quem deve receber o quadro; ff:ff:ff:ff:ff:ff é broadcast, destinado a todos no enlace.',
  ],
  Source: ['IP de origem', 'Endereço de quem originou este pacote IP.'],
  Destination: ['IP de destino', 'Endereço que o roteamento deve alcançar.'],
  Origem: ['IP de origem', 'Endereço da origem deste pacote.'],
  Destino: ['IP de destino', 'Endereço ao qual o pacote se dirige.'],
  'Source port': [
    'Porta de origem',
    'Identifica a ponta remetente da comunicação de transporte. Não é uma porta física.',
  ],
  'Destination port': [
    'Porta de destino',
    'Identifica a ponta destinatária; frequentemente corresponde ao serviço procurado.',
  ],
  Flags: [
    'Sinalizadores TCP',
    'SYN inicia a conexão; ACK confirma; FIN encerra uma direção; RST interrompe a conexão.',
  ],
  Sequence: [
    'Sequência TCP',
    'Número do primeiro byte de dados deste segmento. SYN e FIN também consomem um número de sequência.',
  ],
  Acknowledgment: [
    'Confirmação TCP (ACK)',
    'Próximo número de sequência esperado pelo receptor; confirma o recebimento dos bytes anteriores quando ACK está presente.',
  ],
  Window: [
    'Janela de recepção',
    'Quantidade de bytes que o receptor anuncia poder aceitar a partir do ACK; não é a janela de congestionamento do remetente.',
  ],
  TTL: [
    'TTL — limite de saltos',
    'Diminui em cada roteador; ao chegar a zero, o pacote é descartado para limitar loops.',
  ],
  'Hop Limit': ['Limite de saltos IPv6', 'Diminui em cada roteador, com função equivalente ao TTL do IPv4.'],
  SSID: ['Nome da rede (SSID)', 'Nome anunciado da rede Wi-Fi; não identifica um cliente nem é a senha.'],
  Segurança: [
    'Segurança anunciada',
    'Informa como o acesso é protegido. Rede aberta não exige autenticação por chave.',
  ],
  Mensagem: ['Mensagem', 'Etapa ou tipo de controle transportado neste pacote.'],
  Message: ['Mensagem', 'Tipo da solicitação, resposta ou aviso deste protocolo.'],
  Negociação: [
    'Identificador da negociação',
    'Permite correlacionar as etapas da mesma tentativa de acesso neste modelo.',
  ],
  Nonce: [
    'Valor de uso único (nonce)',
    'Valor usado na negociação de autenticação para distinguir trocas e reduzir reutilização de mensagens.',
  ],
  Cipher: [
    'Proteção do conteúdo',
    'Identifica o algoritmo representado pela simulação; não comprova criptografia de produção.',
  ],
  EtherType: ['Tipo do conteúdo Ethernet', 'Indica o protocolo transportado pelo quadro Ethernet.'],
  Encapsulation: ['Encapsulamento', 'Indica como o protocolo de controle é transportado no quadro.'],
  '802.1Q': [
    'Identificação de VLAN',
    'A tag distingue uma VLAN num enlace trunk. Sem tag, a VLAN depende da configuração da porta.',
  ],
  'Root ID': ['Identidade da raiz STP', 'Prioridade e MAC usados para identificar o switch raiz eleito.'],
  'Root path cost': [
    'Custo até a raiz',
    'Custo acumulado do caminho; STP compara custos para escolher portas.',
  ],
  'Bridge ID': ['Identidade do switch', 'Prioridade e MAC do switch que anuncia esta BPDU.'],
  'Port ID': ['Identidade da porta', 'Distingue a porta que anunciou a BPDU e participa dos desempates.'],
  'Message age': ['Idade do anúncio', 'Tempo acumulado usado para limitar a validade da informação STP.'],
  'Topology change': [
    'Mudança de topologia',
    'Sinaliza alteração de caminhos; pode causar atualização ou expiração da tabela MAC.',
  ],
  'Proposal / Agreement': [
    'Proposta / acordo RSTP',
    'Sinalizadores usados para coordenar uma transição segura de portas. 1 indica ativo; 0, ausente.',
  ],
  Operation: ['Operação ARP', 'Request procura o MAC de um IPv4; reply informa a associação ao solicitante.'],
  'Sender IPv4': ['IPv4 do remetente', 'Endereço de quem fornece ou solicita a associação ARP.'],
  'Target IPv4': ['IPv4 procurado', 'Endereço cujo MAC se quer descobrir na rede local.'],
  Identification: ['Identificador IPv4', 'Relaciona fragmentos do mesmo datagrama para a remontagem.'],
  'Fragment Offset': [
    'Posição do fragmento',
    'Posição dos dados no datagrama original, expressa em unidades de 8 bytes.',
  ],
  'More Fragments': ['Há mais fragmentos?', 'True indica que este não é o último fragmento do datagrama.'],
  Length: ['Tamanho do pacote', 'Comprimento modelado, em bytes.'],
  Tamanho: ['Tamanho', 'Comprimento modelado, em bytes; o conteúdo pode ocupar apenas parte dele.'],
  'Type / Code': [
    'Tipo / código ICMP',
    'Distingue uma mensagem de teste de um erro e informa a condição reportada.',
  ],
  Identifier: ['Identificador do teste', 'Relaciona uma resposta ICMP à solicitação correspondente.'],
  'Transaction ID': [
    'Identificador da transação',
    'Permite relacionar solicitação e resposta da mesma operação.',
  ],
  Question: ['Pergunta DNS', 'Nome e tipo de registro que o cliente quer consultar.'],
  'Recursion desired': [
    'Recursão solicitada',
    'Indica se o cliente pediu ao servidor que procure uma resposta em seu nome.',
  ],
  'Response code': [
    'Código da resposta DNS',
    'NOERROR indica consulta processada sem erro; NXDOMAIN informa nome inexistente. Uma resposta sem erro ainda pode não conter o registro solicitado.',
  ],
  'AA / RA / TC': [
    'Autoridade / recursão / truncamento',
    'AA: resposta autoritativa; RA: recursão disponível; TC: resposta truncada. 1 indica ativo; 0, ausente.',
  ],
  'Client MAC': ['MAC do cliente DHCP', 'Identifica a interface que solicita a configuração.'],
  'Client IPv4': ['IPv4 atual do cliente', 'Pode ser 0.0.0.0 enquanto o cliente ainda não tem endereço.'],
  'giaddr (relay)': [
    'Endereço do relay DHCP',
    'Identifica a rede atendida pelo agente que retransmite o pedido ao servidor.',
  ],
  'Relay hops': [
    'Saltos de relay',
    'Quantidade de retransmissões por agentes DHCP; ajuda a limitar encaminhamentos em loop.',
  ],
  'Server identifier': ['Servidor DHCP escolhido', 'Identifica o servidor que participa desta concessão.'],
  'Requested IPv4': ['IPv4 solicitado', 'Endereço que o cliente pede para utilizar.'],
  'Offered IPv4': [
    'IPv4 oferecido / confirmado',
    'Endereço e prefixo propostos ou confirmados pelo servidor, conforme o tipo da mensagem.',
  ],
  'Router option': ['Gateway informado', 'Próximo salto sugerido para destinos fora da sub-rede do cliente.'],
  'DNS option': ['Servidores DNS informados', 'Destinos sugeridos para consultas de nomes.'],
  Lease: [
    'Prazo da concessão',
    'Tempo pelo qual o cliente pode usar a configuração; precisa renovar para continuar.',
  ],
  'Actor system / key / port': [
    'Identidade local LACP',
    'Sistema, chave de agregação e porta anunciados por esta ponta.',
  ],
  Partner: ['Parceiro LACP', 'Identidade da outra ponta reconhecida durante a negociação.'],
  Modo: ['Modo de negociação', 'Active inicia a troca LACP; passive responde às mensagens recebidas.'],
  VNI: ['Identificador VXLAN (VNI)', 'Identifica a rede virtual compartilhada entre as pontas do túnel.'],
  'Flag I': ['VNI válido', 'Indica que o identificador de rede virtual está presente e válido.'],
  'Router ID': [
    'Identidade OSPF',
    'Identificador do roteador; não precisa ser o IP da interface que enviou o pacote.',
  ],
  Área: [
    'Área OSPF',
    'Domínio de troca de informação do protocolo; vizinhos precisam de configuração compatível.',
  ],
  'VRID / VIP': [
    'Grupo / endereço virtual VRRP',
    'VRID identifica o grupo; VIP é o gateway utilizado pelos hosts.',
  ],
  Prioridade: ['Prioridade VRRP', 'Participa da eleição do roteador ativo junto às regras do protocolo.'],
  'Intervalo anunciado': [
    'Intervalo entre anúncios',
    'Ajuda o participante a detectar quando o roteador ativo deixou de anunciar.',
  ],
  'Alvo NDP': ['Vizinho procurado', 'Endereço IPv6 cuja presença ou MAC está sendo verificado no enlace.'],
  'MTU anunciada': ['MTU do enlace', 'Maior pacote IP anunciado como aceito pelo enlace, em bytes.'],
  'AS / Router ID': [
    'Sistema autônomo / identidade BGP',
    'ASN identifica o sistema autônomo; Router ID identifica o participante.',
  ],
  'Hold time': [
    'Prazo sem mensagens BGP',
    'Tempo negociado antes de encerrar uma sessão que deixou de receber mensagens.',
  ],
  'Anúncios / retiradas': [
    'Rotas anunciadas / retiradas',
    'Quantidade de caminhos publicados e removidos nesta mensagem.',
  ],
};
function annotate(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    if (child.type === 'dt' && typeof child.props.children === 'string') {
      const entry = fields[child.props.children];
      if (entry)
        return cloneElement(
          child,
          {},
          <>
            {entry[0]}
            <small>{entry[1]}</small>
          </>
        );
    }
    return child.props.children ? cloneElement(child, {}, annotate(child.props.children)) : child;
  });
}
export function PacketFields({ children }: { children: ReactNode }) {
  return <dl className="packet-fields">{annotate(children)}</dl>;
}
