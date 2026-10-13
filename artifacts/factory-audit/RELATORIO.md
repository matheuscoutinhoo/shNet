# Auditoria de rede industrial no shLab

13/10/2026 · America/Sao_Paulo · shLab 0.1.0 · commit c4000c36626f0fd98a4711f129615a48c7daec24

A aplicação permitiu desenhar, configurar e simular uma rede IP representativa de fábrica. **O modelo é útil para conectividade, segmentação e experimentos didáticos; o ensaio não aprova a aplicação como validação integral de uma rede de automação industrial.** Os principais problemas são a velocidade de reprodução em redes com tráfego de controle, perda rápida de evidências, gerência incoerente de switch L2 com SVI e ausência de modelos industriais necessários.

Foram executados **42 experimentos de cenário**, **5 controles de inicialização/convergência de templates** e **50 testes existentes de regressão (50 passaram)**. A interface foi usada de fato para criar laboratório, importar desenho, executar ICMP/HTTP, inspecionar bloqueio de firewall, consultar terminal NetOS, salvar/exportar, recarregar/reabrir, criar/restaurar snapshot e verificar layout móvel. O motor complementou a interface com cenários repetíveis. Não se deve interpretar todos os experimentos como aprovados: as falhas observadas estão na matriz.

Foram registrados **26 achados**: quatro defeitos/inconsistências observados, um comportamento de disponibilidade a investigar, cinco riscos do desenho, dez lacunas/limites de capacidade e seis necessidades de melhoria. Duas falhas do desenho inicial foram corrigidas no laboratório revisado. Nenhuma alteração foi feita no código de produção da aplicação.

## Artefatos e uso

- [Topologia revisada importável](factory-final.shlab.json): **43 equipamentos, 47 enlaces, oito VLANs**, racks/UPS independentes e patch panel.
- [Desenho completo em SVG](topology.svg), com todos os equipamentos e enlaces do arquivo revisado.
- [Baseline inicial](factory-baseline.shlab.json): 38 equipamentos, usado por S01–S37 para expor falhas de disponibilidade.
- [Exportação realizada pela interface](evidence/ui-export.shlab.json), com 43 equipamentos/47 enlaces.
- [Resultados S01–S30](scenario-results.json), [resultados S31–S42](extended-results.json), [backlog](backlog.csv) e [achados estruturados](findings.json).
- [PCAP HTTP](evidence/http-mes.pcap), [log dos 50 testes](regression-tests.log) e [evidências da interface](evidence/).

Para abrir, entre no shLab, crie um laboratório livre e use **Opções do laboratório → Importar topologia** com o arquivo revisado. O laboratório de auditoria também foi salvo na instalação local, usando conta sintética isolada. Essa conta não é a conta pessoal do usuário; o JSON permite importar o cenário em qualquer laboratório autorizado. Credenciais, cookies e perfil de navegador não fazem parte da entrega.

## Escopo e hipóteses

Fábrica fictícia, com equipamentos representativos de cada função; não foi fornecida uma planta, inventário, fabricante ou SLA real. PLCs usam TCP echo na porta 502; SCADA, MES e NVR usam HTTP de teste. Câmeras são representações de endpoints. Essas substituições são explícitas e não validam lógica de PLC, Modbus, SCADA real ou vídeo. A WAN é inteiramente simulada.

Os cenários usam tempo virtual determinístico e seed 42. Experimentos de falha começam de snapshots equivalentes. Os testes de ping bloqueado aguardaram o timeout de 30 s do motor; TCP bloqueado foi avaliado pelo deny, ausência de resposta e retransmissões, sem declarar término do timeout TCP quando ainda SYN-SENT.

Não foram ensaiados todos os protocolos ou combinações possíveis, 2.000 equipamentos, múltiplos usuários, implantação externa, hardware real, certificação industrial, cargas reais de vídeo/controle nem captura interoperável de todos os serviços. Os cinco templates complementares foram apenas inicializados e avançados por 5 s: isso não equivale a validar seus fluxos ponta a ponta.

## Desenho e casos de uso

| VLAN | Rede | Função | Representantes |
|---|---|---|---|
| 10 | 10.20.10.0/24 | TI corporativa | ERP, financeiro, impressora |
| 20 | 10.20.20.0/24 | DMZ/serviços | MES, DNS, DHCP |
| 30 | 10.20.30.0/24 | Supervisão OT | SCADA, engenharia OT, broker |
| 40 | 10.20.40.0/24 | Célula A | PLC-A, HMI-A, sensor A |
| 50 | 10.20.50.0/24 | Célula B | PLC-B, HMI-B, sensor B |
| 60 | 10.20.60.0/24 | CFTV | NVR, câmeras 01/02 |
| 70 | 10.20.70.0/24 | Visitantes | AP, notebook Wi-Fi |
| 99 | 10.20.99.0/24 | Gerenciamento | NMS/syslog, NTP, administração |

DIST-A/B fazem switching com RSTP. FW-A/B possuem subinterfaces 802.1Q, políticas stateful e VIP .1 por VLAN. A versão revisada inclui VRRP também no trânsito WAN, VIP 172.20.0.254; o roteador de borda usa esse VIP no retorno. DHCP usa dois relays e pools disjuntos, pois o modelo escolhe pool por giaddr exato. Dois racks/UPS alimentam os pares de distribuição/firewall; endpoints e acesso das células continuam com pontos únicos de falha.

Casos cobertos: HMI–PLC local; SCADA–células; telemetria MQTT; ERP–MES; resolução DNS e DHCP relay; acesso de visitantes e isolamento TI/OT/CFTV; gerência SNMP, syslog e NTP; failover de cabo, firewall, distribuição e energia; indisponibilidade de serviços; recuperação; MTU/DF; cabeamento fora do alcance; save/load e exportação PCAP.

A política de visitantes permite HTTP para a DMZ no laboratório para testar o caminho Wi-Fi. **Isso é um risco pendente do desenho (D05), não uma recomendação para produção.** As regras de administração também são abrangentes para o ensaio e precisam de refinamento por origem/serviço em um projeto real.

## Resultados dos 42 experimentos

| ID/evidência | Experimento | Observado |
|---|---|---|
| [S01](evidence/S01.json) | HMI-A para PLC-A local | success · 16,086 ms |
| [S02](evidence/S02.json) | SCADA para PLC-A autorizado | success · 60,554 ms |
| [S03](evidence/S03.json) | SCADA para PLC-B autorizado | success · 60,564 ms |
| [S04](evidence/S04.json) | TI para PLC-A bloqueado | timeout + política deny |
| [S05](evidence/S05.json) | Célula A para B bloqueada | timeout + isolamento |
| [S06](evidence/S06.json) | TI para MES HTTP | HTTP 200 · 126 B recebidos |
| [S07](evidence/S07.json) | Visitante para PLC bloqueado | timeout + isolamento |
| [S08](evidence/S08.json) | Visitante para MES HTTP | HTTP 200; revisar política de visitantes |
| [S09](evidence/S09.json) | DNS DMZ | NOERROR → 10.20.20.10 |
| [S10](evidence/S10.json) | DHCP por relay | bound → 10.20.10.100 |
| [S11](evidence/S11.json) | MQTT sensor e assinante SCADA | Leitura 72.5 entregue a SCADA; wildcard + retained |
| [S12](evidence/S12.json) | Falha do uplink principal célula A | success pelo uplink alternativo · 72,637 ms |
| [S13](evidence/S13.json) | Falha total de FW-A / VRRP | FW-B ACTIVE; novo ping success · 80,639 ms |
| [S14](evidence/S14.json) | Dois uplinks célula A desligados | timeout por isolamento |
| [S15](evidence/S15.json) | Restaurar uplink após isolamento | timeout durante falha; success após restauração |
| [S16](evidence/S16.json) | DNS desligado e cache limpo | DNS timeout · 10.000 ms virtuais |
| [S17](evidence/S17.json) | HTTP MES desligado | TCP RESET com HTTP desativado |
| [S18](evidence/S18.json) | Persistência com ping pendente | Ping pendente restaurado → success |
| [S19](evidence/S19.json) | DHCP após perda do primário | Sem IPv4; DHCP selecting (falha de projeto) |
| [S20](evidence/S20.json) | Cabeamento cobre 150 m | timeout com cobre de 150 m |
| [S21](evidence/S21.json) | CFTV local NVR | HTTP 200 local · 122 B |
| [S22](evidence/S22.json) | CFTV para OT bloqueado | timeout + isolamento |
| [S23](evidence/S23.json) | NMS consulta SNMP SCADA | SNMP success → SCADA |
| [S24](evidence/S24.json) | Wi-Fi chave incorreta | Chave incorreta não associou/entregou; ping timeout |
| [S25](evidence/S25.json) | MTU / DF 2000 bytes | unreachable / DF e MTU |
| [S26](evidence/S26.json) | TI para suporte WAN HTTP | HTTP 200 pela WAN simulada · 134 B |
| [S27](evidence/S27.json) | SCADA para PLC TCP/502 echo | Echo TCP/502 devolveu 18 B; não é Modbus |
| [S28](evidence/S28.json) | TI para PLC TCP/502 bloqueado | SYN-SENT, 5 retransmissões, 0 B recebidos; bloqueio |
| [S29](evidence/S29.json) | Snapshot restaura estado convergido | Snapshot válido; 38 devices / 46 links |
| [S30](evidence/S30.json) | VRRP retorno / preempção | Preempção de FW-A; novo ping success |
| [S31](evidence/S31.json) | WAN após falha de FW-A: rota de retorno estática | SYN-SENT sem retorno WAN (falha de projeto) |
| [S32](evidence/S32.json) | Falha de distribuição DIST-A | Primeiro probe timeout; tentativa após 37 s success |
| [S33](evidence/S33.json) | Captura PCAP de HTTP | PCAP: 117 pacotes decodificados; 164 excluídos |
| [S34](evidence/S34.json) | Retenção dos eventos após ping e 5 s | PING_SUCCESS removido; PCAP 0; probe success preservado |
| [S35](evidence/S35.json) | NTP no segmento de gestão | NTP synchronized; offset 250 → 0 ms |
| [S36](evidence/S36.json) | Syslog no segmento de gestão | Mensagem syslog recebida |
| [S37](evidence/S37.json) | Switch L2 com SVI: gerência syslog | SVI ping success, mas syslog rejeitado |
| [S38](evidence/S38.json) | DHCP redundante corrigido após falha de FW-A | DHCP após failover → 10.20.10.111 |
| [S39](evidence/S39.json) | WAN corrigida: nova sessão após failover | HTTP 200 WAN após failover |
| [S40](evidence/S40.json) | UPS A sem rede elétrica e bateria esgotada | UPS esgotada desliga FW-A/DIST-A; timeout e recuperação posterior |
| [S41](evidence/S41.json) | Patch panel: comunicação SCADA–PLC | Ping via patch panel success · 68,536 ms |
| [S42](evidence/S42.json) | Energia: perda das duas UPS | Duas UPS sem energia → timeout |

Os blocos S38–S42 usam a topologia revisada com infraestrutura. S31/S19 falharam por configuração do desenho inicial; S38/S39 comprovaram as correções. S32/S40 mostram perda do primeiro probe e recuperação em tentativa posterior; a causa e o tempo exato de convergência permanecem a investigar. Ping perdido não prova, por si só, indisponibilidade permanente.

## Evidências do uso da interface

- [Canvas importado](evidence/01-topology.png): baseline com regiões, redundância e enlaces STP.
- [Execução a 5×](evidence/03-play-5x.png) e [medição](evidence/ui-speed.json): 17,326 s reais para 8,493 ms virtuais.
- [ICMP concluído](evidence/ui-scada-result.txt): SCADA → PLC-A, resultado recebido, RTT 60,554 ms.
- [HTTP no inspetor](evidence/ui-http-result.txt): PC-ERP → MES, HTTP 200, 126 B recebidos.
- [Bloqueio de firewall](evidence/ui-firewall-block.txt): FIREWALL_DENY para TI → PLC-A.
- [Terminal](evidence/ui-terminal-vrrp.txt): show vrrp em FW-A, grupos ACTIVE.
- [Persistência](evidence/ui-persistence.txt): laboratório reaberto, 43 dispositivos, snapshot restaurado; salvamento final foi verificado em observação posterior.
- [Layout 390 × 844](evidence/mobile-layout.json): canvas 390 × 477, bodyWidth 390, botão de ping dentro da largura; não houve overflow horizontal nesse estado.
- [Axe](evidence/accessibility.json): um achado heading-order; a verificação não cobriu todos os estados da aplicação.

O navegador integrado não estava disponível. A avaliação usou Edge instalado, em perfil isolado, operado por Playwright/CDP. Restrições de spawn exigiram execução autorizada fora do sandbox. Falhas de inicialização/timeout do próprio harness foram resolvidas e não foram atribuídas ao produto. Alguns screenshots adicionais não concluíram; os resultados relevantes foram conservados em texto/JSON. O modo automático foi avaliado como usuário; o avanço em lote usou o mesmo botão Próximo evento da interface, sem modificar seu estado interno diretamente.

## Backlog priorizado

P1: bloqueia ou compromete este uso da fábrica. P2: reduz fidelidade, usabilidade ou acessibilidade. Não foi demonstrado um defeito P0 de isolamento/bypass; os bloqueios ensaiados funcionaram. A prioridade das lacunas depende do protocolo/SLA exigido pela fábrica real.

| ID | Prioridade | Classificação | Achado | Estado |
|---|---|---|---|---|
| B01 | P1 | Defeito operacional | Reprodução automática lenta e modo Tempo real sem sincronismo | Aberto |
| B02 | P1 | Defeito operacional | Tráfego de controle elimina as evidências da aplicação | Aberto |
| B03 | P2 | Inconsistência funcional | Switch L2 com SVI possui IP, mas o syslog diz que não possui stack | Aberto |
| B04 | P2 | Acessibilidade | Hierarquia de títulos incorreta no workspace | Aberto |
| O01 | P1 | Disponibilidade observada | Failover da distribuição e de uma UPS perde o primeiro probe | Investigar |
| D01 | P1 | Falha do desenho inicial | Relay DHCP existia somente em FW-A | Corrigido no laboratório |
| D02 | P1 | Falha do desenho inicial | Rota de retorno WAN apontava para IP físico do primário | Corrigido no laboratório |
| D03 | P1 | Risco do desenho | Serviços e acesso WAN ainda têm pontos únicos de falha | Aberto |
| D04 | P1 | Risco do desenho | Duas fibras/uplinks não redundam o switch de uma célula | Aberto |
| D05 | P1 | Política do laboratório | Visitantes conseguem acessar o MES na DMZ | Aberto |
| L01 | P1 | Lacuna industrial | PLCs e protocolos de automação não são emulados | Não implementado no escopo inspecionado |
| L02 | P1 | Lacuna industrial | Redundância industrial específica não está disponível | Não implementado no escopo inspecionado |
| L03 | P1 | Lacuna industrial | NTP não substitui sincronismo e agendamento industrial | Não implementado no escopo inspecionado |
| L04 | P2 | Limitação física | Desenho visual não equivale a planta RF da fábrica | Documentado |
| L05 | P1 | Limitação de workload | SCADA, MES e câmeras usam serviços substitutos | Representação simplificada |
| L06 | P2 | Limitação de fidelidade | Perfis não executam firmware real | Documentado |
| L07 | P1 | Lacuna MQTT | MQTT industrial exige mais garantias do que o fluxo testado | Parcial |
| L08 | P2 | Lacuna de gerência | Gerência usa community e não demonstra SNMPv3 | Parcial |
| L09 | P2 | Limitação de captura | PCAP representa apenas os codecs disponíveis | Documentado e observado |
| L10 | P2 | Restrição de equipamento | Firewall stateful de trânsito exige roteador | Documentado no código |
| U01 | P1 | Melhoria de ensaio | Falta um executor de cenários com resultados e assertions | Backlog |
| U02 | P2 | Melhoria visual | Visão geral tem nomes minúsculos e muitos cabos cruzados | Backlog |
| U03 | P2 | Melhoria de configuração | Configuração da fábrica requer repetição e muitos painéis | Backlog |
| U04 | P1 | Melhoria de diagnóstico | Falta revisão de disponibilidade e política antes de executar | Backlog |
| U05 | P1 | Melhoria de observabilidade | Falta resultado consolidado de disponibilidade e SLA | Backlog |
| U06 | P2 | Necessidade de equipe | Revisão colaborativa de uma fábrica exige recursos adicionais | Parcial/documentado |

## Reprodução, correção sugerida e aceitação

### B01 · P1 · Reprodução automática lenta e modo Tempo real sem sincronismo

**Classificação:** Defeito operacional. **Estado:** Aberto.

**Observado:** No modo Simulação, 17.326 ms reais a 5× avançaram apenas 8,493 ms virtuais; ping permaneceu pendente. O mesmo fluxo concluiu por eventos com RTT 60,554 ms. Em nova medição no modo Tempo real, a 5×, após 55,847 s reais o ping ainda aguardava; relógio exibido 11418,344 ms, partindo de snapshot 11000 ms (alguns eventos ocorreram antes do início dessa medição).

**Evidência:** [evidence/ui-speed.json](evidence/ui-speed.json) · [evidence/ui-realtime-speed.json](evidence/ui-realtime-speed.json) · [evidence/03-play-5x.png](evidence/03-play-5x.png) · [apps/web/src/workspace/useLab.ts:173](../../apps/web/src/workspace/useLab.ts:173).

**Ação sugerida:** Processar até um horizonte virtual com orçamento de CPU; separar modo didático de tempo real; mostrar atraso e taxa de eventos.

**Aceitação:** Definir o contrato de velocidade: no modo Tempo real, 10 s reais a 5× devem avançar aproximadamente 50 s virtuais dentro de tolerância explícita; no modo didático, informar taxa de eventos e manter pausa responsiva.

### B02 · P1 · Tráfego de controle elimina as evidências da aplicação

**Classificação:** Defeito operacional. **Estado:** Aberto.

**Observado:** Após ping bem sucedido, 5 s virtuais adicionais levaram o buffer a 1.500 eventos, removeram PING_SUCCESS e produziram PCAP com 0 pacotes. O resultado do probe continuou success.

**Evidência:** [evidence/S34.json](evidence/S34.json) · [packages/simulation-engine/src/core/engine.ts:929](../../packages/simulation-engine/src/core/engine.ts:929).

**Ação sugerida:** Captura independente do buffer visual; retenção por fluxo; filtros antes da retenção; aviso de truncamento e histórico persistente.

**Aceitação:** Uma captura iniciada antes do ping deve conservar ida/volta após 30 s de RSTP/VRRP e informar claramente perdas de registros.

### B03 · P2 · Switch L2 com SVI possui IP, mas o syslog diz que não possui stack

**Classificação:** Inconsistência funcional. **Estado:** Aberto.

**Observado:** SW-TI, com SVI 99, respondeu ping para NMS em 24,221 ms. configureSyslog rejeitou: Switch L2 não possui stack IPv4 de gerenciamento.

**Evidência:** [evidence/S37.json](evidence/S37.json) · [packages/simulation-engine/src/protocols/syslog.ts:15](../../packages/simulation-engine/src/protocols/syslog.ts:15).

**Ação sugerida:** Separar stack de gerenciamento de encaminhamento L3; validar SVI operacional em lugar de exigir ipRouting. Revisar restrição equivalente em SNMP.

**Aceitação:** Um switch L2 com SVI e gateway deve enviar syslog e responder SNMP sem habilitar roteamento entre VLANs.

### B04 · P2 · Hierarquia de títulos incorreta no workspace

**Classificação:** Acessibilidade. **Estado:** Aberto.

**Observado:** Axe encontrou heading-order, impacto moderate, em um h4; 44 regras passaram nesse estado. Trata-se de uma verificação pontual, não de certificação WCAG.

**Evidência:** [evidence/accessibility.json](evidence/accessibility.json).

**Ação sugerida:** Corrigir a sequência semântica de títulos sem alterar a hierarquia visual.

**Aceitação:** Zerar heading-order nesse estado e verificar novamente inspetores e modais.

### O01 · P1 · Failover da distribuição e de uma UPS perde o primeiro probe

**Classificação:** Disponibilidade observada. **Estado:** Investigar.

**Observado:** S32: um ping iniciado 6 s após desligar DIST-A expirou; nova tentativa após 37 s funcionou. S40: um ping iniciado após 5 s de cenário de UPS expirou; tentativa posterior funcionou. Não foi medido o instante exato da recuperação.

**Evidência:** [evidence/S32.json](evidence/S32.json) · [evidence/S40.json](evidence/S40.json).

**Ação sugerida:** Instrumentar tempos de convergência L2/L3, ARP e VRRP; investigar causa; acrescentar ensaio com fluxo contínuo e SLA de recuperação explícito.

**Aceitação:** Atender a meta deste ensaio de recuperação até 5 s, ou informar de forma explícita que o modelo não atende essa meta.

### D01 · P1 · Relay DHCP existia somente em FW-A

**Classificação:** Falha do desenho inicial. **Estado:** Corrigido no laboratório.

**Observado:** S19: cliente permaneceu selecting e sem IP após perda de FW-A. S38: relay em FW-B e pool disjunto entregaram 10.20.10.111.

**Evidência:** [evidence/S19.json](evidence/S19.json) · [evidence/S38.json](evidence/S38.json).

**Ação sugerida:** Manter relay nos dois gateways e pools disjuntos por giaddr neste modelo; considerar disponibilidade do próprio serviço DHCP.

**Aceitação:** Novo cliente deve receber lease após perda de qualquer gateway.

### D02 · P1 · Rota de retorno WAN apontava para IP físico do primário

**Classificação:** Falha do desenho inicial. **Estado:** Corrigido no laboratório.

**Observado:** S31: nova sessão ficou SYN-SENT e sem resposta após perda de FW-A. S39: VIP 172.20.0.254 no trânsito e rota de retorno via VIP permitiram HTTP 200.

**Evidência:** [evidence/S31.json](evidence/S31.json) · [evidence/S39.json](evidence/S39.json).

**Ação sugerida:** Usar gateway virtual no trânsito ou roteamento dinâmico com retorno disponível.

**Aceitação:** Nova sessão para suporte externo deve funcionar com FW-A desligado.

### D03 · P1 · Serviços e acesso WAN ainda têm pontos únicos de falha

**Classificação:** Risco do desenho. **Estado:** Aberto.

**Observado:** DNS, DHCP, broker, SCADA, MES e o roteador/switch WAN são instâncias únicas. Apenas DNS e MES indisponíveis foram injetados individualmente.

**Evidência:** [factory-final.shlab.json](factory-final.shlab.json) · [evidence/S16.json](evidence/S16.json) · [evidence/S17.json](evidence/S17.json).

**Ação sugerida:** Projetar serviços redundantes e um segundo caminho WAN; validar sessões, dados e recuperação por serviço.

**Aceitação:** Demonstrar continuidade sob perda de cada serviço/link identificado; não inferir HA a partir de dois firewalls.

### D04 · P1 · Duas fibras/uplinks não redundam o switch de uma célula

**Classificação:** Risco do desenho. **Estado:** Aberto.

**Observado:** Cada célula possui um único switch e endpoints com um único caminho ativo. A perda dos dois uplinks isolou a célula, conforme S14. Não foi injetada perda do próprio switch de célula.

**Evidência:** [factory-final.shlab.json](factory-final.shlab.json) · [evidence/S14.json](evidence/S14.json).

**Ação sugerida:** Definir tolerância do processo; adicionar caminhos/equipamentos redundantes quando exigidos pelo SLA.

**Aceitação:** Ensaiar perda do switch da célula e demonstrar impacto esperado sobre HMI/PLC.

### D05 · P1 · Visitantes conseguem acessar o MES na DMZ

**Classificação:** Política do laboratório. **Estado:** Aberto.

**Observado:** S08 retornou HTTP 200 para NOTEBOOK-VISITANTE → MES-DMZ. Esse acesso foi permitido para testar o caminho Wi-Fi e permanece no arquivo revisado.

**Evidência:** [evidence/S08.json](evidence/S08.json) · [factory-final.shlab.json](factory-final.shlab.json).

**Ação sugerida:** Remover a permissão ampla TCP/80 de WIFI para DMZ e autorizar somente um portal específico, se necessário.

**Aceitação:** Visitantes devem manter acesso autorizado ao portal e receber bloqueio para MES e OT.

### L01 · P1 · PLCs e protocolos de automação não são emulados

**Classificação:** Lacuna industrial. **Estado:** Não implementado no escopo inspecionado.

**Observado:** PLC-A/B são servidores TCP echo/502. Porta 502 aberta não comprova Modbus. O catálogo não possui PLC/HMI nativos; não foi encontrado suporte a Modbus, PROFINET, EtherNet/IP ou OPC UA no catálogo/modelos inspecionados.

**Evidência:** [factory-scenario.ts](factory-scenario.ts) · [packages/simulation-engine/src/devices/profiles.ts](../../packages/simulation-engine/src/devices/profiles.ts) · [evidence/S27.json](evidence/S27.json).

**Ação sugerida:** Criar perfis e modelos de operações industriais, registradores, sessões, tempos e falhas.

**Aceitação:** Validar uma leitura/escrita industrial com resposta protocolar e comportamento do processo.

### L02 · P1 · Redundância industrial específica não está disponível

**Classificação:** Lacuna industrial. **Estado:** Não implementado no escopo inspecionado.

**Observado:** RSTP e VRRP foram testados; isso não valida MRP, DLR, PRP ou HSR. A ausência desses modelos não é um defeito do RSTP anunciado.

**Evidência:** [packages/simulation-engine/src/index.ts](../../packages/simulation-engine/src/index.ts) · [docs/protocols.md](../../docs/protocols.md).

**Ação sugerida:** Implementar os mecanismos necessários ao ambiente alvo e fluxos contínuos durante rompimento de anel.

**Aceitação:** Medir perda e recuperação por protocolo solicitado, com critérios publicados.

### L03 · P1 · NTP não substitui sincronismo e agendamento industrial

**Classificação:** Lacuna industrial. **Estado:** Não implementado no escopo inspecionado.

**Observado:** S35 validou NTP e correção de offset de 250 ms. PTP/IEEE 1588, TSN e tráfego cíclico determinístico não foram modelados neste ensaio.

**Evidência:** [evidence/S35.json](evidence/S35.json) · [packages/simulation-engine/src/protocols/ntp.ts](../../packages/simulation-engine/src/protocols/ntp.ts).

**Ação sugerida:** Modelar sincronismo, deadlines, jitter e agendamento se esses requisitos forem necessários.

**Aceitação:** Medir offset, jitter e violação de deadline no modelo específico; evitar conclusões de precisão industrial a partir de NTP.

### L04 · P2 · Desenho visual não equivale a planta RF da fábrica

**Classificação:** Limitação física. **Estado:** Documentado.

**Observado:** Distância de rádio deriva da posição dos dispositivos. Uma obstrução próxima ao rádio não representa paredes geométricas; a descrição documenta drywall/tijolo/concreto. Não há estudo de galpão metálico neste modelo.

**Evidência:** [docs/adr/039-physical-link-conditions.md](../../docs/adr/039-physical-link-conditions.md) · [packages/simulation-engine/src/protocols/wireless-model.ts](../../packages/simulation-engine/src/protocols/wireless-model.ts).

**Ação sugerida:** Separar coordenadas do desenho e coordenadas físicas; definir escala, materiais e obstáculos de planta.

**Aceitação:** Mover um ícone apenas para organizar o desenho não deve alterar alcance físico; permitir cenário físico com geometria explícita.

### L05 · P1 · SCADA, MES e câmeras usam serviços substitutos

**Classificação:** Limitação de workload. **Estado:** Representação simplificada.

**Observado:** SCADA/MES/NVR são HTTP de teste; câmeras são IoT e acessam HTTP local. Não há ciclo de PLC, processo produtivo ou vídeo RTSP/H.264 no cenário.

**Evidência:** [factory-scenario.ts](factory-scenario.ts) · [evidence/S21.json](evidence/S21.json).

**Ação sugerida:** Acrescentar geradores de carga, telemetria periódica, vídeo e alarmes/processo, com taxas declaradas.

**Aceitação:** Validar gargalos e QoS com cargas representativas, não apenas um ping ou GET.

### L06 · P2 · Perfis não executam firmware real

**Classificação:** Limitação de fidelidade. **Estado:** Documentado.

**Observado:** CLI, pacotes e timers pertencem ao motor educacional. Portas e fabricantes lógicos não comprovam interoperabilidade de equipamentos reais.

**Evidência:** [README.md](../../README.md) · [docs/requirements-coverage.md](../../docs/requirements-coverage.md).

**Ação sugerida:** Publicar a matriz de fidelidade por comando/protocolo; integrar emulação quando necessária.

**Aceitação:** Separar testes do modelo dos testes com hardware/firmware real.

### L07 · P1 · MQTT industrial exige mais garantias do que o fluxo testado

**Classificação:** Lacuna MQTT. **Estado:** Parcial.

**Observado:** Foi entregue retained e assinatura wildcard. O modelo CONNECT inspecionado contém clientId/keepAlive; PUBLISH não contém QoS. Não foram validados autenticação de broker, TLS, QoS 1/2 ou sessão persistente.

**Evidência:** [evidence/S11.json](evidence/S11.json) · [packages/simulation-engine/src/protocols/applications-model.ts](../../packages/simulation-engine/src/protocols/applications-model.ts).

**Ação sugerida:** Implementar ou explicitar QoS, autenticação, TLS, retransmissão e reconexão/offline.

**Aceitação:** Demonstrar a semântica de entrega e de sessão sob desconexão; não alegar essas garantias no fluxo atual.

### L08 · P2 · Gerência usa community e não demonstra SNMPv3

**Classificação:** Lacuna de gerência. **Estado:** Parcial.

**Observado:** S23 validou GET do hostname do SCADA com community de teste. Não validou authPriv, traps ou integração externa.

**Evidência:** [evidence/S23.json](evidence/S23.json) · [packages/simulation-engine/src/protocols/snmp-model.ts](../../packages/simulation-engine/src/protocols/snmp-model.ts).

**Ação sugerida:** Modelar SNMPv3 e notificações se necessários; permitir ensaios de credencial e confidencialidade.

**Aceitação:** Autenticação e proteção de gerência devem alterar a simulação e produzir evidência verificável.

### L09 · P2 · PCAP representa apenas os codecs disponíveis

**Classificação:** Limitação de captura. **Estado:** Documentado e observado.

**Observado:** S33 gerou 117 pacotes decodificáveis e excluiu 164 envelopes sem codec. Tráfego didático e alguns serviços ficam fora do PCAP.

**Evidência:** [evidence/S33.json](evidence/S33.json) · [evidence/http-mes.pcap](evidence/http-mes.pcap) · [packages/simulation-engine/src/wire/pcap.ts](../../packages/simulation-engine/src/wire/pcap.ts).

**Ação sugerida:** Conservar e exibir relatório de exclusões por fluxo; ampliar codecs prioritários.

**Aceitação:** Exibir pacotes capturados, omitidos e motivos; não apresentar o PCAP como captura integral.

### L10 · P2 · Firewall stateful de trânsito exige roteador

**Classificação:** Restrição de equipamento. **Estado:** Documentado no código.

**Observado:** validateFirewallConfig rejeita switch L3. O desenho usa FW-A/B dedicados para fazer a política entre VLANs. ACL e firewall são recursos diferentes.

**Evidência:** [packages/simulation-engine/src/protocols/firewall-validation.ts:7](../../packages/simulation-engine/src/protocols/firewall-validation.ts:7) · [factory-final.shlab.json](factory-final.shlab.json).

**Ação sugerida:** Explicitar a restrição no catálogo/formulário ou permitir a capacidade em equipamentos apropriados.

**Aceitação:** Usuário deve saber antes da montagem onde a política stateful pode ser aplicada.

### U01 · P1 · Falta um executor de cenários com resultados e assertions

**Classificação:** Melhoria de ensaio. **Estado:** Backlog.

**Observado:** A bateria livre de 42 cenários precisou de scripts externos ao fluxo de desenho; desafios existentes têm outro objetivo pedagógico.

**Evidência:** [factory-scenario.ts](factory-scenario.ts) · [factory-extended.ts](factory-extended.ts) · [apps/web/src/workspace/Workspace.tsx](../../apps/web/src/workspace/Workspace.tsx).

**Ação sugerida:** Permitir matriz origem/destino/protocolo, falha agendada, baseline, assertion, comparação e exportação.

**Aceitação:** Executar toda a matriz da fábrica pela aplicação e gerar relatório de esperado/observado automaticamente.

### U02 · P2 · Visão geral tem nomes minúsculos e muitos cabos cruzados

**Classificação:** Melhoria visual. **Estado:** Backlog.

**Observado:** A captura inicial de 38 dispositivos ajustou a rede inteira ao canvas e reduziu a leitura dos nomes. Localizador e ocultar portas ajudam.

**Evidência:** [evidence/01-topology.png](evidence/01-topology.png).

**Ação sugerida:** Adicionar níveis físico/lógico, agregação de trunks, zoom semântico, layout automático e rótulos legíveis.

**Aceitação:** Identificar regiões e caminhos principais sem depender de zoom em cada dispositivo.

### U03 · P2 · Configuração da fábrica requer repetição e muitos painéis

**Classificação:** Melhoria de configuração. **Estado:** Backlog.

**Observado:** Foram usados importação e scripts para construir endereçamento, oito VLANs, regras, gateways e serviços coerentes. Os formulários individuais funcionaram para HTTP e terminal.

**Evidência:** [factory-scenario.ts](factory-scenario.ts) · [evidence/ui-http-result.txt](evidence/ui-http-result.txt) · [evidence/ui-terminal-vrrp.txt](evidence/ui-terminal-vrrp.txt).

**Ação sugerida:** Assistente de fábrica, modelos de célula e operações em lote com prévia/diff.

**Aceitação:** Duplicar uma célula remapeando IP, VLAN, MAC e referências; validar o lote antes de aplicar.

### U04 · P1 · Falta revisão de disponibilidade e política antes de executar

**Classificação:** Melhoria de diagnóstico. **Estado:** Backlog.

**Observado:** A validação estrutural aceitou o desenho com relay único, retorno WAN pelo primário e visitante autorizado ao MES. São configurações válidas, mas riscos de projeto.

**Evidência:** [evidence/S19.json](evidence/S19.json) · [evidence/S31.json](evidence/S31.json) · [evidence/S08.json](evidence/S08.json).

**Ação sugerida:** Adicionar preflight de SPOFs, referências, VLAN nativa/tagged, rotas de retorno e acesso entre zonas.

**Aceitação:** Produzir avisos contextualizados, sem confundir um desenho válido com um desenho disponível ou seguro.

### U05 · P1 · Falta resultado consolidado de disponibilidade e SLA

**Classificação:** Melhoria de observabilidade. **Estado:** Backlog.

**Observado:** Tabela de probes ajuda, mas a recuperação após falhas exigiu observação separada de RSTP, VRRP, ARP e aplicações.

**Evidência:** [evidence/S32.json](evidence/S32.json) · [evidence/S40.json](evidence/S40.json).

**Ação sugerida:** Painel de perda, interrupção, convergência, jitter/percentis e caminhos por fluxo; identificar relógio virtual versus real.

**Aceitação:** Comparar baseline/falha/recuperação com limites de SLA e explicar a causa de cada resultado.

### U06 · P2 · Revisão colaborativa de uma fábrica exige recursos adicionais

**Classificação:** Necessidade de equipe. **Estado:** Parcial/documentado.

**Observado:** Snapshot, exportação e histórico funcionaram; compartilhamento e colaboração simultânea são pendências documentadas e não foram exercitados.

**Evidência:** [evidence/ui-persistence.txt](evidence/ui-persistence.txt) · [README.md](../../README.md) · [docs/requirements-coverage.md](../../docs/requirements-coverage.md).

**Ação sugerida:** Revisão/diff de configuração, permissões e colaboração conforme escopo do produto.

**Aceitação:** Dois analistas devem revisar e comparar cenários com autoria e controle de revisão claros.


## Reprodução da bateria

Na raiz do repositório, com as dependências existentes:

```powershell
node --import tsx artifacts/factory-audit/factory-scenario.ts
node --import tsx artifacts/factory-audit/factory-extended.ts
node artifacts/factory-audit/build-report.mjs
npm test -- tests/vrrp.test.ts tests/dhcp-relay.test.ts tests/firewall-zones.test.ts tests/applications.test.ts tests/infrastructure.test.ts tests/physical-conditions.test.ts
```

Os scripts geram os cenários e resultados; a avaliação dos observados está explícita na matriz. As evidências de interface e a medição de reprodução são desta sessão e precisam ser coletadas novamente para confirmar mudanças no frontend. Os scripts não são uma suíte que torna qualquer saída automaticamente aprovada.

## Ordem recomendada de trabalho

1. Corrigir B01 e B02: tornar a simulação utilizável sob tráfego de controle e conservar suas evidências.
2. Investigar O01 com fluxo contínuo e instrumentação de convergência; corrigir B03 e revisar os pontos únicos de falha e política de visitantes.
3. Acrescentar executor de cenários, revisão de topologia e relatório de SLA para repetir ensaios pelo produto.
4. Escolher os protocolos industriais e SLAs da fábrica alvo e implementar L01–L05 conforme essa decisão.
5. Corrigir B04 e melhorar configuração em lote, desenho e revisão colaborativa.

O resultado desta auditoria é um laboratório reutilizável e um backlog baseado nos ensaios realizados. A entrega não afirma ter encontrado todas as falhas possíveis nem substitui validação com os equipamentos e requisitos reais da fábrica.
