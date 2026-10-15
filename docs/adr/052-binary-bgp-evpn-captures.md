# ADR-052 — BGP/EVPN binário e captura independente

Data: 15/10/2026. Contrato `2026.10.15.4`; incremento binário de R19 qualificado nos cinco gates da [CI 38771544113](https://github.com/matheuscoutinhoo/shNet/actions/runs/38771544113), com 891 testes e 128 cenários de navegador aprovados.

## Transporte e captura

Novas sessões BGP usam octetos no TCP/179, incluindo marker de 16 bytes, comprimento e tipo. OPEN negocia AS de quatro octetos e, quando habilitado, MP-BGP AFI 25/SAFI 70. UPDATE IPv4 transporta ORIGIN, AS_SEQUENCE, NEXT_HOP, MED, LOCAL_PREF em iBGP e atributos de reflexão. KEEPALIVE e NOTIFICATION também são binários. O limite é 4096 octetos por mensagem; o lote completo precisa caber no buffer TCP antes de ser considerado anunciado.

Rotas com atributos diferentes recebem UPDATEs separados. O parser aguarda mensagens segmentadas, consome mensagens concatenadas e recusa marker, comprimentos, atributos, capacidades e NLRIs inválidos. A contagem TCP considera octetos, incluindo valores acima de 127. Buffers, sequências e timers permanecem serializáveis.

Sessões antigas sem `encoding: binary` continuam com JSON/newline e são explicitamente excluídas do PCAP. Não há conversão posterior que altere comprimentos ou sequências da captura. A inspeção de PDU mostra mensagens completas e bytes hexadecimais; segmentos parciais continuam identificados como fragmentos.

## EVPN suportado

O codec cobre rotas MAC/IP tipo 2 e IMET tipo 3, com Route Target, MAC Mobility, encapsulamento VXLAN e PMSI ingress replication. O modelo usa VNIs globais: Ethernet Tag igual ao VNI, RD tipo 1 `VTEP:0`, ESI zero e campo de VNI com todos os 24 bits. É o subconjunto de bundle com VNIs globais descrito na [RFC 8365, seção 5.1.3](https://www.rfc-editor.org/rfc/rfc8365#section-5.1.3).

Uma retirada MAC/IP usa o NLRI anteriormente anunciado, incluindo seu IP. Mudar o IP da mesma MAC retira o NLRI antigo antes de publicar o novo. Retiradas IMET contêm sua identidade VNI/VTEP; não precisam transportar RT/AS_PATH. O receptor remove pelo peer e pela identidade do NLRI, preservando os outros membros.

RT usa ASN de 16 bits/local de 32 bits ou ASN de 32 bits/local de 16 bits. Combinações que não cabem nesses formatos são recusadas antes de configurar o VNI. A sequência de mobilidade é limitada a 32 bits e satura no máximo; o simulador não promete ordenação de novas mobilidades após esse esgotamento.

## Verificação e limites

Vetores fixos, casos inválidos e ensaios reais verificam AS32, reflexão, retirada, reconvergência, mobilidade, restauração, legado e segmentação TCP. Os testes geram capturas BGP/EVPN; `scripts/verify-bgp-captures.py` usa Scapy para recomputar checksums e TShark/Wireshark para decodificar capacidades, atributos, MAC/IP, IMET e retiradas. A CI exige essa validação independente e publica os PCAPs e o relatório. Os resultados ficam em [evidências R19](../../artifacts/bgp-evpn-codecs-2026-10-15/VALIDACAO.md).

O codec é um subconjunto deliberado: exige AS4 nas novas sessões binárias, IPv4 unicast e EVPN IPv4 com um RT por anúncio. Não aceita AS_SET/confederações, ESI/DF, Type 5, VNI local, next-hop IPv6 ou RD arbitrário. Esses recursos pertencem às ampliações R18. Não há conexão BGP com roteadores externos; a interoperabilidade demonstrada é a decodificação da captura. Codecs de outras aplicações e gestão continuam pendentes; a captura universal P-PCAP permanece adiada e todas as omissões continuam visíveis.

Referências do formato: [BGP-4 / RFC 4271](https://www.rfc-editor.org/rfc/rfc4271), [AS4 / RFC 6793](https://www.rfc-editor.org/rfc/rfc6793), [MP-BGP / RFC 4760](https://www.rfc-editor.org/rfc/rfc4760), [EVPN / RFC 7432](https://www.rfc-editor.org/rfc/rfc7432), [PMSI / RFC 6514](https://www.rfc-editor.org/rfc/rfc6514).
