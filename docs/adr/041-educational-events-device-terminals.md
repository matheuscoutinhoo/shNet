# ADR-041: explicações de eventos, busca e terminais por perfil

Data: 2026-10-12. Estado: implementado.

## Leitura antes dos detalhes

O painel de eventos começa pelo acontecimento observado, seu significado e uma verificação sugerida. Equipamento indica onde o registro foi produzido; interface indica a porta ou rádio relacionado. Tempo virtual é separado do relógio do computador. O motivo original, o identificador do tipo e os cabeçalhos permanecem numa seção expansível para diagnóstico.

Os campos de pacotes têm nomes em português e explicações locais. Sequência TCP, ACK, janela anunciada, portas, TTL, DHCP, DNS, ARP, STP, LACP e encapsulamentos têm funções distintas. Um envio não comprova entrega; uma retransmissão não distingue, sozinha, perda de dados, atraso ou perda de ACK. Ping bem-sucedido não comprova disponibilidade de um serviço.

Um beacon anuncia uma rede; não prova associação, autenticação, configuração IP ou acesso à internet. Campos inexistentes de negociação e nonce não recebem valores fictícios. Wi-Fi usa identificação de enlace 802.11; campos exclusivos de Ethernet não são atribuídos ao cabeçalho sem fio. A representação interna não implementa todos os campos de um cabeçalho 802.11 real. Somente as camadas envolvidas na mensagem aparecem; ARP, STP e anúncios Wi-Fi não recebem uma camada IPv4 fictícia. IPv6 distingue ICMPv6, TCP e UDP.

Orientações para cada painel explicam finalidade, significado de campos e uma experiência observável. O inspetor da rede recebe as mesmas orientações, incluindo contadores RX/TX, caminhos observados e dependências. Explicações de recursos específicos de aplicação e rede são selecionadas conforme as capacidades do equipamento. Os limites de segurança do laboratório continuam explícitos: simulações de negociação não são garantia de interoperabilidade ou proteção de produção.

Referências conceituais: [Cisco — fundamentos 802.11](https://www.cisco.com/en/US/docs/wireless/wlan_adapter/secure_client/5.1.0/administration/guide/C1_Network_Security.html), [RFC 826 — ARP](https://www.rfc-editor.org/info/rfc826/), [RFC 9293 — TCP](https://www.rfc-editor.org/info/rfc9293/).

## Busca que localiza

A busca considera os equipamentos presentes, seus nomes, IDs e endereços de interface. Prioriza correspondências exatas. Nome exato ou resultado único centraliza e seleciona o dispositivo com zoom legível; resultados múltiplos oferecem escolha. Enter permite repetir a centralização e Escape limpa a busca. Não existe movimento para um resultado ausente. O movimento respeita a preferência de animação reduzida.

## Comandos e capacidades

O contrato de capacidades reside no motor e é compartilhado com a interface. Ajuda e execução consultam esse contrato; esconder um comando na ajuda não é o único controle. Comandos incompatíveis são rejeitados antes da alteração. Menus e protocolos de roteamento dinâmico não são oferecidos aos perfis IDS/IPS apenas porque sua implementação interna utiliza encaminhamento IP.

APs e controladores WLAN conservam os comandos de VLAN e interface de gerenciamento compatíveis com seus menus; isso não lhes acrescenta STP ou OSPF de switches e roteadores.

Hosts e servidores têm identidade HostShell/ServiceShell; equipamentos de rede usam identidades NetOS específicas de switching, roteamento, wireless ou controlador WLAN. Os comandos de host incluem inspeção de interfaces, configuração IPv4, gateway, ativação de porta, renovação/liberação DHCP e conexão Wi-Fi. Essas operações usam o motor existente: DHCP negocia mensagens e Wi-Fi ainda depende de associação e autenticação. Consultas de host não produzem eventos de configuração.

Telefonia, impressão, broker MQTT, DNS, DHCP, HTTP e NTP têm ajuda e exemplos conforme seus papéis. O banco aceita configuração, consulta SQL por HTTP/TCP e inspeção de estado pelo terminal; um host cliente pode consultar o serviço sem ganhar o papel de servidor. A chave é ocultada no histórico CLI, nos registros de configuração e na inspeção do banco. HTTP como serviço não é anunciado para PCs que suportam apenas Echo TCP.

Os terminais são simulados; os aliases de host não pretendem reproduzir um sistema Windows ou Linux inteiro. Comandos de configuração antigos e automações de laboratórios sem perfil conservam compatibilidade, incluindo configuração de rádio e habilitação L3 nos equipamentos genéricos que a suportavam. Perfis explícitos continuam sujeitos às suas restrições. Retenção por equipamento segue o [ADR-040](040-manual-initialization-terminal.md).

## Validação

Testes de motor exercitam ajuda dos 47 perfis, exemplos executáveis, rejeições sem mutação, IP e ping entre hosts, DHCP, associação Wi-Fi aberta/protegida, consultas SQL pela rede e ocultação de credenciais. Testes educacionais usam beacon gerado pelo motor e verificam a classificação das camadas, a precisão das explicações e a busca por endereços presentes.

Os cenários de navegador verificam centralização de equipamento distante, resultados ausentes, comandos e ajudas de host/switch, retenção do terminal, expansão dos campos, acesso por teclado, contraste e telas pequenas. A regressão percorre todas as abas dos 47 perfis e os fluxos de TCP, DNS, IPv6 e wireless. Build, tipos, lint e formatação integram a verificação final.

Conferência desta entrega: 601 testes unitários passaram, com um teste opcional ignorado; dez cenários de navegador passaram. Os dois cenários novos foram repetidos após os últimos ajustes no inspetor da rede. Build, tipos, lint e formatação passaram.
