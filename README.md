# shLab

<img src="apps/web/public/shlab-mark.svg" alt="Logo shLab: um terminal com prompt e conexão de rede" width="80" height="80" />

Um laboratório de redes web em português, com motor determinístico de eventos discretos. O canvas, o terminal NetOS e o inspetor consomem o mesmo estado.

## Executar

Requer Node.js 24+.

```sh
npm ci
# Copie .env.example para .env (PowerShell: Copy-Item .env.example .env)
npm run dev
```

Abra http://127.0.0.1:5173. O modo local explícito usa PostgreSQL embarcado via PGlite e persiste em `.data/postgres`. Ele não é permitido em produção.

Cadastre-se pela interface. Sem SMTP configurado, o e-mail de verificação é gravado como `.eml` em `.data/mail` — abra o arquivo e acesse o link. Isso também funciona para recuperação de senha. Não há conta/senha padrão nem bypass de autenticação. Os arquivos contêm tokens e devem permanecer privados, fora do Git.

### PostgreSQL + SMTP com Docker

```sh
docker compose up -d
```

No `.env`, use:

```dotenv
DATABASE_MODE=server
DATABASE_URL=postgresql://shlab:shlab_dev_only@127.0.0.1:5432/shlab
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
APP_ORIGIN=http://127.0.0.1:5173
```

Depois execute `npm run db:migrate` e `npm run dev`. Os e-mails aparecem no Mailpit em http://127.0.0.1:8025. As credenciais do Compose destinam-se somente ao desenvolvimento local.

[Guia de conceitos e experimentos](docs/network-concepts.md) · [Checklist de implementação de redes](docs/network-implementation.md) · [Cobertura e limites](docs/requirements-coverage.md)

## O que funciona

- Cadastro, verificação de e-mail, login, logout, reenvio de verificação, recuperação e alteração de senha, revogação de sessões.
- Nome de perfil, sessões individuais revogáveis e exclusão da própria conta com senha. Identidade visual azul/ciano com acentos neon e tipografia local.
- Laboratórios privados, favoritos, templates, autosave com revisão otimista, snapshots e import/export JSON.
- Canvas com zoom/pan, seleção múltipla, arrastar/adicionar dispositivos, grade/snap, minimapa, temas, busca, notas, desenhos, comentários ancorados, duplicação e undo/redo. Histórico privado de atividades no dashboard.
- Catálogo extensível com 47 perfis, incluindo rack, patch panel, UPS, banco de dados, WLC, mesh e IDS/IPS. RJ45/SFP/QSFP, cobre/fibra/DAC, módulos configuráveis, validação de alcance/velocidade, power e shutdown. CPU, memória e temperatura derivam do trabalho e da configuração do motor.
- Ethernet, flooding por VLAN, aprendizado/aging MAC, ARP request/reply/cache e retransmissão limitada, IPv4/CIDR, ICMP echo/time-exceeded, gateway e rotas estáticas por longest prefix match.
- VLAN access/trunk/native/allowed. Latência, jitter, perda com seed, MTU e TTL.
- STP/RSTP em árvore comum: BPDUs, eleição por prioridade/MAC/custo, root/designated/alternate, estados de portas, PortFast, reconvergência e limpeza da tabela MAC. Painel, CLI e bloqueios no canvas.
- UDP e DHCPv4: DORA, pools locais/remotos, relay, reservas por MAC, exclusões, gateway/DNS, leases, renovação T1/T2, NAK, release e expiração no tempo virtual. Configuração pela CLI e pelo inspetor.
- DNS sobre UDP/IPv4: registros A, AAAA e CNAME, nslookup, ping por nome, cache com TTL, servidores alternativos, timeout e inspeção de consultas/respostas. Usa servidores configurados na interface ou recebidos por DHCP.
- Terminal xterm com DSL NetOS, histórico e comandos que alteram a simulação.
- Tempo virtual, pause/play/step, velocidade, frames animados, timeline, resultados de probes e inspetor com explicação dos eventos.
- Testes de domínio, integração, autorização e fluxo no navegador.
- ACL de entrada/saída, NAT estático/dinâmico/PAT e firewall TCP/UDP/Echo, com zonas, regras por porta e erros ICMP relacionados/citados.
- 23 labs guiados/desafios com avaliação por tráfego novo no backend, tarefas e progresso por revisão; grupos, regiões, notas, snap configurável e viewport salvo.
- Inspetor global com protocolos, overlays/QoS, AAA/segurança, automação/relógio, referências IP, caminho observado e pilha OSI.
- BGP IPv4/VRF/SVI/subinterfaces, LACP, tracking VRRP, ICMPv6/NDP/SLAAC, wireless, VPN/SD-WAN, QoS/MPLS estático, VXLAN/EVPN, 802.1X/RADIUS/TACACS+ e inspeção HTTP/DNS.
- Automação por jobs, NETCONF XML base 1.0/1.1 e RESTCONF HTTP com canal TLS, running/candidate/startup, revisões, telemetria e NTP.
- TCP com janela deslizante, slow start/CA/NewReno, RTO adaptativo, SACK/ECN/timestamps e PMTUD; TCP/UDP IPv6, DHCPv6 IA_NA/IA_PD com relay e estados NUD. Captura PCAP dos frames com codecs binários disponíveis.
- PVST/MSTP, DHCP snooping/source guard/DAI e conflitos, fragmentação/reassembly IPv4, NAT hairpin/SIP ALG e DNSSEC/EDNS.
- WLC/CAPWAP, mesh, Wi-Fi empresarial PEAP/TLS e IDS/IPS; proxy/balanceador, SIP/RTP, IPP e MQTT, serial/console e PoE.
- OSPF stub/NSSA/externos/autenticação, RIP com filtros/hold-down/SHA-256, VPN com SPI/rekey/AES-GCM e AAA com autorização/accounting.
- Editor de desafios com objetivos/pesos/dicas, baseline e verificação por tráfego novo, pontuação global privada e tutorial interativo.

O template **Um gateway, dois roteadores** demonstra VRRP IPv4. Faça ping ou HTTP de PC-01 para WEB-01, desligue R-PRIMARY e avance a simulação até R-BACKUP assumir. O cache ARP mantém o MAC virtual. Configure e acompanhe grupos na aba **VRRP**; limites em [ADR-016](docs/adr/016-vrrp-ipv4-gateway.md).

O template **Três zonas, caminhos controlados** permite comparar acessos HTTP da LAN/WAN para a DMZ, bloqueios por serviço e traceroute através de PAT/firewall. Configure zonas e regras em **Políticas**; a timeline inspeciona o cabeçalho citado em erros ICMP. Limites em [ADR-015](docs/adr/015-firewall-zones-and-related-icmp.md).

### Experimento TCP / HTTP

Os templates **Rotas que se adaptam** e **Rotas por distância** acrescentam OSPF e RIPv2, com caminhos alternativos após falhas. Configure e inspecione os protocolos nas abas dos roteadores. Para DNS sobre TCP, abra **Nomes na rede** e selecione o transporte no painel DNS; o modo automático repete respostas UDP truncadas. Comandos e limites estão em [protocols.md](docs/protocols.md).

1. Abra **Da conexão à resposta** e selecione PC-01 → **TCP / HTTP**.
2. Inicie HTTP GET para 192.168.20.10:80; use Próximo evento até receber `200 OK`.
3. Inspecione SYN/ACK/FIN no filtro TCP da timeline e a tradução/sessão no painel Políticas do roteador.
4. Escolha Echo TCP, envie uma mensagem à porta 7 e observe os bytes devolvidos.
5. Desative HTTP no servidor e repita: a conexão recebe RST. Salve/reabra para preservar resultados e timers.

Fidelidade e limites do transporte: [protocols.md](docs/protocols.md).

Os formulários oferecem configuração guiada e editor JSON avançado. A simulação contínua roda em Worker; topologias grandes usam renderização por viewport. Os benchmarks e o teste de navegador cobrem até 2000 equipamentos. A API usa PostgreSQL para rate limits e notificações entre instâncias. Veja o [registro da entrega](docs/product-completion.md) e a [operação de produção](docs/production-operations.md), incluindo backup/restauração e o que ainda depende de implantação externa.

### Experimento rápido

1. Entre e abra o template **Entre duas redes**.
2. Envie ping de PC-01 a 192.168.20.10; clique em Executar.
3. Clique em eventos ARP/IPv4 para examinar cabeçalhos e decisões.
4. No terminal de R-EDGE-01:

```text
enable
configure terminal
interface Gi0/2
shutdown
```

5. Repita o ping: deve falhar. Use `no shutdown` e repita: deve voltar.
6. Salve e reabra. Fila, relógio, tabelas e configurações são preservados.

### Experimento DHCP relay

1. Abra **Um servidor, duas redes** e avance os eventos. PC-01 recebe a reserva 192.168.10.60; PC-02 recebe 192.168.10.50.
2. Em **R-EDGE-01 → DHCP**, configure os servidores do relay em Gi0/1. Em **DHCP-CENTRAL → DHCP**, edite o pool remoto e as reservas por MAC.
3. Inspecione um evento **DHCP_RELAY_REPLY**: giaddr identifica a rede dos clientes; os datagramas entre relay/servidor usam UDP 67 → 67.
4. No cliente, teste ping/HTTP para 192.168.20.10 e libere/renove a concessão. T1 e release seguem roteamento unicast; T2 usa relay.
5. Salve/reabra durante a troca para preservar pacotes e temporizadores. Remova o helper ou uma rota de retorno para observar falhas reais.

### Experimento DHCP

1. Abra o template **Endereços automáticos**. DHCP-01 possui IPv4 estático e um pool configurado; os PCs começam sem endereço.
2. Em cada PC, abra **Portas**, selecione Eth0 e marque **Automático (DHCP)**. Aplique a configuração.
3. Use **Próximo evento** ou Execute para acompanhar Discover, Offer, Request e ACK. O intervalo começa em 192.168.50.10 e exclui 192.168.50.11.
4. Na aba **DHCP**, consulte concessões e opções. Faça ping entre os clientes usando os endereços recebidos.
5. Desative o serviço DHCP no servidor e avance os eventos: T1 tenta renovação, T2 usa broadcast e a expiração remove a configuração. Reative o serviço e solicite uma nova concessão.
6. Salve e reabra: pools, leases e temporizadores são preservados. A passagem do tempo real com o laboratório fechado não consome o lease virtual.

### Experimento DNS

1. Abra **Nomes na rede**. O template executou DHCP até 100 ms virtuais e deixou os dois clientes com endereços e servidor DNS configurados.
2. Selecione PC-01, abra **DNS** e consulte `web.lab`. Avance os eventos para observar ARP, UDP/53 e a cadeia CNAME/A.
3. Repita a consulta: a resposta vem do cache enquanto o TTL virtual estiver válido. Consulte `server.lab` como AAAA para obter um endereço IPv6 como dado DNS. O transporte DNS permanece em IPv4; a aba IPv6 permite ICMPv6.
4. No terminal, execute `nslookup web.lab` ou `ping web.lab`. O ping só é enviado depois da resolução A.
5. Desative o serviço em DNS-01, limpe o cache do cliente e consulte novamente. Observe o timeout; reative o serviço para recuperar a resolução.
6. Registros, consultas pendentes e cache são preservados ao salvar e reabrir.

### Experimento STP/RSTP

1. Abra **Redundância sem loops**. O template executou RSTP até a convergência inicial de três switches e dois PCs.
2. Selecione SW-03 e abra **STP**: Gi0/2 é root port; Gi0/3 é alternate/discarding. O cabo redundante aparece tracejado, com indicação de STP.
3. Faça ping de PC-01 para 192.168.10.20. No terminal de SW-03, execute `enable`, `configure terminal`, `interface Gi0/2` e `shutdown`.
4. Avance os eventos: Gi0/3 assume o caminho até a raiz. O ping deve continuar funcionando. Desligar também Gi0/3 isola o destino; `no shutdown` restaura o caminho.
5. Clique em eventos BPDU para inspecionar IDs, custo, idade e proposta/acordo. Salve e reabra para retomar a árvore e os timers.
6. Para comparar com STP clássico, selecione STP no painel de cada switch. Portas não-edge passam por discarding e learning antes de forwarding.

## Validação

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm audit --audit-level=high
```

No Windows, E2E usa Edge; em Linux usa Chromium (`npx playwright install --with-deps chromium`). É possível definir `E2E_BROWSER_CHANNEL`.
A suíte de API usa PostgreSQL WASM em memória por padrão; `TEST_DATABASE_URL` aponta para um PostgreSQL de teste dedicado. A CI executa a suíte com PostgreSQL servidor.

## Produção

Para Railway, siga [o guia de implantação](docs/railway.md). A configuração oficial de infraestrutura está em `.railway/railway.ts` e aponta para `matheuscoutinhoo/shNet`. O Dockerfile publica API e frontend na mesma origem, com PostgreSQL separado.

`npm run build` gera a SPA; `npm start` a serve junto à API. Defina `NODE_ENV=production`, `DATABASE_URL` e origem HTTPS. No Railway, a origem pode vir de `RAILWAY_PUBLIC_DOMAIN`. E-mail é opcional: produção inicia sem provedor e permite cadastro/login diretamente (`MAIL_PROVIDER=none`). Recuperação e confirmação por e-mail ficam ocultas nesse modo; os endereços não são marcados como verificados. Para habilitar esses recursos, configure SMTP acessível, com TLS e remetente (`MAIL_PROVIDER=smtp`, `SMTP_HOST`, `MAIL_FROM`; veja [Railway](docs/railway.md)). Aplique migrations separadamente antes de iniciar. Termine HTTPS no proxy e use a mesma origem para UI/API/WebSocket. Configure `TRUSTED_PROXY_CIDRS` somente para peers verificados. Cookie Secure é obrigatório em produção.

A API compartilha rate limits e notificações privadas em PostgreSQL; duas instâncias foram verificadas no banco servidor local. LISTEN/NOTIFY não é uma fila durável. As métricas dos equipamentos representam recursos do modelo, enquanto `/api/metrics` oferece observabilidade do servidor. Publicação e serviços externos permanecem sujeitos à validação no ambiente de implantação.

## Escopo transparente

O motor cobre os protocolos, equipamentos e serviços descritos acima como modelos educacionais, com persistência e tráfego pela topologia. **O prompt integral não está concluído**: contas avançadas, compartilhamento, colaboração simultânea e publicação externa permanecem pendentes. Não há acesso à Internet real nem emulação de firmware. Traceroute usa oito probes ICMP, sem UDP. Os codecs binários e a captura têm um subconjunto explícito; veja a [matriz de cobertura](docs/requirements-coverage.md) e o [ADR-035](docs/adr/035-transport-extensions-relay-captures.md).

STP/RSTP, PVST por VLAN e MSTP por instâncias usam BPDUs e convergência no motor. A negociação rápida em links full-duplex é simplificada; não há todas as máquinas IEEE, papéis backup ou certificação de bridges reais. Os limites estão em docs/protocols.md.

DHCPv4 oferece relay de um salto, reservas, sondagem ARP de conflitos, DECLINE/quarentena e DHCP snooping. DHCPv6 oferece IA_NA/IA_PD, renovação/rebinding, release, DECLINE e até oito relays; RA fornece o gateway. DNS usa registros locais por IPv4/IPv6, UDP/TCP, EDNS e DNSSEC com âncoras explícitas e provas próprias do modelo. Recursão externa e Option 82 permanecem fora do subconjunto. O transporte usa a rede simulada; não abre sockets reais.

Autenticação inclui os fluxos de e-mail/senha, edição de nome, exclusão de conta e painel de sessões. Edição de e-mail, OAuth/SSO e administração de usuários não estão implementados. A revogação automática no logout e nas alterações de senha está implementada.

Contas/sessões e progresso exigem as migrations 002 e 003. Execute `npm run db:migrate` no banco servidor antes de iniciar a versão atual; o modo local embarcado aplica migrations no startup. Consulte [políticas e labs](docs/policies-and-labs.md).

Veja [arquitetura](docs/architecture.md), [protocolos e limites](docs/protocols.md), [segurança](docs/security.md), [testes](docs/testing.md) e [roadmap](docs/roadmap.md).

O template **Três sistemas autônomos** demonstra BGP. A aba **BGP** mostra vizinhos, AS_PATH e a rota escolhida. Altere LOCAL_PREF ou desligue a interface direta de R-01 para observar o caminho via outro AS. Configuração e limites em [ADR-017](docs/adr/017-bgp-over-simulated-tcp.md).

Os templates **Um trunk, duas redes**, **VLANs com gateway no switch** e **Mesmo endereço, redes separadas** demonstram subinterfaces, SVIs, roteamento L3 e VRF. A aba **VLAN / VRF** configura as tabelas; **Portas** configura endereços. [ADR-018](docs/adr/018-vlan-routing-and-vrf.md) registra funcionamento e limites.

**Gateway atento ao uplink** acrescenta tracking VRRP. O painel **VRRP** edita interfaces/rotas rastreadas; a prioridade efetiva muda com a disponibilidade local. [ADR-019](docs/adr/019-vrrp-tracking.md).

**Dois cabos, um enlace** demonstra LACP/EtherChannel. A aba **LACP** configura membros, modo e min-links. Desligue um membro e observe HTTP pelo restante; STP atua em Port-channel. [ADR-020](docs/adr/020-lacp-etherchannel.md).

**Endereços que chegam pela rede** demonstra IPv6, DAD, SLAAC e RA. Inicie a simulação, copie o endereço de PC-V6-B e envie ping de PC-V6-A pela aba **IPv6**. Hop Limit 1 retorna Time Exceeded. Rotas, NDP e ACL têm configuração no painel e CLI. [ADR-021](docs/adr/021-ipv6-ndp-slaac.md).

**Do rádio à resposta HTTP** entrega AP/cliente, associação, WPA2/WPA3 conceituais, sinal, canais e interferência. A aba **Wireless** configura o rádio; IPv4/DHCP/IPv6 usam Wlan0. Há HTTP real do modelo pela bridge do AP. Limites em [ADR-022](docs/adr/022-wireless-association-radio.md).

**Duas LANs por uma VPN** e **A aplicação escolhe o caminho** demonstram túneis sobre underlay, transporte de HTTP e políticas SD-WAN. As abas **VPN / SD-WAN** e **Controller WAN** configuram peers, selectors, preferência e SLA. Internet/MPLS/LTE são classes de transporte. [ADR-023](docs/adr/023-vpn-sdwan-underlay.md).

**Quem passa primeiro na fila** demonstra shaping, classes DSCP, prioridade/WRR, policer e congestionamento. **O pacote segue os labels** demonstra FEC/LFIB e MPLS com push/swap/pop. A aba **QoS / MPLS** configura ambos; a timeline inspeciona espera e labels. [ADR-024](docs/adr/024-qos-mpls-forwarding.md).

O template **Campus com autenticação empresarial** conecta cliente, AP, RADIUS e HTTP, com certificados locais para exercício. Na aba **WLC / Mesh / IDS**, selecione Cliente EAP para revisar a confiança e o certificado antes de avançar os eventos. Os botões **Desafio** e **Tutorial** abrem os recursos de aprendizagem; a pontuação aparece ao voltar ao dashboard. Limites de protocolo estão nos [ADRs 029–034](docs/network-implementation.md).
