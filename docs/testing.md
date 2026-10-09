# Testes

- Zonas: HTTP LAN→WAN com PAT, LAN/WAN→DMZ com inspeção por porta, bloqueios de entrada/serviço, primeira regra, permit sem sessão, retorno adulterado, interfaces sem zona, mesma zona, deny sobre retorno/erro, expiração, CLI/running-config e persistência validada. E2E edita/aplica regras, observa timeout, libera HTTP, inspeciona a citação ICMP e reabre desktop/mobile.
- ICMP: TTL em trânsito TCP/UDP/Echo, falta de rota, porta UDP fechada, citações e NAT nos dois sentidos (estático/dinâmico/PAT), erros de roteador intermediário, probes do roteador com IPv4 compartilhado pelo PAT, timers preservados, ACL, citações/portas/sequências adulteradas e ausência de erros sobre erros/broadcast/multicast. API retoma um erro citado em trânsito e rejeita política/citação adulteradas.

- Gerenciamento: SNMP GET/GETNEXT, OIDs inexistentes/fim da MIB, contadores e estados reais de interfaces, perda/retry, community incorreta, agente desativado, tooBig/MTU, correlação de ID/community/porta/OID, loopback e PAT/firewall. Syslog cobre PRI/origem após PAT, perda/ACL, filtro, eventos automáticos, prevenção de loops, fila/retensão limitadas, cancelamento, timestamps e saída de terminal. API restaura consulta/mensagem pendentes, rejeita adulteração e mantém ownership.
- E2E de gerenciamento: configuração do agente, community correta/incorreta, GET/GETNEXT, timeout, UDP/161 no inspector, envio/coleta syslog, save/reload e consulta mobile. Capturas `snmp-desktop.png`, `syslog-desktop.png` e `management-mobile.png` em `test-results`.

- DNS/TCP: fallback automático após TC=1, respostas segmentadas, perda de segmento, leitura parcial de framing, cache, loopback/CLI, ACL, PAT/firewall, correlação de transporte/conexão/ID e limites. API salva uma resposta parcial, restaura deterministicamente e rejeita referência TCP adulterada. E2E seleciona TCP no painel, inspeciona a conexão TCP/53 e reabre a consulta persistida.

- OSPF: adjacência/LSDB/SPF, ping e HTTP roteados, falha/caminho alternativo, áreas pelo backbone, retirada de prefixos, DR/BDR e Dead interval, perda de DD/request/update/ACK, incompatibilidade de área/Hello/MTU, ACL e preferência de rota estática. Snapshots são validados em cada transição e retomados de forma determinística. API rejeita rotas e timers inconsistentes.
- RIP: aprendizado, métrica mínima/infinito, poison reverse, falha/expiração/coleta, perdas, CLI, precedência de OSPF/estática e restauração determinística. API persiste tabela/timers e rejeita métrica 16 sem coleta.
- E2E de roteamento dinâmico: templates OSPF e RIP, inspeção de anúncios, shutdown pela CLI, rota alternativa e save/reload desktop/mobile. Capturas `ospf-desktop.png`, `ospf-mobile.png`, `rip-desktop.png` e `rip-mobile.png` em `test-results`.

- TCP: handshake, echo UTF-8 segmentado, HTTP 200/404, half-close, fechamento simultâneo, perda de SYN/SYN-ACK/ACK/dados/FIN e ACK final, RST inválido/porta fechada, ACK além dos bytes enviados, sequência fora de ordem e wrap de 32 bits, janela zero/reabertura, retransmissão limitada, loopback e remoção de equipamento.
- Firewall UDP/ICMP: DNS e ping através de PAT, retorno com portas/IPs/interfaces incorretos, ICMP com tipo/ID errado, ACL sobre sessão existente, expiração e compatibilidade de snapshots antigos. API salva dois transportes pendentes e rejeita timer/política adulterados. E2E configura o painel, valida DNS/ping, bloqueia ping externo e reabre as sessões em desktop/mobile.

- TCP integrado: ACL por porta, NAT estático/dinâmico/PAT sem rota de retorno privada, firewall contra SYN externo e ACK sem handshake, retorno rastreado, ACL sobre sessão existente e expiração. API persiste uma conexão em andamento e rejeita segmentos/timers inconsistentes e acesso de outro usuário.
- E2E TCP: template com PAT/firewall, HTTP e echo, inspector de cabeçalho, RST após desativar serviço e save/reload desktop/mobile. Capturas `tcp-http-desktop.png` e `tcp-mobile.png` são geradas em `test-results`.

- Conta: perfil, listagem/revogação de sessões sem exposição de tokens, IDOR, exclusão com senha e cascata.
- Políticas: ACL por ordem/protocolo/porta, NAT estático/dinâmico/PAT, DNS através de PAT, timers e snapshots.
- Labs: avaliações com tráfego novo no backend, isolamento do snapshot, progresso por revisão e rejeição de resultados forjados. A cópia de avaliação reinicia OSPF/RIP/VRRP e descarta conexões TCP e sessões de firewall antigas; testes verificam o caminho alternativo após a queda de um enlace. O horizonte inicial considera Dead + dois Hellos + um tick OSPF, com orçamento de 20 mil eventos; testes incluem eleição DR/BDR com intervalos padrão e máximos.
- Canvas: grupos, movimento sem alterar conectividade, anotações, snap/grade, viewport e reabertura. E2E inclui contas, políticas, labs e edição visual em desktop/mobile.
- Os testes validam apenas o escopo implementado. Recursos ausentes da matriz de cobertura não são considerados aprovados.

- Railway: configuração PORT/host/origem, proibição de banco/e-mail local em produção, inicialização/cadastro/login/projetos sem provedor de e-mail, ausência de tokens nesse modo, SMTP opcional com TLS, cookies Secure, allowlist de proxies, rate limit e declaração IaC sem secrets. E2E verifica o fluxo de conta conforme a disponibilidade de e-mail e a ausência de ações indisponíveis. CI adiciona construção e smoke test da imagem sem variáveis de e-mail; Docker/Railway real não foram executados nesta máquina.
- STP/RSTP: bloqueio de dados, learning MAC, eleição por prioridade/custo, PortFast, fallback para STP/half-duplex, falha/recuperação, timers e persistência. API rejeita snapshots de portas bloqueadas adulteradas.
- E2E RSTP: template redundante, bloqueio visual, shutdown/no shutdown pela CLI, ping com caminho alternativo, isolamento/timeout, BPDU inspector e reabertura mobile. Operações normais têm orçamento de 64 passos; o timeout de isolamento permite até 256 passos para processar também os Hellos periódicos.

- DNS no motor: nomes e tipos, A/AAAA/CNAME, NXDOMAIN/NODATA/SERVFAIL, loop de aliases, TTL, ping por nome, DNS local/roteado, servidores alternativos, VLAN, ID adulterado, truncamento UDP e nomes de 253 caracteres.
- API DNS: restauração determinística de consulta pendente, cache persistido, ownership e rejeição de registros, cache e timers adulterados.
- E2E DNS: CRUD de registros, nslookup pelo xterm, consulta A/AAAA/CNAME, cache, inspeção de pacotes, ping por nome, servidor desligado/recuperado, save/reload e viewport mobile. A simulação avança pelo controle Próximo evento, com orçamento de passos.

- Vitest: motor com ARP, MAC, VLAN access/trunk, routes/return path, TTL, perda, CLI, determinismo e persistência.
- DHCP: DORA real sobre UDP/Ethernet, opções aplicadas, ping local e roteado pelo gateway aprendido, isolamento VLAN, NAK, T1/T2, expiração, release, concorrência, exclusões, esgotamento, CLI e retorno para IP estático.
- API: PostgreSQL/PGlite real em memória; cadastro/verificação/login, cookie flags, origem/CSRF, IDOR em todos os métodos, validação/import, mass assignment, revisão otimista, snapshots, payload inválido/grande, token single-use, revogação, rate limit e headers.
- Performance: estrela com 78 hosts e 13 switches, limite de eventos e repetição da mesma seed. Não é benchmark de milhares de equipamentos.
- Playwright: usuário real de teste, e-mail local, canvas vazio, inserção de PCs/switch, seleção múltipla e desseleção, conexão de portas, configuração IPv4, ping/ARP, save/reload, redes roteadas e shutdown/no shutdown pela CLI.
- Responsividade: desktop 1440 × 960 e mobile 390 × 844. No mobile, dashboard, reabertura da topologia e consulta de IPv4 no diálogo de interface. O fluxo verifica ausência de erros JavaScript e transbordamento horizontal.
- DHCP relay/ARP: DORA por dois roteadores, giaddr/hops/portas, reservas locais/remotas, isolamento de pools, T1 sem helper, T2 com ACL bloqueando T1, perda, invalidação de bindings, CLI, restore durante oferta e resolução ARP, três tentativas e respostas tardias. API rejeita pools remotos, reservas, interfaces relay e timers ARP adulterados. E2E cria pool remoto, edita reserva/relay, inspeciona giaddr, testa ping/release e save/reload desktop/mobile.
- API DHCP: enum de templates compartilhado com OpenAPI, save/load de concessões, renovação determinística após restauração, ownership e rejeição de pools, leases e timers adulterados.
- E2E DHCP: criação de pool, dois clientes automáticos, inspeção de UDP/opções DHCP, ping, liberação/renovação, save/reload e painel mobile. O teste usa o botão Próximo evento com orçamento de 64 passos por operação; não depende do tempo real necessário para renderizar cada etapa.

`npm test` usa PGlite por padrão. `TEST_DATABASE_URL` habilita PostgreSQL servidor em um banco de teste dedicado. Nunca use um banco de produção: a suíte cria usuários/projetos de teste.

E2E usa o servidor existente em desenvolvimento ou inicia um. E-mails só são lidos do diretório local para o endereço criado pelo próprio teste. Capturas e traces ficam em test-results e playwright-report. São ignorados pelo Git.

A regressão de seleção protege a sincronização entre React e XYFlow: adicionar equipamentos, selecionar vários nós com Shift e fechar o inspetor não pode provocar um ciclo de atualizações. O motor continua sendo a fonte do estado da rede; seleção é estado visual.

Limitações: não há teste de SMTP externo/entrega real, infraestrutura de HTTPS ou ambiente de produção nesta máquina. Compose precisa de Docker instalado.

- VRRP IPv4: eleição por prioridade/IPv4, dono 255, preempt, anúncios de prioridade zero, VLAN/ACL, shutdown por interface, MAC virtual em ARP requests/replies e ARP gratuito, cache conservado e ping/HTTP após falha/retomada. Timers e estados retomam deterministicamente; configuração, CLI e snapshots adulterados são verificados. A API persiste eleição pendente e mantém isolamento por proprietário.
- E2E VRRP: edição de grupo no painel, anúncio protocolo 112 no packet inspector, queda do primário, HTTP antes/depois, save/reload e viewport mobile. Capturas `vrrp-desktop.png`, `vrrp-packet-desktop.png` e `vrrp-mobile.png` em `test-results`. Use `npm run test:e2e -- --grep "VRRP:"` para o fluxo específico.

Verificação da entrega VRRP: 219 testes em 14 arquivos e 16 fluxos E2E passaram. Build, typecheck, lint e formatação passaram. As capturas desktop/mobile e o relatório Playwright correspondem à execução local no Windows/Edge.

- BGP: 11 testes do motor mais persistência/validação na API. Políticas, eBGP/iBGP/reflexão, AS_PATH, Hold, sessão longa e ping/HTTP após reconvergência. O fluxo E2E BGP passou em Windows/Edge: painel, CLI, packet inspector, falha, HTTP, save/reload e mobile; capturas `bgp-policy-desktop.png` e `bgp-mobile.png`. Verificação desta etapa: 231 testes em 15 arquivos, build/typecheck e fluxo BGP E2E aprovados.

- Interfaces VLAN/VRF: oito testes do motor mais save/load dos três templates na API. São verificados dot1q, SVI, switch L3, STP nas portas físicas, falhas administrativas, ARP e tuplas TCP sobrepostos e bloqueio entre tabelas. Os três fluxos L3 E2E passaram: criação/configuração de interface, HTTP, seleção de VRF e persistência desktop/mobile. Verificação da etapa: 240 testes em 16 arquivos.

- Tracking VRRP: três testes adicionais e um fluxo E2E passaram, incluindo perda de carrier/rota com o primário ligado, prioridade reduzida, ping/HTTP pelo backup, recuperação e save/reload. Captura `tracking-mobile.png`.

- LACP: sete testes do motor, save/load na API e fluxo E2E passaram. São cobertos min-links, active/passive, STP no agregado, hash/VLAN, falha de membro, HTTP, BGP sobre subinterfaces e restore estável. E2E inspeciona PDU e conserva tráfego/persistência mobile. Capturas `lacp-desktop.png`/`lacp-mobile.png`. Verificação da etapa: 251 testes em 17 arquivos.

IPv6: testes de DAD/SLAAC, NDP/timers, ICMPv6 roteado/erros/MTU, ACL, VRF, SVIs, subinterfaces LACP, rotas estáticas, CLI/rollback e API com continuação determinística. E2E verifica configuração, ping, Hop Limit, inspeção e save/load em desktop/mobile.

Wireless: associação aberta/WPA2/WPA3 didáticos, rejeição de credencial, canal/SSID, sinal/interferência, dois clientes, DHCP, IPv6, HTTP, CLI e roaming. API restaura negociação pendente; E2E verifica recuperação de chave incorreta, HTTP, inspeção e save/load mobile.

- VPN/SD-WAN: túneis transportam ping/HTTP/IPv6; autenticação, replay/corrupção, PAT, ACL, MTU, failover e restore. Políticas filtram SLA medido e ordenam transportes, com bloqueio/fallback; controller distribui configuração pelo UDP. API recusa underlay/timers adulterados.

- QoS/MPLS: ordem e espera em filas reais do modelo, prioridade/WRR, DSCP/TC, policer/tail drop, push/swap/pop/stack, TTL/MTU e labels desconhecidos. API persiste filas e labels durante ARP; E2E configura e transporta HTTP com PDU/save/load desktop/mobile. BGP mantém a regressão de sessão longa; recálculo de FIB ignora entradas sem mudança, preservando restore e reconvergência.

## Automação, perfis e desafios avançados

NETCONF/RESTCONF: RPCs TCP, candidate/validate/commit, lock/revisão, privilégios, patches atômicos, conexão interrompida/recuperada, automação local e por rede, timeouts/ACL e restore. Telemetria: sensores, MTU, múltiplos datagramas, reordenação, chave/replay e persistência. NTP: cálculo de offset/atraso, emissão após ARP, peers alternativos, sincronização independente do relógio global e restauração.

Catálogo: todos os 39 perfis validados, portas/MACs únicos, DNS/HTTP pela rede, DAC/QSFP e rejeição de alcance/socket/módulo inválidos. Labs: 17 cenários quebrados/corrigidos, execução em cópia e impossibilidade de aprovar somente com resultados antigos. API avalia AAA/EVPN/automação e persiste perfis QSFP. E2E usa os seletores `Automação:`, `Catálogo:` e `Lab avançado:` e produz capturas desktop/mobile.

SNMP em switch L3: agente e coletor acessíveis pelas SVIs, estado operacional da interface VLAN, consulta de outro agente pelo roteamento e restore do tráfego pendente.

Regressão local de 2026-10-07: 354 testes em 30 arquivos passaram. Os 33 cenários E2E foram aprovados em Windows/Edge, com reexecução de firewall/zonas, criação da LAN e catálogo após os ajustes finais. Typecheck, lint, formatação e build aprovados; capturas desktop/mobile revisadas.

## Ampliação dos sete blocos de redes — 2026-10-08

A suíte completa de motor/API passou com 429 testes em 48 arquivos. São verificados:

- IPv6 TCP/UDP/DHCPv6, IA_NA/IA_PD, DAD/NUD, renovação/rebinding/expiração, ACL e snapshots; TCP com flight/janela, reordenação, slow start/CA/NewReno, RTO adaptativo e recuperação de perdas.
- PVST/MSTP, snooping/source guard/DAI e conflitos DHCP, fragmentação/reassembly com overlap/limites/ICMP, NAT hairpin/SIP ALG e DNSSEC/EDNS/TCP fallback.
- CAPWAP centralizado e mesh com canal protegido, replay/corrupção/falha/restore; EAP-TLS/PEAP com fragmentação EAP, octetos RADIUS, confiança/certificado/Finished e tráfego AES-GCM; IDS/IPS sobre dados segmentados.
- Proxy/balanceador e saúde de backends, SIP/RTP, IPP, MQTT, serial/console e orçamento/prioridade PoE. Configurações e estados operacionais são validados ao persistir.
- OSPF stub/NSSA/LSAs externos/redistribuição/autenticação, RIPv2 com codec SHA-256/filtros/key chains, renovação de SAs VPN, CHAP/RADIUS/TACACS+ com autorização/accounting, NETCONF XML/framing/datastores e RESTCONF HTTP/recursos/revisão em canal TLS.
- Desafios com pesos, referências e baseline/revisões; avaliação por tráfego novo e rejeição de resultados fabricados; melhor pontuação sem multiplicar tentativas; tutorial de cinco etapas com pré-requisitos e progresso persistido. A API testa ownership e CSRF usando a autenticação existente.

Os testes de navegador cobrem os fluxos entregues de forma incremental, com nove cenários de aprendizagem, AAA, VPN/SD-WAN, automação, RIP, OSPF, serviços IPv6, EAP-TLS e PEAP. A reabertura do painel PEAP conserva a senha configurada. Lint, typecheck, build e formatação passaram. Capturas mobile e desktop são revisadas em test-results. A lista de testes não certifica conformidade binária dos protocolos nem implantação externa; os subconjuntos estão nos ADRs 029–034.

## Blocos de produto e transporte — 2026-10-09

463 testes em 57 arquivos passaram com PostgreSQL servidor local. Os 40 cenários E2E foram aprovados em Windows/Edge, com execução completa e reexecução após correções nos cenários afetados. A nova cobertura inclui desenho/comentários/histórico, infraestrutura/recursos/banco HTTP, formulários guiados, foco de modal e axe, 2000 equipamentos em Worker, rate limit/notificações entre instâncias, backup AES-GCM/restauração, SACK/ECN/timestamps/PMTUD, DHCPv6 relay e captura PCAP. O cenário TCP verifica negociação através de PAT/firewall e baixa/decodifica os bytes do HTTP; a captura também passa no Scapy independentemente do codec TypeScript. A regressão PMTUD cobre NAT estático/dinâmico/PAT na saída do próprio roteador e preserva as citações de hairpin.

Execute `npm run benchmark` para registrar a árvore L2 com 100/500/1250/2000 dispositivos em `benchmarks/scale.json`. O teste `Escala:` importa a topologia gerada, executa o Worker, pausa/retoma, confirma ping e salva. Os limites de carga e a descrição do tráfego fazem parte do resultado; não se presume desempenho equivalente em redes arbitrárias.

`npm run test:postgres` usa somente o cluster portátil de testes descrito em [produção](production-operations.md). `scripts/verify-captures.py` requer Scapy 2.8.0 e lê os arquivos gerados por `tests/wire-capture.test.ts`, sem abrir interfaces de rede. O CI prepara PostgreSQL 18, valida as capturas, constrói as imagens, valida Prometheus/Alertmanager e verifica HTTPS local com Caddy e o status de backup entre containers. Esses passos de containers ainda não foram executados nesta máquina sem Docker; deploy e entrega externa não estão aprovados pelos testes locais.
