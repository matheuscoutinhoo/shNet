# ADR-044 — Integridade, fabric resiliente e Modbus binário

Data: 2026-10-13. Contrato do motor: `2026.10.13.4`. Atualiza os limites registrados nos ADRs 017, 025, 042 e 043.

A sincronização HA de firewall/NAT foi acrescentada no contrato `2026.10.13.5`, conforme [ADR-045](045-firewall-nat-state-synchronization.md). Os resultados e limites abaixo descrevem o incremento anterior.

## Decisões

- A política stateful de zonas cobre TCP, UDP e ICMP em IPv4/IPv6. NDP permanece local; ACL IPv6 de saída também é aplicada. Inspeção de conteúdo de aplicação ainda usa IPv4 e o preflight informa esse limite.
- Alterar uma porta RSTP preserva estados e timers das outras portas quando seus papéis permanecem iguais. Rotas de dados retiram interfaces inoperantes, conservando o diagnóstico de SVI sem porta operacional.
- Loopbacks IPv4 /32 fornecem identidade estável a VTEP e BGP `updateSource`. O encaminhamento e ARP usam a interface física escolhida pelo underlay operacional. O template enterprise/DC contém 38 dispositivos, 46 enlaces e dois caminhos de spine.
- `peerPolicy: evpn` usa membros IMET importados pelo RT e uma sessão BGP estabelecida. Não usa peers estáticos ou learning como fallback. Configurações antigas sem esse campo mantêm a política estática. O controle BGP continua tipado; IMET não transforma esse codec em MP-BGP binário. ESI/DF, multihoming, Type 5, proxy ARP, ECMP e BFD permanecem pendências separadas. Referência de IMET: [RFC 7432](https://www.rfc-editor.org/rfc/rfc7432.html).
- Um pool DHCP aceita `relayAddresses` adicionais para o mesmo domínio e mantém uma tabela de leases. O template permite renovação unicast UDP/67 e foi exercitado com failover, novo lease, T1 e rebind T2. Isso não replica leases entre servidores independentes.
- Alimentação A/B usa o OR das saídas solicitadas das UPS. Cada fonte reserva a potência nominal integral da carga; não representa a física de chaveamento.

## Cenários e relatórios

ICMP, HTTP e Modbus aceitam IPv6, VRF e escopo link-local. Os outros adaptadores recusam famílias/VRFs que não implementam. Há formulário básico, 30 presets enterprise/DC, aquecimento virtual opcional e assertions de energia, estado administrativo de porta, MTU, EAP, BGP, IMET, rota IPv4, VRRP, saúde de backend e memória Modbus. A cobertura nativa ainda não equivale à matriz histórica completa de 42 + 73 casos.

`actions` permite até quatro checkpoints e 16 ações, com limite agregado de 32 MiB. Um restore valida e restaura o snapshot completo, inclusive filas, timers, seed e captura. O tempo do ensaio continua avançando e cada amostra identifica sua época; tentativas em andamento são encerradas como interrompidas. O relatório registra relógios antes/depois e o hash do snapshot. O rollback de configuração com diff permanece no painel de revisão; não há ação programada de aplicação de patch.

Recuperação é recalculada a partir das amostras, inclusive `null`, observação e resolução. Trata-se de interrupção observada por fluxo: falhas concorrentes podem contribuir, e o intervalo de amostragem limita a precisão causal. `denyEvidence: policy` exige evento de política correlacionado; ausência de resposta isolada não aprova esse critério.

Os relatórios identificam execução no cliente. A API distingue validação das métricas de reexecução autoritativa. `POST .../scenario-runs/:run/verify` reexecuta a topologia e o cenário imutáveis em Worker do servidor, limitado a uma execução simultânea, 256 MiB e 20 segundos. Resultado igual é `matched`; divergência é `mismatch`; erro, timeout ou contrato diferente não recebem atestado. O hash da origem não substitui essa verificação. O manifesto local registra hashes do código e dos assets; `engineContract` é uma versão de comportamento e não é um hash de commit.

Runs sem conclusão expiram após 15 minutos quando consultados ou quando o laboratório é operado. Um resultado recuperado pode concluir um run expirado; cancelamento explícito continua definitivo. IndexedDB conserva resultados que não chegaram à API para retry após reabertura, com limites de tamanho e quantidade. Falha do armazenamento local é exibida ao usuário. Resultados antigos ficam identificados como não revalidados.

O executor mantém o mesmo limite de avanço virtual ao retomar uma fatia de processamento e atualiza o estado de controle uma vez por limite. Mesmo um orçamento de 1 ms processa pelo menos um evento devido; uma fatia curta não bloqueia indefinidamente o motor. A regressão compara relatório e snapshot completos em fatias de 1 e 100 ms. Presets arredondam o aquecimento quando o realtime produz relógios fracionários e toleram a remoção de equipamentos opcionais.

## Codecs e compatibilidade

TCP binário usa strings de octetos no snapshot JSON, com `encoding: binary`; sequências, MSS, retransmissão, SACK, PMTUD e checksums contam octetos. UTF-8 continua sendo o contrato dos serviços textuais. Modbus delimita ADUs pelo MBAP e trata fragmentação/coalescência, exceções e funções 01/02/03/04/05/06/15/16. Configurações antigas podem conter apenas holding registers. Conexões antigas hex/newline continuam legíveis; sua captura é excluída com motivo explícito. Referência das funções: [Modbus Organization](https://www.modbus.org/modbus-specifications).

PostgreSQL JSONB recusa U+0000, mesmo escapado. Valores que contêm esse escape são armazenados em envelope versionado de JSON UTF-8/base64; a camada do banco devolve o valor original. Projetos, versões, origens/relatórios e baselines usam o codec; a contagem de dispositivos continua correta. Bytes, barras literais e Unicode são preservados em API, reabertura e backup/restore. Snapshots exportados e hashes permanecem calculados sobre a representação original do motor. JSONs antigos sem envelope continuam legíveis.

VXLAN novo inclui header I/VNI, Ethernet interna e padding mínimo. Snapshots históricos sem padding continuam restauráveis, mas a exportação pode excluí-los em vez de inventar bytes. O Scapy confere as ADUs, VNI e checksums independentemente do decoder TypeScript. Referência de encapsulamento: [RFC 7348](https://www.rfc-editor.org/rfc/rfc7348.html).

## Validação e pendências

Evidências novas ficam em `artifacts/remediation-2026-10-13`; a auditoria anterior permanece histórica. A regressão cobre IPv4/IPv6, retorno UDP, adulteração, isolamento VRF/VNI, perda de spine, snapshots, UPS A/B, DHCP T1/T2, Modbus segmentado e checkpoints. PostgreSQL nativo isolado valida migrações e backup/restore de projetos, relatórios, hashes e autorização.

O [plano consolidado](../consolidated-remediation-plan.md) registra o saldo de cada frente. HA de dados e sessões, redundância de endpoints, fabric avançada, MQTT completo, equipe/RBAC, SNMPv3 e qualificação externa não devem ser anunciados como entregues por este incremento.
