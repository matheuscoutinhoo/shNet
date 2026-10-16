# ADR-056 — syslog padrão e citações ICMP fiéis

Data: 15/10/2026. Contrato `2026.10.15.8`, aprovado nos cinco gates da [CI 38833573812](https://github.com/matheuscoutinhoo/shNet/actions/runs/38833573812): 936 testes de regressão e 136 cenários de navegador aprovados, sem falhas ou instabilidade. Incremento de R19, no escopo de simulação de comportamento para estudo.

## Decisão

O syslog IPv4 usa o formato da [RFC 5424](https://www.rfc-editor.org/rfc/rfc5424.html), com PRI derivado de facility/severity, hostname, aplicação e mensagem UTF-8 com BOM. O relógio do modelo representa tempo virtual decorrido, sem calendário UTC; por isso TIMESTAMP é NILVALUE. PROCID, MSGID e structured-data também são NILVALUE, pois não existem no modelo. O identificador interno e o instante virtual permanecem nos eventos, no manifesto e no snapshot. Não são inventados campos de processo ou data de produção.

Cada mensagem ocupa um datagrama UDP/514, conforme o perfil da [RFC 5426](https://www.rfc-editor.org/rfc/rfc5426.html). O tamanho usado pelo motor é calculado pelos bytes do cabeçalho/BOM/texto, substituindo a estimativa pelo JSON interno. O remetente rejeita Unicode inválido antes de agendar a transmissão; o decoder verifica PRI, versão, limites e UTF-8 e preserva bytes sem BOM sem presumir sua codificação. O decoder cobre o perfil nativo sem timestamp UTC ou structured-data; RFC 3164, TLS e transporte TCP não fazem parte desta entrega.

O comportamento continua unidirecional: registrar envio não comprova recebimento. Rota, PAT, ACL, filtro de severidade, perda de enlace e coletor desabilitado determinam se a entrada chega. Não há retransmissão automática de syslog/UDP. O PCAP pode conter o envio de uma mensagem ausente no coletor, que é evidência útil para o estudo.

## Correção de ICMP encontrada na validação

O Wireshark identificou comprimento UDP zero nas citações exportadas em erros ICMP. O codec anterior sintetizava oito bytes de transporte e um comprimento IPv4 incompatível com o datagrama original. O motor agora conserva somente os 28 bytes do cabeçalho IPv4 e dos primeiros oito bytes de transporte quando consegue codificar o pacote original. Não inclui o payload inteiro no estado da citação.

O exportador preserva comprimento, DSCP/DF, identificação e campos originais. Se NAT modifica endereços, portas, sequência TCP ou identificador ICMP, atualiza os campos citados e o checksum IPv4. Para UDP e echo ICMP, ajusta o checksum de transporte pela atualização incremental da [RFC 1624](https://www.rfc-editor.org/rfc/rfc1624.html). Checksum UDP desabilitado permanece zero. O payload citado pode estar truncado legitimamente, mas seu cabeçalho declara o comprimento original.

Snapshots antigos permanecem aceitos: o campo `wireHeader` é opcional, e a validação de gerenciamento reconhece tamanhos antigos e atuais. Citações sem cabeçalho original e syslog cujo tamanho legado não corresponde ao formato padrão são omitidos do PCAP com motivo explícito. Não são preenchidos com conteúdo ou comprimentos inventados. A simulação e a retomada dos snapshots continuam disponíveis.

## Aceite e limites

Os testes comparam citações traduzidas UDP/TCP/ICMP com recálculo completo dos cabeçalhos. Cobrem BOM inicial no texto, Unicode, cabeçalhos malformados, checksums, comprimentos, legado, PAT, ACL, perdas, filtro, coletor indisponível e restore determinístico. O navegador salva/reabre o laboratório, confere o coletor e baixa o PCAP em mobile nos dois temas.

`scripts/verify-syslog-captures.ts` gera topologia, captura e manifesto com campos originais. O verificador Python usa Scapy para conferir bytes, texto e checksums, incluindo as citações ICMP após PAT; TShark confere os campos disponíveis, a quantidade de registros e a ausência de pacotes malformados. Ambos são obrigatórios na CI. [Evidências](../../artifacts/syslog-captures-2026-10-15/VALIDACAO.md).

O relatório identifica a versão e os campos consultados do Wireshark. As versões 4.2 da CI e 4.6 local conferem facility/severity, versão, hostname e aplicação. O campo adicional `syslog.msg.nonconformant` existe na versão local e é consultado apenas quando disponível. A conferência estrita do cabeçalho completo e do UTF-8 é feita diretamente nos bytes em todas as versões. Campos inexistentes não são tratados como erro do pacote nem como uma validação executada.

R19 continua parcial. Os demais codecs, HA de serviços, fabric e gestão segura mantêm os aceites próprios no plano consolidado. Esta entrega não implementa emulação, firmware ou sockets externos.
