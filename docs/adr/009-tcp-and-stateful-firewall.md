# ADR-009 — TCP e firewall de trânsito no relógio virtual

Status: aceito. A cobertura UDP/ICMP foi ampliada pelo [ADR-012](012-multiprotocol-firewall.md); os limites abaixo descrevem a entrega TCP original.

O cabeçalho TCP do checkpoint não participava da união de pacotes. Agora TCP atravessa as mesmas decisões de IPv4, ARP, VLAN, STP, MTU, ACL e NAT utilizadas pelos protocolos existentes. Não há sockets ou requisições HTTP do host para simular comunicação.

O transporte fica em módulos separados: contratos, transmissão/timers, máquina de estados, aplicações e validação de snapshots. Serviços HTTP e echo só recebem bytes aceitos pela conexão. Flags, portas, contadores, buffers, segmentos pendentes, sequência, ACK e timers são serializáveis. Conexões antigas concluídas podem ser descartadas para limitar o histórico; conexões ativas nunca são removidas para abrir espaço.

Escolhemos um único segmento pendente por direção, com MSS conservador de 536 bytes, ACK cumulativo e retransmissão exponencial limitada. Essa escolha permite ensinar handshake, perda, duplicação, janela, half-close e TIME-WAIT sem apresentar um controle de congestionamento incompleto como TCP de produção. Dados fora de ordem recebem ACK cumulativo, mas não são armazenados. Sequências usam aritmética módulo 2³². O payload é texto UTF-8 e a segmentação preserva caracteres inteiros.

O firewall opcional protege trânsito TCP entre interfaces confiáveis e não confiáveis em roteadores. Rastreia os dois sentidos pelo tuple IPv4/porta após DNAT e antes de SNAT, verifica abertura e limites de sequência/ACK, e mantém expiração própria. ACLs de entrada e saída continuam obrigatórias quando configuradas. Estado rastreado não garante que um pacote tenha sido entregue: uma ACL de saída ou um link ainda pode descartá-lo. O modelo não cobre tráfego destinado ao próprio roteador, UDP/ICMP stateful, inspeção de aplicação, TLS ou NGFW.

Os novos campos são opcionais no schemaVersion 1; snapshots antigos continuam válidos. Importações validam timers correspondentes, referências, unicidade, consistência de segmentos e contadores. Isso protege a coerência do laboratório, mas não autentica como verdade histórica o conteúdo importado.

Referências: [TCP RFC 9293](https://www.rfc-editor.org/rfc/rfc9293.html), [timers RFC 6298](https://www.rfc-editor.org/rfc/rfc6298.html). O modelo não declara conformidade integral com esses documentos.
