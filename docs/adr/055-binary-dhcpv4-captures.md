# ADR-055 — DHCPv4 binário e capturas verificáveis

Data: 15/10/2026. Contrato `2026.10.15.7`, aprovado nos cinco gates da [CI 38827552766](https://github.com/matheuscoutinhoo/shNet/actions/runs/38827552766): 926 testes de regressão e 134 cenários de navegador aprovados, sem falhas ou instabilidade. Incremento de R19, que permanece parcial.

## Decisão

Adicionar encoder/decoder BOOTP/DHCPv4 para os sete tipos nativos: DISCOVER, OFFER, REQUEST, DECLINE, ACK, NAK e RELEASE. A exportação Ethernet/VLAN/IPv4/UDP usa o codec e calcula checksums. O tamanho dos datagramas gerados pelo motor passa a refletir as opções e o padding reais, com payload mínimo de 300 bytes. Oito servidores DNS podem ultrapassar esse mínimo; o tamanho deixa de ser uma estimativa fixa.

O cabeçalho conserva xid, chaddr, ciaddr, yiaddr, giaddr e hops. O modelo não possui servidor de boot nem segundos decorridos no cabeçalho: siaddr e secs são zero. A identidade do servidor usa a opção 54. REQUEST inicial usa as opções 50/54 conforme o estado; renovação/rebinding usam ciaddr, sem essas opções. NAK usa ciaddr/yiaddr zero. Máscara, roteador, DNS e lease são codificados conforme a [RFC 2131](https://www.rfc-editor.org/rfc/rfc2131.html) e a [RFC 2132](https://www.rfc-editor.org/rfc/rfc2132.html). T1/T2 explícitos são emitidos quando ambos são segundos inteiros; nos demais leases inteiros, as opções são omitidas e valem os defaults de 1/2 e 7/8, iguais aos timers do modelo.

O decoder verifica limites de TLV, cookie, op/tipo, tamanhos das opções conhecidas, máscara contígua e listas IPv4. Reagrupa opções divididas, inclusive nas áreas file/sname de option overload, conforme a [RFC 3396](https://www.rfc-editor.org/rfc/rfc3396.html). Opções desconhecidas são preservadas. Portas UDP são verificadas, incluindo relay 67→67.

## Compatibilidade e exclusões

Os identificadores nativos `dhcp-N` são convertidos de forma injetiva para uint32. Identificadores opacos de snapshots legados, valores fora de uint32 e leases com frações de segundo continuam aceitos pela simulação, mas o PCAP declara sua omissão. Não há hash, truncamento ou arredondamento silencioso. Tamanhos históricos maiores podem ser preservados com padding; tamanhos insuficientes são recusados. O decoder retorna uma visão do protocolo, sem importar tráfego externo como estado confiável do motor.

Não há sockets DHCP externos, INFORM, opções de fabricante/client identifier/relay 82, autenticação DHCP ou protocolo de failover de fabricante. O canal de réplica de R08 continua um transporte de estado simulado separado; ele não integra a captura Ethernet. P-PCAP universal permanece adiado e os demais codecs de aplicação/gestão continuam em R19/R25.

## Validação

`tests/dhcp-codec.test.ts` cobre bytes conhecidos, tamanhos, checksums, VLAN, sete mensagens, renovação/relay, opções concatenadas/overload, entradas malformadas e exclusões explícitas. O teste E2E importa uma simulação concluída, salva/reabre e baixa o PCAP pela interface mobile nos dois temas, conferindo todos os tipos e oito DNS.

`scripts/verify-dhcp-captures.ts` gera três cenários importáveis e um manifesto com os campos originais do modelo. `scripts/verify-dhcp-captures.py` usa Scapy e TShark, independentemente do decoder TypeScript, e compara cabeçalhos, opções, quantidade, tamanhos e checksums. Exercita conflito/DECLINE, NAK, RELEASE, renovação unicast bem-sucedida antes da falha, rebinding depois da promoção e relay roteado em ambos os sentidos. Os três cenários não têm frames descartados, omissões ou pacotes malformados. Esses verificadores são obrigatórios na CI.

[Evidências e situação da qualificação](../../artifacts/dhcp-captures-2026-10-15/VALIDACAO.md).
