# DHCPv4 binário — 15/10/2026

Contrato `2026.10.15.7`, incremento de R19. Qualificação completa e publicação em andamento. [Decisão, compatibilidade e limites](../../docs/adr/055-binary-dhcpv4-captures.md).

Três cenários reproduzíveis por `npx tsx scripts/verify-dhcp-captures.ts`: [conflito/DORA/DECLINE/NAK/RELEASE](local.shlab.json), [renovação e troca de servidor](failover.shlab.json) e [relay roteado](relay.shlab.json). As capturas [local](local.pcap), [failover](failover.pcap) e [relay](relay.pcap) têm 207 registros retidos, sem omissões ou descarte. O [manifesto](captures.json) associa cada registro aos campos originais do modelo e à fonte do motor.

A [validação independente](independent-captures.json), produzida por `python scripts/verify-dhcp-captures.py`, confirma os sete tipos, campos BOOTP, opções, tamanhos e 126 checksums IPv4/126 UDP com Scapy. TShark reconhece todos os 126 registros DHCP, sem frames malformados. Os registros restantes são ARP. A renovação unicast é realizada com o primário disponível; após a promoção, T2 encontra o reserva. Contagem inclui o mesmo datagrama observado em enlaces diferentes.

As capturas representam o tráfego cliente/servidor da rede simulada. O canal de réplica não possui codec e permanece fora desse escopo. IDs opacos legados, leases fracionários em segundos e mensagens sem representação fiel são listados como omissões. A captura universal P-PCAP e os demais protocolos pendentes não são declarados concluídos.
