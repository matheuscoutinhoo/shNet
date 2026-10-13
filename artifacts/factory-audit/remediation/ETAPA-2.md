# Etapa 2 — executor ampliado e ensaios persistidos

Data: 13/10/2026. Escopo: PLC/HMI com Modbus TCP e rede IP.

## Entrega

- Nove protocolos no executor: ICMP, HTTP, Modbus, DNS, DHCP, MQTT, SNMP, NTP e syslog.
- 17 modelos nativos, incluindo falhas/restauração de serviços e alimentação UPS. Falhas de porta e serviço configurado também podem ser definidas pelo usuário.
- Assertions de respostas DNS, concessões DHCP, publicação MQTT QoS 1 com recepção wildcard, varbinds SNMP, offset NTP e entrega syslog.
- Resultados persistidos no backend com cenário, tipo baseline/ensaio, revisão, topologia imutável e SHA-256 de origem.
- Reabertura, exportação, retry de gravação, cancelamento e exclusão de ensaios, com validação de dono do projeto, revisão e CSRF.
- Eventos de bloqueio por ACL/firewall/inspeção/IPS preservam o pacote correspondente. Amostras com falha incluem evidências e dispositivos observados no caminho.
- Resposta divergente não aprova um teste `deny`. Equipamento inválido ou operação que não inicia também não comprova bloqueio.
- Campos e textos longos do painel respeitam a largura móvel, incluindo o hash de origem.

## Verificação

Resultado consolidado: **677 testes aprovados, zero falhas pendentes e um ignorado**, em 72 arquivos. A suíte inicial de 678 casos apontou três falhas de IDS/IPS por uma referência incorreta ao pacote. Após corrigir, os cinco casos do arquivo `mesh-ids.test.ts` passaram. A consolidação substitui apenas o resultado desse arquivo; os demais resultados da suíte completa permanecem válidos. Evidência: `phase2-tests.json`, `phase2-ids-tests.json` e `phase2-validation.json`.

Build e TypeScript aprovados. A verificação da interface executou Modbus e MQTT, aguardou gravação no servidor e reabriu os dois resultados após recarregar o projeto. Nenhum erro JavaScript ou violação Axe nos estados exercitados. Relação medida no modo 5×: aproximadamente 0,989 do horizonte esperado. Viewport móvel de 390 px, sem overflow do corpo; o histórico expandido também cabe no dialog. Evidências em `ui-results.json`, `scenarios.png` e `mobile-reports.png`.

Lint, formatação e diff aprovados. A verificação final de API e cobertura do executor também passou (`phase2-report-tests.json`), incluindo rejeição de perda, percentis e jitter incompatíveis com as amostras. O resultado consolidado utiliza a última execução de cada arquivo.

A migration 008 cria `scenario_runs` e deve ser aplicada antes de servir as novas rotas. O caminho normal de inicialização já executa as migrations.

## Pendências mantidas

HA de serviços/WAN/células e sessões de firewall; transporte Modbus binário interoperável; ações de checkpoint/restauração e todos os 42 casos pela interface; colaboração/RBAC e ferramentas de desenho em escala. A recuperação continua observada por polling e não fornece instante exato de disponibilidade. Correlação usa evidência retida; timeout não identifica sozinho a causa. Relatórios são calculados pelo navegador e não reexecutados pelo servidor.

O teste PostgreSQL externo de backup/restauração continua ignorado por ausência de `TEST_DATABASE_URL`. O build ainda alerta para chunks acima de 500 kB. O [backlog atualizado](../../../docs/factory-remediation-backlog.md) e o [ADR-043](../../../docs/adr/043-scenario-protocols-persistent-reports.md) detalham contratos e próximas fases.
