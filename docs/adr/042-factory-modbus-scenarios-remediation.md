# ADR-042 — Fábrica IP, Modbus e ensaios repetíveis

Data: 2026-10-13. Estado: implementado com limites explícitos.

## Escopo e decisão

A auditoria de fábrica encontrou defeitos de execução/captura, gerenciamento L2 e convergência, além de necessidades de produto. O usuário escolheu PLC/HMI com Modbus TCP e rede IP. O incremento cobre esse modelo; protocolos de anel industrial, PTP/TSN, firmware real e codecs de vídeo continuam fora dele.

O template **Fábrica segmentada e redundância IP** possui 43 equipamentos, 47 enlaces e oito VLANs. Incorpora relay nos dois firewalls, pools disjuntos por giaddr, retorno WAN pelo VIP, bloqueio visitante→MES e PLCs com registradores. Serviços únicos e endpoints com conexão única são informados pelo preflight e podem ser desligados nos cenários. Dois firewalls não demonstram HA dos serviços, do WAN ou das sessões stateful.

## Execução e evidências

- **Evento a evento** avança uma quantidade de eventos; o multiplicador ajusta sua reprodução didática.
- **Tempo real** solicita o horizonte `clockInicial + tempoReal * velocidade`. Um Worker processa até esse horizonte com orçamento de CPU de 100 ms e comunica deltas. Não salta eventos pendentes quando o orçamento acaba. A interface informa inicialização, eventos/s e atraso. A verificação de interface usa tolerância de −20%/+10% depois de o Worker sinalizar pronto. O sincronismo depende da capacidade da máquina; atraso não é escondido.
- O histórico visual conserva 1.500 eventos. Diagnósticos conservam 4.000 registros relevantes. A captura mantém até 10.000 frames ou 2 MiB estimados de JSON UTF-16, com descarte contado. RSTP/LACP/VRRP/OSPF/RIP são filtrados antes da retenção por padrão; podem ser incluídos a partir do momento da opção.
- Captura e diagnósticos são persistidos. Os deltas preservam a mesma janela de frames no Worker e na interface, inclusive quando o limite por bytes é atingido. PCAP identifica frames retidos, exportáveis, omitidos e motivos. Somente os codecs disponíveis são exportáveis.

## Convergência e gerenciamento

O RSTP tratava um agreement recebido como informação candidata a root port. Isso realimentava custo/eleição após a perda da distribuição e prolongava a interrupção. O agreement agora confirma a proposta da porta designated, sem participar como anúncio de raiz. Proposal não reinicializa repetidamente portas já acordadas. Os testes preservam STP clássico e MST/PVST/RSTP existentes.

Os relays em interfaces de gateway VRRP encaminham broadcasts DHCP somente quando o membro está ACTIVE. Isso evita ofertas concorrentes que substituíam a reserva do cliente e causavam NAK contínuo no template com os dois membros disponíveis; o relay do backup assume após a eleição.

Uma SVI com endereço permite a stack de gerenciamento do switch L2. SNMP e syslog não dependem de `ipRouting`; esse sinal continua controlando o encaminhamento entre VLANs.

## PLC/HMI e Modbus

Há perfis PLC e HMI no catálogo. PLC possui holding registers de 16 bits (1–1.024), Unit ID 1–247 e serviço TCP/502 configurável. As operações suportadas são 03 (leitura), 06 (escrita única) e 16 (escrita múltipla). Requisições verificam quantidades e valores; o servidor verifica MBAP, função, Unit ID e intervalo de endereços e devolve exceções. Não há ladder, lógica do processo, coils, input registers ou outros protocolos industriais.

O codec monta MBAP/PDU em bytes e o transporta como hexadecimal terminado por newline no TCP textual do motor. Portanto, o modelo valida operações Modbus na topologia, mas não produz tráfego binário Modbus interoperável com hardware nem PCAP Modbus completo. Essa limitação está na matriz exibida ao usuário.

Referência de operações: [Modbus Application Protocol V1.1b3](https://www.modbus.org/docs/Modbus_Application_Protocol_V1_1b3.pdf).

## Cenários e SLA

Menu **Opções do laboratório → Validar fábrica e cenários**. Fluxos ICMP, HTTP e Modbus; fontes por ID/nome, destino IPv4, perda/latência máximas, deadline, registradores esperados e exigência de sucesso da última amostra. Falhas agendadas desligam/restauram dispositivos ou enlaces. A execução usa uma cópia isolada do snapshot e não modifica a topologia em edição.

Até 180 amostras, 16 fluxos, 32 falhas e 120 s virtuais por cenário. Até 32 definições são salvas no laboratório. Há modelos de baseline Modbus, perda/restauração de firewall, distribuição, célula, PLC, SCADA e segmentação de visitantes. São metas demonstrativas editáveis, sem representar um SLA contratado de produção.

Os relatórios exportam definição, versão do motor, resultados por amostra, perda, p95/p99, jitter p95, recuperação observada, resolução da amostragem, preflight e diagnósticos. Recuperação é o primeiro sucesso observado depois de uma falha observada, relativo à injeção; não é um instante exato de reconvergência. `deny` exige transação iniciada e ausência de resposta, sem provar sozinho a causa; o diagnóstico permite investigar bloqueio, falta de rota e indisponibilidade. Comparação de baseline/falhas mantém até dez relatórios durante a sessão do painel.

## Recursos adicionais

RF permite posição física em metros independente da posição visual e obstáculos como segmentos 2D com atenuação explícita. Não modela reflexão/difração nem substitui levantamento RF. A revisão de configuração inclui diff antes/depois de equipamentos, enlaces, canvas e parâmetros do projeto; edição em lote de endereçamento é validada antes da aplicação e pode ser desfeita. A visão geral usa rótulos simplificados para mais de 20 equipamentos em zoom reduzido; o canvas é reenquadrado ao entrar na faixa de tela estreita.

MQTT 3.1.1 acrescenta usuário/senha e PUBLISH QoS 1 com PUBACK, retransmissão DUP e limite de tentativas. Assinaturas permanecem QoS 0; QoS 2, TLS, sessões persistentes e reconexão automática não foram implementados. O transporte e o broker continuam educacionais. Referência: [MQTT 3.1.1 — OASIS](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html).

Colaboração simultânea, RBAC, SNMPv3/traps, clonagem integral de célula com remapeamento e agregação automática de trunks permanecem necessidades de produto. Não são aprovadas pela regressão desse incremento.
