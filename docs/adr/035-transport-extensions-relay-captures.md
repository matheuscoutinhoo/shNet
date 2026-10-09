# ADR-035: extensões TCP, relay DHCPv6 e capturas binárias

Data: 2026-10-09. Estado: implementado; os limites abaixo fazem parte do contrato.

## TCP e MTU

As opções são configuradas no painel TCP e aplicadas às próximas conexões. Snapshots antigos conservam o transporte anterior, com MSS 536 e opções desativadas. O novo contrato permite MSS de 64 a 8960 bytes, limitado pela MTU de saída, pelas opções presentes no cabeçalho e pelo MSS do peer. Os buffers continuam em 16 KiB e as filas em até 64 segmentos.

SACK é negociado por SYN e conserva um scoreboard dos segmentos confirmados seletivamente. O ACK cumulativo continua responsável por liberar dados. A retransmissão procura a primeira lacuna; timeout limpa o scoreboard para admitir reneging. ACKs ou blocos fora dos bytes efetivamente enviados não confirmam dados.

ECN negocia ECE/CWR no handshake. As filas QoS com `ecnThreshold` marcam CE em dados ECT antes do limite de descarte. O receptor mantém ECE até CWR; o emissor reduz CWND uma vez por janela em voo. Timestamps negociados permitem PAWS e medição de RTT após retransmissão com eco não ambíguo. Os estados e relógios são persistidos e validados.

PMTUD usa DF/ICMP Fragmentation Needed em IPv4 e ICMPv6 Packet Too Big em IPv6. A citação precisa corresponder à tupla, VRF/interface e sequência de um segmento ainda em voo. MTUs menores que 576/1280 ou maiores que a MTU conhecida são recusadas. A conexão divide novamente os dados UTF-8 mantendo as sequências e retransmite as lacunas. Desativar PMTUD desativa a reação às citações; a MTU da interface local continua sendo respeitada.

Quando o roteador que faz NAT encontra a MTU menor em sua saída, verifica a ACL sobre o pacote traduzido e gera o erro citando o cabeçalho antes do SNAT. Isso conserva a tupla original e evita consumir o erro no endereço global do próprio roteador. NAT estático, dinâmico e PAT são cobertos; o caminho de hairpin conserva sua tradução específica de citações.

Não há window scaling, DSACK, persist probes, keepalive, PLPMTUD, PMTUD por aumento periódico da MTU ou conformidade completa de uma stack TCP. Referências: [SACK](https://www.rfc-editor.org/rfc/rfc2018.html), [ECN](https://www.rfc-editor.org/rfc/rfc3168.html), [timestamps](https://www.rfc-editor.org/rfc/rfc7323.html), [PMTUD IPv6](https://www.rfc-editor.org/rfc/rfc8201.html).

## Relay DHCPv6

O painel DHCPv6 configura servidores upstream na interface LAN do relay, peers autorizados no servidor e pools com prefixo remoto. RELAY-FORW/RELAY-REPL circulam por UDP 547, atravessando rotas, NDP, MTU e ACL do motor. O envelope conserva link-address, peer-address, hop-count e Interface-ID em até oito relays. A seleção do pool remoto usa o prefixo mais específico. A resposta precisa vir de um servidor configurado e corresponder ao cliente, IAID, transação e cadeia de hops pendentes.

IA_NA passa por DAD. IA_PD instala rotas de retorno no servidor e nos relays, com renovação, expiração e remoção após RELEASE. Os limites são 128 correlações pendentes e 128 delegações por interface; correlações expiram em 30 segundos virtuais. RA continua fornecendo o gateway. A configuração IPv6 é obrigatória e o relay deve esperar DAD do endereço global/ULA da LAN.

Há codecs binários para os tipos de mensagem usados pelo modelo, DUID, IA_NA, IA_PD, IAADDR, IAPREFIX, DNS, status, rapid commit e relay aninhado. Opções desconhecidas são ignoradas na leitura; opções duplicadas, comprimentos inválidos e excesso de hops são recusados. O subconjunto conserva uma IAID por mensagem e uma delegação/interface downstream por cliente. Não há autenticação DHCPv6, Reconfigure ou operação irrestrita de todas as opções. Referência: [DHCPv6](https://www.rfc-editor.org/rfc/rfc9915.html).

## Ethernet e PCAP

**Opções do laboratório → Exportar captura PCAP** gera PCAP 2.4 Ethernet com resolução de microssegundos e horários do relógio virtual. A captura usa somente os eventos FRAME_SENT retidos, limitada ao histórico de 1500 eventos; permite filtrar um enlace. Cada transmissão em cada enlace é um registro, incluindo perdas e retransmissões. O usuário recebe a quantidade e os motivos das omissões antes do download.

Os codecs escrevem Ethernet/802.1Q sem FCS, ARP, IPv4/IPv6, TCP com opções, UDP, ICMP/NDP, DNS/EDNS, DHCPv6/relay, RIPv2 e os octetos RADIUS disponíveis. IPv4 e os transportes possuem checksums calculados sobre os bytes. O decoder de Ethernet verifica comprimentos e checksums; o decoder PCAP limita tamanho, número de registros, link type e registros truncados. Decodificar bytes não importa uma topologia nem reconstitui IDs de equipamentos do simulador.

DNSSEC usa uma representação assinada própria do modelo; não é exportado como RRSIG RFC. DNS sobre TCP e aplicações com framing didático são omitidos. Também são omitidos fragmentos que carregam envelopes do simulador, OSPF/BGP didático, VPN/TLS/CAPWAP/mesh, MPLS, STP/LACP/EAPOL e PDUs wireless sem codec. Não há extensões IPv6 no decoder, PCAPNG, FCS ou captura completa de uma sessão cujo histórico foi descartado. ICMP conserva citações mínimas, sem reconstruir o pacote original inteiro.

## Verificação

Os testes de transporte cobrem negociação e fallback, duas lacunas SACK, CE/ECE/CWR no tráfego real, PAWS, MTU local sem PMTUD, perda com MSS jumbo, citações adulteradas, MTU reduzida IPv4/IPv6 e restore determinístico. Relay é verificado com um e dois saltos, IA_NA/IA_PD, ping pela delegação, renovação, RELEASE e respostas/snapshots inválidos.

Os testes dos codecs conferem bytes conhecidos de DNS, checksums, VLAN, tamanhos e erros. `scripts/verify-captures.py` valida os arquivos gerados independentemente com Scapy 2.8.0: HTTP/TCP, DNS, NDP e relay DHCPv6 aninhado. O cenário TCP E2E configura as opções, verifica negociação, baixa o PCAP e decodifica seu conteúdo HTTP. A aprovação cobre esse subconjunto; não declara interoperabilidade de todos os protocolos educacionais.
