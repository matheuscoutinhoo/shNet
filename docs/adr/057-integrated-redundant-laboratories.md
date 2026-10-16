# ADR-057 — disponibilidade integrada e persistência após falhas físicas

Data: 16/10/2026. Contrato `2026.10.15.9`, aprovado nos cinco gates da [CI 38895733044](https://github.com/matheuscoutinhoo/shNet/actions/runs/38895733044): 949 testes de regressão e 140 cenários de navegador aprovados. Snapshot 1 e migration 011 preservados. [Evidências](../../artifacts/resilient-laboratories-2026-10-15/VALIDACAO.md).

## Modelos

O catálogo acrescenta **Enterprise com acesso, WAN e DC A/B** (37 equipamentos, cinco VLANs) e **Fábrica com acesso, WAN e DC A/B** (53 equipamentos, oito VLANs e três células). Os modelos históricos de fábrica e fabric EVPN permanecem disponíveis; seus ensaios e limites continuam próprios.

Cada segmento possui dois switches de acesso, ligados a cores diferentes. Os cores usam RSTP e dois cabos com LACP. Hosts, servidores, PLCs, HMIs, SCADAs e MES têm duas NICs em bond ativo/reserva, monitor ARP de 1 s com timeout de 3 s e alimentação por duas UPS. Cada switch/roteador pertence a um lado e recebe sua própria fonte. O rack registra a montagem dos equipamentos de infraestrutura; os endpoints recebem ambas as fontes sem fingir estar montados em dois racks.

Dois firewalls fornecem os gateways de todas as VLANs e um VIP de trânsito, com réplica de estado por cabo dedicado. Dois gateways WAN fornecem VIPs no trânsito e na rede externa; dois DC-GWs fazem o mesmo na rede do datacenter. Tracking observa a outra interface de cada gateway, para que a perda de apenas um lado não deixe o caminho de retorno preso ao gateway isolado. VRRP usa anúncios de 250 ms nestes modelos. O datacenter é roteado; não representa multihoming EVPN/ESI.

DNS/HTTP, NTP e syslog atendem no VIP `10.70.30.100`. Os dois servidores têm conteúdo equivalente configurado; logs e conexões continuam locais. DHCP tem dois servidores, réplica confirmada, dois relays com giaddr alternativo e promoção administrativa com fencing, conforme ADR-054. A fábrica acrescenta processo PLC nas três células, scans HMI/SCADA por Modbus e um MES na rede corporativa.

## Ensaios e critérios

Cada modelo oferece 13 presets: baseline, perda do core, acesso de usuários, firewall, gateway WAN, DC-GW, acesso WAN, acesso DC, instância de serviço, UPS e rack A, além de uplink rompido com carrier do host preservado e perda/retorno do core A. Perda de rack desliga explicitamente seus equipamentos e sua UPS; não atribui efeitos físicos a uma estrutura passiva.

Os ensaios usam 12 s de aquecimento, janela de 16 s, amostras a cada 1 s e deadline de 800 ms. Baseline exige zero perda. Falhas admitem até 40% de perda, com resposta na última amostra: isso permite até seis perdas nas 16 tentativas e não representa failover instantâneo. NTP tem tolerância de 20 ms. O relatório conserva latências, amostras e recuperação medida; essa tolerância não certifica um SLA externo. As sete estações de supervisão/MES também precisam estar sem alarme de comunicação aos 14 s do cenário de fábrica.

O baseline exige descarte Guest→serviços com evidência de política em todas as amostras. Durante a convergência, um gateway ausente não prova isolamento. Por isso `verify-resilient-laboratories.ts` executa um ensaio separado de bloqueio após cada recuperação, mantendo a exigência de regra correlacionada. Os 26 ensaios de disponibilidade e 26 de isolamento são obrigatórios na CI; os relatórios e topologias importáveis incluem contrato e hash da fonte.

Os testes de regressão verificam a **mesma conexão TCP** antes/depois/retorno do FW, WAN-GW e DC-GW, além de DHCP via relay alternativo, T2 após fencing, réplica no retorno, restore determinístico e interrupção ao perder os dois cores. Isso não transfere uma sessão de aplicação entre servidores: a conexão atravessa gateways alternativos e chega ao mesmo endpoint.

## Defeitos corrigidos

Mudar energia, porta, cabo, PoE ou infraestrutura atualizava apenas bonds em alguns caminhos públicos. O conjunto `selected` do LACP podia permanecer incompatível com o carrier; salvar imediatamente produzia um snapshot recusado na reabertura. As mutações agora atualizam os protocolos físicos, STP, VRRP e BGP antes de devolver o controle, usando a rotina existente de atualização. Não é necessário avançar um timer para tornar o snapshot válido. Testes cobrem desligamento, porta, remoção de cabo/equipamento e restauração; o navegador salva imediatamente após desligar o core e reabre nos dois temas.

A remoção de equipamento atualiza os protocolos ao final do lote de cabos, evitando que a descoberta de rádio recrie um enlace antes da exclusão do AP. A regressão verifica ausência de referências órfãs e snapshot válido imediatamente após a remoção.

`requireFinalSuccess` era aplicado a deny como se exigisse uma resposta permitida na última amostra. Isso reprovava bloqueios corretos. A partir deste contrato, allow mantém a exigência de resposta final; deny continua exigindo ausência de resposta e, quando solicitado, evidência de política **em todas** as amostras, incluindo a última. Executor e validador concordam. Relatórios de contratos anteriores conservam sua regra histórica; falsificar timeout como bloqueio continua recusado.

## Saldo

R10 conclui as variantes de acesso/endpoint/energia no escopo de simulação IP contratado após qualificação. R08 entrega aqui caminhos WAN/DC-GW e integração dos modelos, mas continua parcial: falta replicar dados/logs/sessões dos demais serviços e implementar quorum/eleição automática com proteção contra partição. O próprio endpoint/PLC e os servidores externos/DC ainda são únicos; perda dessas instâncias ou das duas vias interrompe o serviço, explicitamente. Não há firmware, emulação, PTP/TSN, MRP/DLR/PRP/HSR, RF certificado nem captura universal; R18/R19/R20/R25 conservam seus aceites.
