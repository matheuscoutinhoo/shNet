# Syslog e citações ICMP — 15/10/2026

Contrato `2026.10.15.8`, em qualificação. [Decisão e limites](../../docs/adr/056-syslog-and-original-icmp-quotations.md).

O [laboratório importável](syslog.shlab.json), [PCAP](syslog.pcap) e [manifesto](captures.json) são reproduzíveis por `npx tsx scripts/verify-syslog-captures.ts`. Exercitam PAT, severidade, ACL, perda de enlace, coletor indisponível, evento automático e retomada determinística. A captura tem 31 registros, sendo 19 syslog; apenas três mensagens chegam ao coletor. Mensagens filtradas não são transmitidas; as bloqueadas/perdidas não aparecem no coletor.

A [validação independente](independent-captures.json), produzida por `python scripts/verify-syslog-captures.py`, usa Scapy e TShark. Confere 23 checksums IPv4, 19 UDP, quatro ICMP e os quatro UDP citados após PAT. Nenhum registro malformado, omissão ou descarte no cenário. O teste revelou e motivou a correção das citações ICMP que antes exportavam comprimento UDP zero.

O formato usa TIMESTAMP NILVALUE porque o modelo possui relógio virtual, sem calendário UTC. IDs internos continuam no manifesto/snapshot, e o texto UTF-8 é preservado. Exportar um envio não atesta sua entrega. Capturas legadas que não possam representar os bytes originais são declaradas como omissões. A captura universal continua pendente.
