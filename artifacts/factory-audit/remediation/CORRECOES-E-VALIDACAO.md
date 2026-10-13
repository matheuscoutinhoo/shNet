# Correções e validação da fábrica PLC/HMI

Data: 13/10/2026. Escopo escolhido pelo usuário: **PLC/HMI com Modbus TCP e rede IP**.

## Resultado da implementação

Foram corrigidos os defeitos de execução, retenção de evidências, gerenciamento de SVI e agreement RSTP; a configuração correta foi incorporada ao template nativo de fábrica. Há perfis PLC/HMI, operações Modbus, cenários salvos, polling e verificação de registradores, falhas agendadas, relatórios de SLA, preflight, revisão por diff, edição em lote e RF com posições físicas independentes.

Durante a validação surgiram dois achados adicionais: concorrência dos relays DHCP no par VRRP (B05) e perda do enquadramento ao mudar para uma tela estreita (B06). Ambos foram corrigidos.

**Não são 26 achados integralmente encerrados.** Parte da auditoria descreve funcionalidades de produto e fidelidade além do incremento escolhido. A tabela abaixo separa correção, entrega parcial e limite explícito. SPOFs de serviços/WAN/células e colaboração avançada continuam pendentes; a aplicação permite inspecionar e ensaiar esses riscos.

## Como usar

1. No dashboard, abra **Templates → Fábrica segmentada e redundância IP**.
2. No laboratório, abra **Opções do laboratório → Validar fábrica e cenários**.
3. Em **PLC / HMI**, configure registradores e execute operações 03/06/16.
4. Em **Cenários e SLA**, carregue um modelo, ajuste metas, execute baseline/falhas, salve a definição e exporte resultados.
5. Use **Verificar topologia**, **Capacidades do modelo** e **Configuração e revisão** antes de aplicar mudanças.

O [snapshot corrigido](../factory-corrected.shlab.json) também pode ser importado. Laboratórios existentes conservam suas configurações; para incorporar a fábrica corrigida, use o template ou revise o arquivo por diff. Não houve publicação em produção.

## Verificação

- **Suíte completa:** 664 testes aprovados, zero falhas, um ignorado, em 71 arquivos. O caso ignorado é backup/restauração em PostgreSQL servidor, condicionado a `TEST_DATABASE_URL` não configurado. [Resultado da regressão](regression-results.json).
- **Matriz da fábrica:** 42 cenários aprovados; os sete modelos nativos também foram executados pela regressão.
- **Build/TypeScript, lint completo e formatação completa:** aprovados. Artefatos de auditoria não fazem parte das verificações de código/formatação. O build mantém aviso de chunks acima de 500 kB; otimização adicional de carregamento permanece melhoria P2.
- **Interface:** cenário Modbus aprovado, registrador 725 lido, definição salva e reaberta; zero erros JavaScript e zero violações Axe nos estados de workspace e cenários exercitados. [Evidências da interface](ui-results.json).
- **Reprodução 5×:** medição registrada no JSON de interface, dentro da tolerância de −20%/+10% após inicialização do Worker. Atraso é exibido quando a CPU não acompanha.
- **Tela 390×844:** largura do conteúdo 390 px e 43 equipamentos visíveis após reenquadramento. [Tela estreita](mobile.png).
- **Falhas:** perda de DIST-A/UPS-A permite comunicação após cinco segundos virtuais no ensaio; a medição contínua anterior registrou o primeiro sucesso cerca de 4,07 s após a injeção. Isso não certifica o SLA de equipamentos reais.

A regressão dos 42 casos originais está em `tests/factory-matrix.test.ts`. S08 agora espera bloqueio ao MES; S19/S31 esperam o comportamento corrigido de DHCP/WAN; S27 valida registradores Modbus no lugar de echo/502. S20 verifica rejeição de cabo acima do alcance. Resultados negativos verificam ausência de resposta dentro da janela declarada, sem chamar isso de prova universal de segurança.

Os sete modelos nativos verificam HMI/SCADA→PLC, segmentação e falhas/restauração de firewall, distribuição, switch de célula, PLC e SCADA. Os demais casos da matriz usam APIs do motor para ações que o executor ainda não agenda; essa cobertura não significa que todos os 42 já são executáveis pelo novo painel.

## Rastreabilidade

| ID  | Estado                             | Alteração                                                                                                                      | Limite/remanescente                                                                                                                                     |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 | Corrigido                          | Horizonte virtual no Worker; reprodução didática separada, métricas de atraso/taxa e pausa.                                    | Sincronismo depende da CPU; atraso permanece visível.                                                                                                   |
| B02 | Corrigido                          | Captura e diagnósticos independentes, filtro de controle, limites e deltas consistentes por bytes.                             | Retenção limitada; descarte contado. PCAP tem codecs parciais.                                                                                          |
| B03 | Corrigido                          | Syslog e SNMP em switch L2 com SVI sem exigir ipRouting.                                                                       | SNMP mantém community.                                                                                                                                  |
| B04 | Corrigido                          | Hierarquia de títulos e nova validação Axe.                                                                                    | Verificação nos estados exercitados; não certificação WCAG.                                                                                             |
| O01 | Corrigido                          | Agreement RSTP não participa como anúncio de raiz; evita realimentação de custo e ressincronização repetida.                   | Convergência medida neste modelo e topologia.                                                                                                           |
| D01 | Corrigido                          | Template com relay nos dois firewalls e pools disjuntos. Relay respeita o membro ativo do VRRP.                                | O serviço DHCP ainda é uma instância única.                                                                                                             |
| D02 | Corrigido                          | Retorno WAN pelo VIP do trânsito; novas sessões sobrevivem à perda de FW-A.                                                    | Não replica sessões stateful existentes.                                                                                                                |
| D03 | Parcial                            | Preflight expõe dependências e instâncias únicas; testes de serviço indisponível e WAN.                                        | DNS/DHCP/MES/SCADA/broker e WAN não ganharam HA de dados/serviço.                                                                                       |
| D04 | Ensaiado; desenho parcial          | Cenário nativo e regressão desligam switch de célula e medem a interrupção/restauração.                                        | Endpoints e switch de célula permanecem pontos únicos; dois uplinks não eliminam o risco.                                                               |
| D05 | Corrigido                          | Template remove acesso WIFI→DMZ/80; testes negativos ao MES e PLC. Preflight avisa permissões de visitantes a zonas sensíveis. | Exceções futuras precisam de teste por destino.                                                                                                         |
| L01 | Implementado no subconjunto Modbus | Perfis PLC/HMI, MBAP/PDU, funções 03/06/16, registradores, exceções e testes de valores/persistência.                          | Hexadecimal sobre TCP textual; sem firmware/lógica física, coils ou demais protocolos industriais.                                                      |
| L02 | Fora do escopo escolhido           | RSTP/VRRP disponíveis e testados; limites de MRP/DLR/PRP/HSR visíveis na aplicação.                                            | Protocolos de anel industrial não implementados.                                                                                                        |
| L03 | Fora do escopo escolhido           | Deadlines e jitter de transações IP/Modbus mensuráveis; NTP mantém escopo próprio.                                             | PTP/TSN e agendamento determinístico não implementados.                                                                                                 |
| L04 | Implementado com aproximação       | Posições físicas em metros independentes do desenho e obstáculos 2D com perda explícita.                                       | Sem reflexão/difração ou certificação RF.                                                                                                               |
| L05 | Parcial                            | Polling periódico Modbus com taxa e deadline explícitos nos cenários.                                                          | MES/SCADA/NVR HTTP substitutos; processo produtivo e RTSP/H.264 não modelados.                                                                          |
| L06 | Limite explícito                   | Matriz de fidelidade no painel, docs e ADR distingue simulado/parcial/representado/não suportado.                              | Firmware real e integração com hardware não implementados.                                                                                              |
| L07 | Parcial                            | MQTT com usuário/senha, PUBLISH QoS 1, PUBACK, retransmissão DUP e tentativas limitadas.                                       | Assinaturas QoS 0; sem QoS 2, TLS, sessões persistentes ou reconexão automática.                                                                        |
| L08 | Limite explícito                   | Gerência L2 corrigida; matriz declara o subconjunto SNMP.                                                                      | SNMPv3 authPriv, traps e integração externa continuam pendentes.                                                                                        |
| L09 | Melhorado; codecs parciais         | Captura mostra retenção, exportáveis, omissões por motivo e descarte; origem de aplicação preservada.                          | Não exporta todos os protocolos nem Modbus binário interoperável.                                                                                       |
| L10 | Limite explícito                   | Preflight e matriz explicam firewall stateful de trânsito em roteador e ACL em switch L3.                                      | Restrição de capacidade do motor preservada.                                                                                                            |
| U01 | Parcial                            | Executor nativo ICMP/HTTP/Modbus com falhas, baseline, assertions, cancelamento, sete modelos e até 32 definições salvas.      | Os 42 casos foram migrados para regressão automatizada do motor; ações DNS/DHCP/MQTT/SNMP/NTP/syslog e persistência não estão todas no executor nativo. |
| U02 | Parcial                            | Zoom semântico para topologias acima de 20 dispositivos e reenquadramento ao entrar em tela estreita.                          | Sem autolayout, agregação de trunks ou vistas físicas/lógicas completas.                                                                                |
| U03 | Parcial                            | Template de fábrica, revisão/importação por diff, edição de endereços em lote e nomes únicos na duplicação.                    | Sem assistente completo de células com remapeamento simultâneo de IP/VLAN/MAC/referências.                                                              |
| U04 | Implementado com regras estáticas  | Preflight de IP, VLAN nativa, endpoints, links, relay, retorno físico de VRRP, SPOFs, RF e acesso de visitantes.               | Heurísticas; prova de política/disponibilidade exige tráfego e cenários.                                                                                |
| U05 | Parcial                            | Perda, p95/p99, jitter, deadlines, amostras e recuperação observada com resolução declarada; exportação e comparação.          | Não atribui automaticamente a causa de todos os eventos; relatórios do painel duram a sessão e podem ser exportados.                                    |
| U06 | Parcial                            | Diff antes/depois e aplicação validada/desfazível; histórico e proteção de revisão existentes preservados.                     | Sem RBAC de equipe ou edição simultânea autoritativa.                                                                                                   |
| B05 | Corrigido; novo achado             | Dois relays em VRRP produziam ofertas concorrentes e NAK contínuo; somente o membro ativo encaminha o broadcast.               | Cobertura S10/S19/S38: concessão normal e após failover.                                                                                                |
| B06 | Corrigido; novo achado             | Canvas podia ficar vazio após resize desktop→mobile; reenquadramento na mudança de faixa responsiva.                           | Topologias grandes continuam exigindo zoom/localizador em telas pequenas.                                                                               |

## Prioridades remanescentes

- **P1 — Disponibilidade do desenho:** definir SLA por fluxo e implementar a HA necessária de serviços, WAN e acesso de célula, com sincronização/consistência verificáveis. Os ensaios atuais demonstram o impacto do desenho existente.
- **P1 — Workloads e executor:** expandir as ações nativas para serviços/energia e a matriz completa; modelar processo ou vídeo somente quando esses workloads fizerem parte do caso alvo.
- **P2 — Operação e equipe:** clonagem integral de células, autolayout/vistas, colaboração/RBAC e conservação de relatórios no backend.
- **Condicional ao requisito:** MQTT QoS 2/TLS/sessões, SNMPv3/traps, Modbus binário interoperável, protocolos de anel industrial, PTP/TSN e emulação de firmware.

Contratos técnicos e limites: [ADR-042](../../../docs/adr/042-factory-modbus-scenarios-remediation.md). A auditoria original e seu plano permanecem como registros históricos, sem reescrever as evidências anteriores.
