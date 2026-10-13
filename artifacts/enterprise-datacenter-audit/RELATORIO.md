# Auditoria enterprise e datacenter — 13/10/2026

**O simulador atende os fluxos básicos ensaiados, mas ainda não comprova uma rede enterprise/datacenter completa com continuidade e segurança dual stack.** Foram registrados 15 achados, incluindo três bugs reproduzíveis: métricas de recuperação incoerentes aceitas pela API, contraste dos rótulos e reinicialização RSTP ao editar uma porta desconectada. As demais entradas distinguem configuração, limite de fidelidade e melhoria de produto.

## Método e cobertura

Base de código auditada: main, commit 3d35c2e1e4e59a382c9d319eac6dc97311a55de5. Execução local e conta sintética, sem tráfego em rede real. [Snapshot importável](enterprise-datacenter.shlab.json), [inventário](inventory.json) e scripts no diretório scripts do repositório. A API importou a topologia; a interface a executou, salvou o laboratório e reabriu o histórico persistido.

Topologia integrada: **38 equipamentos, 46 enlaces**, cinco VLANs de campus, dois cores, dois firewalls VRRP, RSTP/LACP, usuários/visitantes/DMZ/corporativo/gerência, RADIUS/EAP-TLS, DNS/DHCP/NTP/syslog e WAN simulada. Datacenter com dois spines, três leaves, dois VNIs, tenants com IPs sobrepostos, EVPN/BGP, dois backends, LB e UPS. LB, DC-GW e WAN únicos e pool DHCP apenas do relay primário são condições deliberadas de ensaio, não desenhos aprovados para produção.

**73 casos no motor: 59 expectativas atendidas e 14 divergências.** Divergência não equivale a bug: alguns casos exigem capacidade ausente ou continuidade não provisionada. [Matriz campus/fabric](scenario-results.json), [protocolos/segurança](protocol-results.json), [diagnóstico](diagnostics.json). Testes complementares usaram templates OSPF/BGP/VPN/SD-WAN/VRF e a topologia integrada.

Na aplicação, cinco fluxos × seis amostras passaram: usuário→ERP, visitante bloqueado, tenant A→APP-1, campus→VIP DC e Wi-Fi empresarial→ERP. Relatório salvo e reaberto; zero pageerrors e zero respostas de erro dos endpoints de projetos no roteiro positivo. Desktop 1600×1100 e mobile 390×844; bodyWidth=390 e relatório width/scrollWidth=350/350. Axe encontrou 30 elementos com contraste insuficiente no canvas claro; modal e relatório móvel sem violações detectadas. [Resultados UI](ui-results.json), [captura desktop](screenshots/desktop.png), [relatório](screenshots/scenario-report.png), [mobile](screenshots/mobile.png).

Realtime 5×: razão virtual/real solicitada 92.7% em uma janela de 11.8 s; sem inferência de SLA para outros computadores. Nos perfis 38/62/86, todos os 75 pings chegaram. Captura descartou 0/487/2642 frames por limite de retenção; isso não é perda de pacote. [Escala](scale-results.json).

Regressão existente: **677 aprovados, 0 falhas, 1 ignorado, 72 arquivos**. O ignorado depende de PostgreSQL externo. [Resultado bruto](regression-tests.json). Testes de auditoria são independentes da suíte Vitest e das suas contagens.

## Achados

### ED01 · P0 · Política de zonas IPv4 não protege IPv6

Tipo: Lacuna de segurança. Evidência: P-DUALSTACK-ZONES, P-DUALSTACK-HTTP, P-DUALSTACK-ACL.

GUEST→ERP é negado em IPv4, mas ping e HTTP IPv6 chegam. ACL IPv6 explícita bloqueia o ping.

Causa/limite: Pipeline IPv6 usa ACL própria e não consulta o firewall por zonas. A matriz de fidelidade não explicita essa diferença. Correção/implementação: R01.

### ED02 · P0 · Relatório aceita recuperação incoerente com as amostras

Tipo: Bug. Evidência: P-REPORT-CONSISTENCY, api-results.json.

Recuperação original de 2072,426 ms/observedFailure=true substituída por 0/false; schema e API aceitam, HTTP 200, resultado persistido.

Causa/limite: O validador confere nomes/resolução, mas não recalcula recoveryMs/observedFailure. Não comprova execução independente no servidor. Correção/implementação: R02, R15.

### ED03 · P1 · Rótulos sem contraste em canvas claro com tema escuro

Tipo: Bug de interface. Evidência: ui-results.json, screenshots/desktop.png.

Axe: color-contrast serious em 30 elementos. Exemplos: texto #c5d8e5 sobre #ffffff, razão 1,46.

Causa/limite: Cores dos rótulos acompanham o tema da aplicação sem considerar o fundo escolhido para o canvas. Correção/implementação: R03.

### ED04 · P1 · Dois spines não garantem failover do VXLAN

Tipo: Limitação. Evidência: D11, D12, D13.

Perda SPINE-2 mantém HTTP; perda SPINE-1 interrompe; retorno recupera. Todos os leaves têm dois enlaces e rotas alternativas.

Causa/limite: VTEP ligado a p1; resolveUnderlay/sendVxlanFrame/receiveVxlan restringem o transporte à interface configurada. Rotas usam estado administrativo e não oferecem ECMP. Correção/implementação: R06, R18.

### ED05 · P1 · Route target divergente não isola peers estáticos no mesmo VNI

Tipo: Limitação e validação ausente. Evidência: D16, D17, P-PREFLIGHT-RT.

RIB importada fica vazia, mas HTTP continua por flooding/aprendizado de peers estáticos; preflight não alerta.

Causa/limite: RT controla importação de MACs no modelo. VNI e peers controlam o plano de dados. Não tratar RT sozinho como barreira de segurança. Correção/implementação: R07.

### ED06 · P1 · DHCP de backup depende de pool para seu giaddr

Tipo: Configuração e validação ausente. Evidência: E08, E14, P-DHCP-backup-pool, P-PREFLIGHT-DHCP.

Pool somente para 10.60.10.2 atende o primário e falha no backup .3, apesar de ambos terem relay. Pool adicional não sobreposto recupera a concessão.

Causa/limite: A regra atual de preflight detecta relay ausente, mas não confere cobertura dos pools por endereço do relay. Correção/implementação: R05, R08.

### ED07 · P2 · Avisos de IP duplicado não consideram o domínio L2/VNI

Tipo: Melhoria de análise. Evidência: D02, D03, D04, P-PREFLIGHT-TENANTS.

Dois avisos DUPLICATE_IP para endereços intencionalmente sobrepostos em VNIs isolados. Tráfego de cada tenant chega ao servidor correto.

Causa/limite: Heurística global por nome de VRF/IP não reconstrói domínios de broadcast e contexto do endpoint. Correção/implementação: R22.

### ED08 · P1 · Executor de cenários não aceita IPv6 nem seleção de VRF

Tipo: Recurso ausente. Evidência: U01, U02, P-VRF-BLUE, P-VRF-RED.

Schema recusa endereço IPv6 e campo vrf. O motor executa IPv6 e TCP nas duas VRFs separadamente.

Causa/limite: Cobertura automática inferior à capacidade do motor; cenários de segurança dual stack ficam fora do executor nativo. Correção/implementação: R11.

### ED09 · P2 · Nenhum preset enterprise/datacenter para a topologia completa

Tipo: Melhoria de produto. Evidência: ui-results.json, templates.ts.

Zero opções Modelo na topologia de 38 equipamentos. Executar cinco fluxos exige editar JSON; menu/modal ainda se chamam fábrica.

Causa/limite: Templates campus/EVPN existentes são demonstrações pequenas, sem matriz integrada de HA/segurança e assistente de cenários. Correção/implementação: R12, R21.

### ED10 · P1 · PCAP não inclui VXLAN e BGP interoperáveis

Tipo: Fidelidade parcial. Evidência: P-PCAP, diagnostics.json.

423 frames VXLAN e 32 BGP omitidos, além de 109 envelopes sem codec. Exportação informa as exclusões.

Causa/limite: Mensagens do overlay/controle usam envelopes didáticos. Não é um arquivo completo para validação externa de EVPN. Correção/implementação: R19.

### ED11 · P2 · Fabric de datacenter não implementa todos os recursos de produção

Tipo: Fidelidade parcial. Evidência: docs/adr/025-vxlan-evpn.md, ipv4.ts, vxlan.ts.

Inspeção confirma ausência de RR EVPN, ESI/DF, IMET, Type 5, proxy ARP e MAC/IP IPv6 no controle. Underlay/VRF dinâmico completo não está disponível.

Causa/limite: Limites documentados do modelo educacional, sem emulação de ASIC/firmware ou MP-BGP binário. Correção/implementação: R18, R19.

### ED12 · P1 · SPOFs e ausência de replicação de estado continuam

Tipo: Risco do desenho. Evidência: E18, E19, D07, D10, D19, D20, P-HA-EXISTING-TCP.

Switch de acesso, DNS, LB, gateway DC/WAN e serviços únicos não têm HA completo. Sessão echo recebia before|, permanece ESTABLISHED, mas after| não chega após failover; backup tem zero sessões.

Causa/limite: VRRP protege gateway e novas sessões; não replica firewall/NAT/estado de serviço. UPS única do LB não representa alimentação A/B. Correção/implementação: R08, R09, R10.

### ED13 · P2 · Carga de fabric esgota a retenção de captura

Tipo: Limite de evidência e desempenho. Evidência: scale-results.json, ui-results.json.

Perfis 38/62/86: 1/25/49 pings entregues; descartes da captura 0/487/2642. Realtime 5× acompanha aproximadamente 92,7% do ritmo solicitado nesta medição.

Causa/limite: Retenção de 2 MiB é deliberadamente limitada; descarte não é perda de pacote. Uma medição local não comprova escala de produção ou vazamento de memória. Correção/implementação: R23.

### ED14 · P1 · Editar edge de uma porta desconectada reinicializa o bridge

Tipo: Bug de convergência. Evidência: P-RSTP-PORT-EDIT, diagnostics.json.

ACCESS-USERS p20 muda forwarding→discarding ao editar p3 sem cabo. HTTP falha nos primeiros 5 s e volta após reconvergência.

Causa/limite: setSpanningTreePort chama rebuildSpanningTree e initialize no equipamento inteiro. DHCP snooping passou depois de aguardar essa convergência. Correção/implementação: R04.

### ED15 · P2 · Matriz de capacidades e documentação ainda divergem

Tipo: Documentação. Evidência: docs/protocols.md:63, fidelity.ts, ADR-018, ADR-025.

Texto afirma ausência de IP de gerência em switch L2 apesar da correção entregue. Matriz genérica não detalha IPv6 do firewall, VRFs, codecs EVPN ou underlay preso à porta.

Causa/limite: Atualização das entregas não foi refletida em todas as descrições e superfícies de produto. Correção/implementação: R26.


## Controles que passaram e diagnósticos descartados

Passaram segmentação IPv4, HTTP/DNS/DHCP baseline, EAP-TLS e certificado inválido, SNMP/credencial inválida, VRRP para novas conexões e retorno WAN VIP, perda de core/uplink/membro LACP, isolamento por VNI e VRF, mobilidade VM, MTU, health checks e recuperação de backend, UPS e snapshots serializados em convergência/tráfego pendente. OSPF/BGP e SD-WAN reconvergem nos templates ensaiados; VPN HTTP passou.

DHCP snooping bloqueou o servidor indevido e obteve lease legítimo após convergência. A aparente falha inicial vinha do reset RSTP provocado ao marcar a nova porta edge; não foi classificada como bug de snooping. Endereço/gateway/VLAN internos do AP foram corrigidos no roteiro antes do resultado final. Diferenças apenas de presença de chaves undefined foram descartadas por comparação do snapshot JSON serializado.

A API passou conflito de revisão (409), retry idêntico (200) e ausência de CSRF (403). Falhou a integridade da recuperação (aceitou 200, esperado 400). O projeto artificial foi removido após a reprodução. [Evidência API](api-results.json), [relatório original](recovery-report-original.json), [relatório adulterado, somente fixture negativa](recovery-report-tampered.json).

## Limites e pendências

O ensaio não certifica firmware, switches reais, ASIC, RF de campo, produção, sessões externas ou todos os recursos de um datacenter físico. Os modelos de protocolo e a captura têm limites documentados. Não há inferência de vazamento de memória a partir dos heap deltas; não houve soak test prolongado nem carga com milhares de VTEPs. PostgreSQL externo, implantação de produção e integrações reais permanecem não validados.

As correções de produto não foram implementadas nesta auditoria: o pedido desta etapa é testar e consolidar o plano. A configuração do laboratório e os roteiros foram ajustados para excluir falsos positivos. [Plano consolidado de correção/implementação](../../docs/consolidated-remediation-plan.md), [backlog JSON](consolidated-backlog.json), [backlog CSV](consolidated-backlog.csv).
