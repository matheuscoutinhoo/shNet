# Roadmap rastreável ao prompt

## Entregue nesta fase

MVP 1 (seções 72/87): autenticação, projetos, canvas, PC/switch/router/server, cabos/interfaces, Ethernet/MAC, ARP, IPv4/ICMP, VLAN access/trunk, static routes, CLI, ping, animação, eventos, save/load. Também import/export, favoritos, snapshots, packet inspector e template de troubleshooting.

Primeira fatia do MVP 2: UDP e DHCPv4 DORA, pools, exclusões, opções de gateway/DNS, renovação T1/T2, expiração, NAK, release, CLI e painel de concessões. Template "Endereços automáticos", persistência validada e E2E desktop/mobile. Limites de fidelidade estão em protocols.md.

DHCP ampliado com relay de um salto, pools remotos selecionados por giaddr, reservas por MAC e T1/release roteados. O template **Um servidor, duas redes** inclui DNS/HTTP para validar a concessão. ARP agora compartilha filas por interface/próximo salto, transmite até três requests com intervalo de 1 s e preserva sua resolução ao salvar/reabrir.

DNS também foi entregue: registros A/AAAA/CNAME, consultas UDP/53, nslookup, ping por nome, cache TTL, timeout, servidor alternativo, CLI, painel e persistência. O template "Nomes na rede" utiliza opções DNS recebidas por DHCP.

STP/RSTP entregue como árvore comum: BPDUs, prioridade/custo, estados de porta, negociação rápida, fallback temporizado, template de redundância, CLI, painel, inspeção de BPDUs e save/reload. A preparação Railway inclui Dockerfile, IaC oficial, Resend HTTPS e testes de configuração; publicação remota e operação real seguem sujeitas à revisão.

## Próximas fases

Entregues também: conta/sessões/exclusão, ACL/NAT/PAT ICMP/UDP/TCP, firewall de trânsito TCP/UDP/Echo com zonas e ICMP relacionado, serviços echo/HTTP e painel de conexões, labs avaliados e progresso, notas/regiões/grupos, snap/viewport e inspetor global/caminho/OSI. O estado completo do prompt está em [requirements-coverage.md](requirements-coverage.md). O produto integral continua pendente.

1. TCP com janela deslizante, congestionamento, RTO adaptativo, SACK/ECN/timestamps e PMTUD entregue, além dos serviços de aplicação. DNS sobre TCP e fallback TC=1 foram entregues. O bloco TCP/ACL/NAT/firewall de trânsito possui CLI, UI, persistência e testes.
2. MVP 3 entregue no escopo educacional: Wi-Fi, inspeção HTTP/DNS, VPN/SD-WAN, SNMP/syslog, automação, telemetria e NTP. SNMP GET/GETNEXT e syslog UDP foram entregues com CLI, painel, template e persistência. OSPF (adjacências/LSDB/SPF, DR/BDR e áreas) e RIPv2 foram entregues como modelos educacionais, com CLI, painéis, templates e persistência.
3. Avançado entregue no escopo educacional: BGP IPv4, VRF, SVI/subinterfaces, LACP, tracking VRRP, SD-WAN, QoS/MPLS, ICMPv6/NDP/SLAAC, 802.1X/AAA, VXLAN/EVPN, automação, NETCONF/RESTCONF e telemetria. Catálogo extensível com 47 perfis, DAC/QSFP, visões especializadas e 17 desafios avançados entregues. Os ADRs 017–028 registram os subconjuntos e as especializações ainda não modeladas.
4. Desenho livre, comentários ancorados e histórico privado entregues. Compartilhamento seguro permanece pendente.
5. Worker, índices e renderização por viewport entregues; benchmarks e fluxo de navegador com 2000 equipamentos verificados. A fila usa inserção ordenada e limites explícitos.
6. PostgreSQL compartilha rate limits e notificações privadas da API. Colaboração com engine autoritativo e comandos versionados no servidor permanece pendente.

Autenticação permanece deliberadamente simples; gestão administrativa e papéis não fazem parte do pedido ajustado.

PostgreSQL servidor local foi verificado com múltiplas instâncias, backup criptografado e restauração. Deploy real, entrega externa de e-mail/alertas, certificado do domínio e armazenamento externo continuam pendentes de acesso ao ambiente. Compose/CI e observabilidade estão preparados em production-operations.md. O andamento atual está em product-completion.md.
