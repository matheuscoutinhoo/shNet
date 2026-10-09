# ADR-016 — Gateway IPv4 redundante com VRRP

Status: implementado no simulador educacional.

## Problema e decisão

Um gateway físico único interrompia a comunicação entre sub-redes quando desligado. Implementamos grupos VRRPv3 IPv4 por interface: os hosts usam um IP virtual estável, anunciado pelo roteador ACTIVE; os demais participantes monitoram anúncios como BACKUP. A eleição depende de frames recebidos pela rede, sem consultar globalmente os candidatos.

O modelo acompanha [RFC 9568](https://www.rfc-editor.org/rfc/rfc9568.html): protocolo IPv4 112, multicast 224.0.0.18, TTL 255 e MAC virtual 00:00:5e:00:01:VRID. A maior prioridade vence; dois ativos de prioridade igual usam o maior IPv4 de origem. Prioridade 255 exige que o VIP seja o endereço físico da interface. Preempt é configurável, exceto pela inicialização imediata do dono.

O timeout de BACKUP é `3 × intervalo do ativo + ((256 − prioridade local) / 256) × intervalo do ativo`. Um anúncio de prioridade zero reduz a espera ao skew time. Intervalos diferentes são aceitos e registrados. O ACTIVE envia anúncio imediato ao receber um anúncio de prioridade menor para corrigir o aprendizado Ethernet.

## Implementação e persistência

`vrrp-model.ts` define configuração, pacote tipado, estados INIT/BACKUP/ACTIVE e timers. `vrrp.ts` contém eleição, anúncios, carrier, propriedade do MAC/IP e validação. `configureVrrp` preserva grupos não alterados e reinicia apenas os modificados; desligamento administrativo de um ativo transmite prioridade zero quando o enlace está operacional.

Cada grupo ACTIVE/BACKUP mantém exatamente um timer serializável, ligado à interface, VRID e token. INIT não possui timer. Snapshot v1 conserva grupos, anúncios em trânsito, contadores, deadlines e sequência determinística; os campos são opcionais para snapshots antigos. Timers órfãos, duplicados, vencidos ou incompatíveis são recusados.

Somente o ACTIVE responde ARP pelo VIP, usando o MAC virtual. A transição envia ARP gratuito para mover o MAC aprendido no switch. Esse anúncio não recebe resposta dos participantes, evitando que a porta antiga reaprenda o MAC durante uma troca. Requests ARP originados pelo dono também usam MAC virtual. Os caches dos hosts continuam válidos até a expiração normal. BACKUP descarta frames destinados ao MAC virtual; pacotes IP dirigidos diretamente ao VIP são descartados no não dono. O VIP funciona como gateway; apenas o dono ACTIVE atende serviços locais nesse endereço.

VRRP passa pelos mesmos enlaces, perdas, VLANs, STP e ACLs que outros pacotes. ACL aceita `vrrp`; NAT/firewall de trânsito não criam sessões para os anúncios de controle. Conflitos de VIP com globals NAT são recusados. Transições podem gerar syslog automático. O painel permite criar, editar, excluir e desativar grupos; o terminal e running-config representam a mesma configuração.

## Limites

- Apenas IPv4, VRRPv3 e um VIP por grupo; até 32 grupos por roteador.
- Interfaces routed com IPv4 estático /1 a /30; VRID 1–255, intervalo de 100–10000 ms em passos de 10 ms.
- PDUs tipados, sem codificação binária, checksum, autenticação ou interoperabilidade com sockets/equipamentos reais.
- Tracking de uplink/rota entregue em ADR-019. Sem HSRP, Accept_Mode configurável, múltiplos VIPs, IPv6 ou sincronização de sessões NAT/firewall.
- Falhas de anúncio por ACL/VLAN/perda podem produzir split brain. Isso aparece no estado; não há prevenção global artificial.
- Grupos em interfaces diferentes elegem independentemente. A seleção de rotas conectadas depende do estado administrativo da porta; tracking opcional de uplink/rota está disponível (ADR-019). As rotas de apoio do template atendem shutdown administrativo de uma porta.
- Protocolos periódicos usam `advanceTo` com horizonte e orçamento; `run` não deve tentar drenar indefinidamente anúncios recorrentes.

## Validação

Testes verificam eleição, empate, dono, preempt, prioridade zero, VLAN/ACL, retomada com ARP conservado, MAC no switch, ping/HTTP após falha, shutdown por interface, anúncios inválidos, intervalo remoto, persistência determinística, timers e CLI. A API salva/reabre eleição pendente e recusa VIP/timer inválidos; o fluxo E2E exercita edição, failover, HTTP, packet inspector, persistência e viewport mobile.
