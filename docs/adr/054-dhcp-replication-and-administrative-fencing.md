# ADR-054 — réplica DHCP e troca administrativa com fencing

Data: 15/10/2026. Contrato em qualificação: `2026.10.15.6`. R08 permanece parcial.

## Decisão

Dois servidores/roteadores podem formar um par DHCPv4 ativo/reserva, com pools equivalentes por nome e política e um cabo Ethernet físico dedicado sem IP. A reserva começa sem concessões próprias. Apenas o ativo responde ao DHCP. Ofertas, concessões, RELEASE e quarentenas DECLINE são copiados, com revisões monotônicas, timers de expiração, perda/latência/jitter do cabo e confirmação de volta. OFFER/ACK aguardam a confirmação da réplica; perder o canal ou a confirmação não autoriza uma resposta positiva.

O par usa no máximo uma transferência/confirmação integral do banco em voo e 128 respostas pendentes. Mudanças durante a transferência são agrupadas na revisão seguinte. Excesso de respostas produz evento explícito e exige retry do cliente. A resposta vence em 5 s. Os registros reservam o endereço por 30 s adicionais à duração anunciada, sem prolongar o lease do cliente; isso conserva margem para confirmação e entrega no modelo e retarda a reutilização. Não representa MCLT nem um protocolo de failover de fabricante.

`promoteDhcpHa` é uma operação administrativa do plano de controle da simulação: exige reserva ligada, habilitada, configuração equivalente e a revisão atual recebida; desliga o equipamento antigo antes de trocar os papéis e cancela transferências/respostas anteriores. Não deduz morte a partir de heartbeat. O novo ativo opera explicitamente sem segunda cópia até o retorno e a confirmação da reserva. O antigo ativo continua reserva ao religar; a volta administrativa exige resincronização. Se a última revisão não chegou à reserva, a promoção é recusada, mesmo com o ativo desligado: é necessário recuperar/sincronizar a origem.

A separação entre renovação unicast em T1 e rebinding broadcast em T2 segue a [RFC 2131, seção 4.4.5](https://www.rfc-editor.org/rfc/rfc2131.html#section-4.4.5). O endereço físico do servidor é preservado no lease: após a troca, T1 pode falhar e T2 encontra o novo servidor, mantendo o endereço do cliente. Não há VIP DHCP neste incremento. O uso de fencing explícito, em vez de inferir morte de um peer inacessível, tem referência conceitual no [Pacemaker Explained — Fencing](https://clusterlabs.org/projects/pacemaker/doc/3.0/Pacemaker_Explained/html/fencing.html). Nenhum agente STONITH real é executado.

## Aplicação e persistência

O painel DHCP oferece configuração, papel/estado/revisões e **Promover reserva e desligar [servidor]**. Alterar pools exige desfazer o par. Desfazer o par desativa o serviço da antiga reserva. Remover cabos/dispositivos limpa as entregas pertinentes. O preflight reconhece intervalos equivalentes do par, continua apontando sobreposição entre servidores independentes e informa ausência de eleição automática, sincronização pendente e operação sem segunda cópia.

O modelo nativo **DHCP com réplica e troca de servidor** contém cinco equipamentos e duas NICs dedicadas. Seu switch de acesso continua único, pois o ensaio isola HA do serviço; modelos completos de fábrica/enterprise com acesso/WAN A/B continuam em R08/R10. Snapshots preservam réplica e respostas em voo. Clonagem remapeia o par inteiro sem copiar leases; duplicar um membro não o associa ao par original. Contadores/revisões/quarentenas de execução não criam diff de configuração.

Shell: `show ip dhcp ha`, `ip dhcp ha configure DHCP-B {"portA":"nic0","portB":"nic0"}`, `ip dhcp ha promote-and-fence` e `no ip dhcp ha`. Configuração e promoção exigem modo de configuração e capacidade de servidor DHCP.

## Validação e limites

`tests/dhcp-ha.test.ts` cobre clientes simultâneos, rajada de 150 clientes com fila limitada, confirmação perdida, partição, resposta tardia, promoção com fencing, T2, novo cliente sem colisão, failback, RELEASE/DECLINE, restore, configuração inválida, remoções, clones, preflight e shell. O navegador cobre criação do par, concessão real, promoção, salvamento/reabertura e mobile nos dois temas. `scripts/verify-dhcp-ha.ts` produz topologia importável e seis checkpoints reproduzíveis e é obrigatório na CI.

O canal de réplica é um transporte de estado simulado, como o canal de firewall/NAT, sem codec de fabricante e sem exportação PCAP. O tráfego DHCP cliente/servidor conserva o modelo existente. Não há eleição automática, witness/quorum distribuído, DHCPv6 HA, replicação de outros serviços, TLS do canal ou qualificação de interoperabilidade externa. A redução da fila e os testes de rajada não certificam um SLA enterprise. O ambiente Railway real não recebe operações de fencing, restore ou rollback: todas as falhas descritas são da rede simulada.
