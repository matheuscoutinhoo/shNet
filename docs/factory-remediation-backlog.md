# Pendências da fábrica PLC/HMI com Modbus TCP e rede IP

Atualizado em 13/10/2026. Este documento distingue correções entregues de recursos ainda parciais. A identificação dos achados corresponde ao [relatório original](../artifacts/factory-audit/RELATORIO.md); o [status por achado](../artifacts/factory-audit/remediation/remediation-status.json) mantém a rastreabilidade.

## Entregue e validado

Correções de execução em tempo real, retenção da captura, gerência em switches L2, hierarquia de títulos, convergência RSTP, relay DHCP/VRRP, retorno WAN, segmentação de visitantes e enquadramento em telas pequenas. Novos recursos: template de fábrica com 43 dispositivos, 47 enlaces e oito VLANs; PLC/HMI com registradores Modbus 03/06/16; executor ICMP/HTTP/Modbus; preflight; revisão por diff; métricas de SLA; posições físicas RF; autenticação e publicação MQTT QoS 1.

Validação registrada: **664 testes aprovados, zero falhas e um ignorado**, em 71 arquivos; 42 casos de fábrica no motor e sete modelos de cenários na interface. Build, TypeScript, lint e formatação aprovados. A interface foi exercitada com Modbus, cenários, captura, acessibilidade e viewport de 390 × 844. A descrição completa está em [correções e validação](../artifacts/factory-audit/remediation/CORRECOES-E-VALIDACAO.md) e no [ADR-042](adr/042-factory-modbus-scenarios-remediation.md).

## Fase 1 — P1: disponibilidade e continuidade da produção

| Achados  | Falta implementar                                                                              | Critério de aceite                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| D03      | HA de DNS, DHCP, MES, SCADA e broker; segundo caminho WAN; consistência de dados e concessões. | Indisponibilidade de uma instância ou WAN mantém os fluxos críticos dentro do SLA definido, sem concessões conflitantes.            |
| D04      | Redundância de switches e interfaces/caminhos dos endpoints de célula.                         | Desligar qualquer switch ou enlace previsto no desenho mantém comunicação PLC/HMI ou registra a interrupção dentro do SLA aprovado. |
| D02, D03 | Sincronização de estado de firewall e sessões existentes no failover.                          | Testar sessões estabelecidas, além de novas conexões; demonstrar continuidade ou limite de recuperação explícito.                   |

Os pontos únicos estão identificados e ensaiados. Dois uplinks não eliminam um switch ou endpoint único. A arquitetura de redundância deve definir quais estados serão replicados e os SLAs de cada serviço antes da implementação.

## Fase 2 — P1: cobertura e rastreabilidade dos cenários

| Achados | Falta implementar                                                                                                         | Critério de aceite                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U01     | Ações DNS, DHCP, MQTT, SNMP, NTP e syslog no executor nativo; falhas de serviço/energia e ações de snapshot/persistência. | Executar os 42 casos pela interface com assertions e resultados reproduzíveis. Hoje os 42 estão na regressão do motor; o executor nativo oferece ICMP/HTTP/Modbus e falhas de dispositivo/enlace. |
| U05     | Persistência dos relatórios no backend; correlação automática entre falha, caminho e resultado.                           | Reabrir o projeto e consultar relatórios com versão da configuração, parâmetros, causa e comparação de baseline.                                                                                  |
| U05     | Medição de recuperação com maior precisão temporal.                                                                       | Declarar resolução e distinguir instante do evento de primeira amostra bem-sucedida; não tratar polling como medição exata.                                                                       |

## Fase 3 — P1: fidelidade do escopo industrial

| Achados  | Falta implementar                                                                     | Critério de aceite                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L01, L09 | Transporte Modbus binário e codec PCAP interoperável.                                 | Exportar MBAP/PDU e validar requests, responses e exceções em um decodificador independente. Hoje a representação é hexadecimal no transporte TCP textual do simulador. |
| L01, L05 | Coils, input registers, funções adicionais necessárias, ciclos de processo e alarmes. | PLC/HMI executam ciclos de leitura/escrita e cenários de falha com resultados de processo verificáveis. Funções 03/06/16 e holding registers já estão implementados.    |
| L05      | Cargas MES/SCADA e, se necessário, vídeo industrial.                                  | Carga e comportamento representam os requisitos definidos; HTTP substituto não deve ser tratado como SCADA/MES ou RTSP/H.264 completo.                                  |

## Fase 4 — P2: operação, escala e colaboração

| Achados    | Falta implementar                                                                                   | Critério de aceite                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| U02        | Autolayout, agregação visual de trunks e vistas física/lógica.                                      | Operar topologias grandes e móveis com seleção, navegação e enlaces legíveis.                                                    |
| U03        | Assistente de clonagem de células com remapeamento IP/VLAN/MAC/referências; ampliar edição em lote. | Criar células sem colisões nem referências órfãs, com diff, validação e undo.                                                    |
| U06        | RBAC de equipe, autoria de alterações e edição simultânea autoritativa.                             | Permissões verificadas no servidor; conflitos e histórico reproduzíveis entre usuários.                                          |
| L07        | MQTT QoS 2, TLS, sessões persistentes, reconexão e assinaturas com QoS superior a zero.             | Ensaios de perda/reconexão preservam a semântica de entrega e o estado previsto.                                                 |
| L08, L09   | SNMPv3 authPriv, traps, integração externa e codecs PCAP adicionais.                                | Interoperabilidade e limites documentados por protocolo, com testes independentes.                                               |
| Desempenho | Reduzir bundles do motor/Workers e medir escala, memória e atraso.                                  | Build sem alerta de chunks excessivos ou com justificativa mensurada; orçamento de desempenho e regressão em topologias maiores. |

## Fase 5 — dependente de requisitos adicionais

MRP/DLR/PRP/HSR (L02), PTP/TSN (L03), firmware e hardware reais (L06), RF com reflexão/difração (L04) e recursos além das capacidades atuais de ACL/firewall (L10) não estão concluídos. Avaliar somente se necessários à fábrica escolhida. RSTP não representa anel industrial; NTP não representa sincronismo PTP; o modelo RF não certifica cobertura de campo.

## Verificação ainda pendente

- Executar backup/restauração com PostgreSQL externo: o teste depende de `TEST_DATABASE_URL` e foi ignorado nesta validação.
- Validar implantação e integração em ambiente de produção; publicar código no GitHub não comprova essas etapas.
- Reexecutar regressões de failover e fluxos críticos após cada alteração de HA ou protocolo, com SLA explícito por fluxo.

Os relatórios, resultados resumidos, snapshot corrigido e capturas principais acompanham o código. Perfis locais do navegador, logs transitórios e dumps volumosos de cada cenário permanecem fora da publicação.
