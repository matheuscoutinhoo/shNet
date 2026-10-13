# Plano de correção e evolução da simulação de fábrica

Base: auditoria de 43 equipamentos, 47 enlaces e oito VLANs, com 42 cenários e 50 testes de regressão selecionados aprovados. Este plano cobre os 26 achados de RELATORIO.md. Não representa alterações já executadas na aplicação.

## Prioridades e decisões

- **P1:** compromete a execução, as evidências, a segurança, a disponibilidade ou a representatividade industrial. Deve preceder a expansão geral do produto.
- **P2:** melhora operação, fidelidade, acessibilidade e colaboração. Correções pequenas podem ocorrer em paralelo às fases P1.
- Não foi atribuído P0: a auditoria não demonstrou incidente de produção ou risco imediato em uma fábrica real.
- D01 e D02 já foram corrigidos no cenário final. O trabalho restante é incorporar a configuração correta aos templates, às verificações e à regressão da aplicação.
- O01 exige diagnóstico: houve perda do primeiro probe após falhas de distribuição/energia e sucesso em uma tentativa posterior. A causa e a duração exata da indisponibilidade ainda não foram medidas.
- Os limites industriais não são todos bugs. A implementação deve seguir os protocolos e SLAs da fábrica alvo; não é necessário desenvolver todos os protocolos industriais simultaneamente.

## Fase 0 — Fixar o contrato de simulação e os critérios de aceite

**Prioridade:** P1. **Saída:** especificação curta e matriz de cenários versionada.

1. Definir o significado de velocidade, tempo real e tempo virtual; escolher tolerância de sincronismo e orçamento de processamento.
2. Definir por fluxo os requisitos de disponibilidade, perda, latência, jitter e convergência. A meta inicial de recuperação de 5 segundos deve ser confirmada como requisito do laboratório, não tratada como característica já comprovada.
3. Separar fluxos IP demonstrativos de fluxos industriais efetivamente modelados. Definir protocolos, volumes, periodicidades, garantias MQTT e necessidades de sincronismo da fábrica alvo.
4. Preservar o cenário final e as evidências como referência; estabelecer os 42 cenários como candidatos à regressão, com resultados esperados explícitos.

**Aceite:** cada cenário tem precondições, estímulo, janela de observação e resultado esperado; cada limite do modelo está registrado. Essa definição não deve atrasar correções evidentes como B02, B03 e B04.

## Fase 1 — Corrigir execução e preservar evidências

**Achados:** B01, B02; primeira entrega de U05. **Prioridade:** P1.

**Corrigir/alterar:**

- Substituir a reprodução baseada apenas em quantidade de eventos por avanço até um horizonte de tempo virtual, respeitando orçamento de CPU e responsividade da interface.
- Estabelecer contratos distintos para reprodução didática e tempo real. Mostrar atraso, velocidade efetiva, tempo virtual e estado de processamento.
- Separar armazenamento de captura e resultados do buffer visual de eventos. Manter histórico por cenário/fluxo e avisar explicitamente sobre descarte ou truncamento.
- Preservar a origem temporal dos eventos para calcular perda, latência e convergência nas fases seguintes.

**Aceite:** no contrato proposto, 10 segundos reais em 5× correspondem aproximadamente a 50 segundos virtuais, dentro da tolerância aprovada; pausa continua responsiva. Um ping permanece com request/reply exportáveis após pelo menos 30 segundos virtuais de tráfego RSTP/VRRP. Limites de armazenamento são visíveis e testados.

**Dependência:** necessária para interpretar com confiança os testes de failover e os relatórios automáticos.

## Fase 2 — Corrigir disponibilidade, segmentação e gerenciamento

**Achados:** O01, D01, D02, D03, D04, D05, B03. **Prioridade:** P1; B03 é P2 e pode ser antecipado.

**Corrigir/alterar:**

- Instrumentar RSTP, VRRP, ARP e encaminhamento durante falhas, usando tráfego contínuo. Diagnosticar O01 antes de escolher a correção.
- Bloquear visitantes → MES por padrão; manter apenas exceções justificadas e verificar acessos necessários de TI, OT, DMZ e gerência.
- Incorporar aos templates o relay DHCP nos dois firewalls e a rota de retorno WAN pelo VIP, preservando as correções já feitas no laboratório.
- Remover os pontos únicos de falha exigidos pelo SLA: serviços, acesso WAN e switches de célula. Modelar a redundância possível e sinalizar o que o motor ainda não suporta.
- Testar separadamente perda de uplink, switch, firewall, alimentação, serviço e caminho WAN. VRRP sozinho não comprova continuidade de sessões stateful nem sincronização de dados.
- Corrigir a identificação do stack de gerenciamento em switch L2 com SVI: syslog e SNMP não devem exigir roteamento entre VLANs.

**Aceite:** visitantes não acessam MES; fluxos autorizados continuam funcionando. DHCP e WAN sobrevivem à perda de FW-A. Convergência é medida durante falhas de distribuição/UPS, com causa e perdas registradas. A falha do switch de célula é efetivamente injetada. Os SPOFs remanescentes são explícitos. Syslog/SNMP funcionam com SVI operacional e roteamento L3 desabilitado.

## Fase 3 — Implementar testes de cenários, preflight e relatórios

**Achados:** U01, U04, conclusão de U05. **Prioridade:** P1.

**Implementar:**

- Executor nativo com matriz origem/destino/protocolo, falhas agendadas, restauração, assertions e execução repetível.
- Preflight com avisos contextuais sobre SPOFs, IPs duplicados, referências inválidas, VLANs, rotas de retorno, relay DHCP e políticas de acesso.
- Relatório consolidado com disponibilidade, perda, latência p95/p99, jitter, convergência, causa e comparação entre baseline e cenário alterado.
- Exportação dos resultados e evidências, identificando versão do motor e configuração utilizada.

**Aceite:** os 42 cenários da auditoria têm cobertura automatizada equivalente ou uma justificativa explícita para os casos não suportados. Falhas esperadas passam como testes negativos; falhas inesperadas reprovam o cenário. O usuário executa e compara resultados pela aplicação, sem depender dos scripts externos da auditoria.

**Dependência:** usar a execução e a captura corrigidas na fase 1; incorporar os casos de disponibilidade e política da fase 2.

## Fase 4 — Implementar um modelo industrial utilizável

**Achados:** L01, L02, L03, L05, L07. **Prioridade:** P1 para a finalidade industrial; desenvolvimento incremental.

**Entrega 4A — Dispositivos, protocolos e cargas:**

- Criar perfis PLC/HMI e um protocolo industrial inicial selecionado conforme a fábrica. Modbus TCP é candidato ao primeiro incremento, mas o echo TCP na porta 502 atual não serve como validação de Modbus.
- Modelar operações, respostas, estados, ciclos e falhas de dispositivo/processo.
- Criar cargas representativas de SCADA/MES, sensores e vídeo, com taxas, periodicidades, bursts e classes de QoS configuráveis.
- Completar as garantias MQTT exigidas: QoS, duplicidade, reconexão, persistência, autenticação e proteção do transporte, com limites do modelo declarados.

**Entrega 4B — Redundância e tempo industrial:**

- Implementar os mecanismos necessários entre MRP, DLR, PRP e HSR; validar ruptura e recuperação sob carga contínua.
- Implementar PTP/TSN e cumprimento de deadlines somente quando exigidos pelo caso alvo. NTP não deve ser apresentado como equivalente.

**Aceite:** transações industriais verificáveis, deadlines/perdas mensuráveis, cenários de desconexão e reconexão e testes por protocolo. A aplicação distingue “representado”, “simulado” e “não suportado”. Não declarar validação integral da automação antes dessas entregas.

## Fase 5 — Melhorar operação, fidelidade e colaboração

**Achados:** B04, L04, L06, L08, L09, L10, U02, U03, U06. **Prioridade:** P2.

**Corrigir/alterar/implementar:**

- Corrigir a hierarquia de títulos e verificar navegação por teclado nos fluxos alterados; B04 pode entrar junto da fase 1.
- Melhorar zoom semântico, rótulos, organização de enlaces e vistas físicas/lógicas para topologias grandes.
- Adicionar assistente de fábrica, templates de células, edição em lote com diff e clonagem com remapeamento validado de IP/VLAN/MAC/referências.
- Separar coordenadas do desenho das coordenadas físicas usadas por RF; definir escala, materiais e obstáculos. Não apresentar esse modelo como estudo RF certificado.
- Publicar matriz de fidelidade e limitações por protocolo/dispositivo. Avaliar integração com emulação real quando o requisito justificar.
- Implementar SNMPv3, traps e integrações de gerência conforme necessidade; explicitar as capacidades de firewall de cada tipo de equipamento.
- Informar exclusões da exportação PCAP e ampliar os codecs prioritários, depois de corrigir a retenção em B02.
- Adicionar revisão por diff, papéis de acesso e histórico de alterações para colaboração; testar conflitos de edição.

**Aceite:** uma célula pode ser duplicada sem conflitos de endereçamento; os equipamentos e enlaces são identificáveis na visão geral; mover ícones não altera RF sem mudança física explícita; limitações/capacidades são visíveis; exportações informam omissões; revisão colaborativa mantém autoria e consistência.

## Ordem de execução e liberação

Sequência principal: **contrato mínimo → execução/captura → disponibilidade/segurança → cenários automáticos → modelo industrial**. A fase 5 pode avançar em paralelo, sem consumir a capacidade necessária às correções P1.

Dois marcos de liberação são recomendados:

1. **Laboratório IP confiável:** fases 1–3 aprovadas, com limitações industriais explícitas e regressão de DHCP, WAN, segmentação, captura e failover.
2. **Simulação industrial qualificada para o caso escolhido:** fase 4 aprovada para os protocolos, cargas e SLAs selecionados; não implica fidelidade universal nem certificação de equipamentos reais.

Prazos devem ser estimados após diagnóstico de O01 e escolha do escopo industrial. Os achados, isoladamente, não sustentam uma promessa de duração ou tamanho da equipe.

## Rastreabilidade dos 26 achados

| Fase | IDs |
|---|---|
| 1 | B01, B02, U05 (início) |
| 2 | O01, D01, D02, D03, D04, D05, B03 |
| 3 | U01, U04, U05 (conclusão) |
| 4 | L01, L02, L03, L05, L07 |
| 5 | B04, L04, L06, L08, L09, L10, U02, U03, U06 |

Todos os 26 IDs distintos estão cobertos. Evidências e critérios detalhados originais permanecem em RELATORIO.md e findings.json.
