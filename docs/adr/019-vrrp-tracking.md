# ADR-019 — Tracking de interface e rota no VRRP

Status: implementado.

Um roteador pode permanecer ligado na LAN mesmo depois de perder o uplink. Cada grupo VRRP aceita até oito objetos de tracking, de interface ou destino IPv4. Um objeto indisponível subtrai seu decremento da prioridade configurada; o mínimo efetivo é 1. O dono de prioridade 255 não aceita tracking.

Tracking de interface verifica energia, estado administrativo e carrier; interfaces lógicas consideram parent/VLAN. Tracking de rota consulta a FIB da tabela padrão e o enlace de saída; não transmite um probe de disponibilidade remoto. Assim, perder uma rota BGP ou o carrier de um uplink pode reduzir a prioridade, mas perder um serviço atrás de um próximo salto ainda alcançável não altera o tracking.

Anúncios e comparação de prioridade usam o valor efetivo. A alteração do tracking emite `VRRP_TRACK_CHANGED`, transmite imediatamente a nova prioridade no ACTIVE e recalcula o skew/deadline do BACKUP. A recuperação permite preempt conforme a configuração do grupo. O mecanismo não replica sessões NAT/firewall nem elimina a possibilidade de split brain quando anúncios são bloqueados.

O snapshot conserva configuração e prioridade efetiva e recusa referências inexistentes, tracking duplicado ou valor efetivo incompatível. O painel permite editar linhas `interface Gi0/2 80` ou `route 203.0.113.5 80`; a CLI usa `vrrp 10 track interface Gi0/2 decrement 80` e `no` para remover. O template **Gateway atento ao uplink** mantém o primário ligado ao demonstrar failover por uplink.

Três testes adicionais verificam falha de carrier, HTTP/ping, recuperação, retirada de rota, persistência determinística, validação e CLI. O fluxo E2E Tracking verifica edição do painel, shutdown pela CLI, prioridade 70, backup ACTIVE, HTTP e save/reload mobile.
