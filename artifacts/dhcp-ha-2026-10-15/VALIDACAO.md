# DHCP ativo/reserva — 15/10/2026

Contrato em qualificação: `2026.10.15.6`. Esta etapa implementa parte de R08 e não encerra alta disponibilidade de todos os serviços.

O [modelo importável](dhcp-ha.shlab.json) e [replication.json](replication.json) são produzidos por `npx tsx scripts/verify-dhcp-ha.ts`. Os seis checkpoints cobrem concessão confirmada, partição e promoção obsoleta recusada, troca com desligamento do antigo ativo, T2/novo cliente sem colisão, retorno como reserva, retomada determinística e failback administrativo. O arquivo registra contrato, hash da fonte, limites e eventos. Falhas são aplicadas exclusivamente à rede simulada.

Os testes exercitam também confirmação perdida, resposta tardia, RELEASE/DECLINE, fila de 128 respostas e uma transferência em voo sob rajada de 150 clientes, clonagem, preflight e shell. O teste de navegador configura o par, obtém uma concessão, promove a reserva, confere o desligamento do antigo ativo e a persistência após reabrir, além do layout mobile nos dois temas.

O canal de réplica é um modelo de estado com perda/latência/jitter do enlace, sem codec de fabricante ou exportação PCAP. Promoção é administrativa com controle de energia simulado; não implementa witness/quorum ou eleição automática. Depois da promoção, a operação sem segunda cópia é explícita até resincronizar. T1 pode falhar até T2 localizar o novo endereço físico de servidor. [Decisão e limites completos](../../docs/adr/054-dhcp-replication-and-administrative-fencing.md).

Resultados finais de regressão, navegador, CI e deploy serão registrados após a conclusão dos gates; produção permanece na última versão verificada até então.
