# ADR-031 — Equipamentos e serviços sobre a rede simulada

Estado: implementado, configurável por painel/API/CLI e verificado por testes. Conta e integrações externas continuam fora do escopo.

Proxy HTTP encaminha GET com URL absoluta para destinos IP autorizados, por conexões TCP de entrada e saída. Balanceador escolhe backend por round-robin ou menor número de requisições pendentes. Health checks HTTP, timeout e recuperação alteram essa escolha. O proxy preserva a meia conexão quando o cliente envia FIN antes da resposta do backend.

Telefone troca INVITE/200/ACK/BYE, Call-ID/CSeq, SDP PCMU e RTP com sequência/timestamp/SSRC. A mídia exige a tuple negociada. ALG SIP reescreve Via/Contact/SDP, expira pinholes de mídia e os remove no BYE. Firewall admite RTP RELATED somente com sessão SIP autorizada ainda válida; deny explícito prevalece.

Impressora recebe Print-Job por HTTP/631, interpreta atributos IPP/1.1, mantém spool, consome papel e processa páginas no relógio virtual. Há consulta de trabalho/impressora e cancelamento com verificação do dono. IoT e broker trocam MQTT 3.1.1: CONNECT/CONNACK, SUBSCRIBE/SUBACK, PUBLISH QoS 0, retained, filtros +/#, ping e disconnect. Keepalive encerra sessões perdidas; TCP consome o stream sem acumular todas as publicações.

Serial WAN possui DCE/DTE, clock de 9.600–2.000.000 bits/s, serialização pelo clock e CRC-16/FCS do envelope HDLC. IPv4 ponto a ponto entrega ao peer sem ARP. Console UART conecta sockets com baud compatível, executa CLI do peer sem IP e persiste contexto/histórico. PoE modela PSE/PD, af/at/bt, classes 0–8, reserva de potência, orçamento e prioridade; PD dependente perde alimentação quando falta cabo/PSE/orçamento. Snapshots rejeitam alocações inconsistentes.

## Configuração

Inspector: **Aplicações**, **Serial / PoE**, **Políticas** (ALG). Perfis Proxy HTTP, Balanceador HTTP, Broker MQTT, Telefone IP e Impressora IP usam esses motores.

CLI: `phone|proxy|printer|broker configure JSON`, `phone call IP`, `phone hangup ID`, `print IP PAGINAS NOME`, `mqtt connect IP ID`, `mqtt subscribe FILTRO`, `mqtt publish TOPICO VALOR`, `show phone|proxy|printer|broker|iot`, `hardware add serial JSON`, `hardware add console`, `console LINK COMANDO`, `poe configure JSON`, `[no] ip nat alg sip` e `show ip nat alg`.

## Evidência e limites

`tests/applications.test.ts`: distribuição/falha/recuperação de backend; proxy/recusa; impressão/cancelamento/restauração; MQTT wildcards, retained, keepalive e publicações sucessivas. `tests/voice-alg.test.ts`: SIP/RTP por PAT/firewall, origem incorreta, SDP sem ALG e persistência. `tests/hardware.test.ts`: clock/FCS, console sem IP/contexto e orçamento/prioridade/perda de PoE.

MQTT e IPP possuem codecs de octetos representados em hexadecimal no TCP textual do simulador, sem sockets externos. SIP é tipado, sem parser de todas as extensões, PBX/registrar ou áudio reproduzível; a demonstração RTP encerra após 250 pacotes por lado. Proxy suporta GET sem TLS/CONNECT/cache. IPP cobre operações/atributos definidos no motor. Serial não modela bit stuffing físico ou PPP. PoE representa classificação/orçamento, sem circuito elétrico analógico.

Referências: [SIP — RFC 3261](https://www.rfc-editor.org/rfc/rfc3261.html), [IPP — RFC 8010](https://www.rfc-editor.org/rfc/rfc8010.html), [MQTT 3.1.1 — OASIS](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html).
