# ADR-045 — Sincronização de firewall/NAT e continuidade de sessões

Data: 2026-10-13. Contrato do motor: `2026.10.13.5`. Complementa o ADR-044 e atende R09 no escopo TCP/UDP/ICMP e NAT/PAT básico.

## Comportamento

Dois roteadores podem formar um par com portas físicas dedicadas e cabo direto. O mapeamento explícito traduz IDs de interfaces entre os membros, incluindo subinterfaces com IDs diferentes. A configuração é recíproca e atômica; referências inválidas, VRFs/papéis NAT incompatíveis, interface usada para dados ou políticas/pools diferentes são recusados sem limpar o par anterior.

Mutações de sessão e bindings produzem revisões no relógio determinístico. O canal transporta cópias sujeitas a energia, estado administrativo, disponibilidade do cabo, perda, latência, jitter e tempo estimado de serialização. Cada registro mantém no máximo uma atualização em trânsito por direção. Uma reconciliação a cada segundo virtual tenta as revisões que o peer ainda não recebeu; tráfego contínuo não adia uma atualização que já foi enviada. Revisões antigas não sobrescrevem estado mais recente.

São copiados tuples, protocolo, estado TCP, sequências/ACK/FIN, IP/porta global PAT e prazo original de expiração. Receber uma réplica não renova sua validade. Timers usam prazos absolutos, evitando diferenças de ponto flutuante na validação e restauração. Reset de política e RST propagam remoções; a expiração local de uma cópia desatualizada não apaga uma sessão renovada no outro membro. Tombstones conservam a validade original para impedir ressurreição durante reconciliação.

A política equivalente do destino continua necessária. Colisões de tuple ou porta PAT e limites de recursos recusam o update e geram evento. ACLs e regras deny continuam aplicadas ao tráfego. Com VRRP na interface outside, apenas o membro ACTIVE responde ARP por endereços NAT e usa o MAC virtual para esses endereços; o retorno acompanha a troca de gateway. Os gateways VIP e IPs globais NAT continuam distintos.

Os templates de fábrica e enterprise/DC incluem o canal p2 entre FW-A/FW-B. A aba **Políticas** configura/desativa o par e informa disponibilidade, atualizações pendentes, enviadas, recebidas e recusadas. **Enlace disponível** não significa que todos os registros foram recebidos. O preflight informa ausência do par, indisponibilidade, políticas divergentes, pendências, recusas e recursos fora do escopo. A timeline filtra eventos **Sincronização HA**.

Na CLI, `show ha state-sync` consulta o estado; `ha state-sync configure PEER JSON` configura ambos os membros no modo global. O JSON contém `portA`, `portB` e `mappings: [{a,b}]`. `no ha state-sync` desativa o par. `show running-config` conserva os IDs e portas concretos. Desativar conserva as sessões já existentes até seus timers; remover um membro limpa referências e ações HA do outro.

## Limites

É um modelo explícito de canal e estado, sem protocolo binário de fabricante, autenticação/cifra do canal ou frames PCAP de sincronização. Não representa um cluster real ou fencing. VRRP sozinho não copia estado e pode entrar em split brain se seus anúncios forem bloqueados. A replicação assíncrona pode perder continuidade quando uma falha ocorre antes da cópia ou quando o retorno chega antes dela.

São permitidos 1024 sessões de firewall, 1024 bindings NAT e 4096 metadados por membro. Colisões durante partição são recusadas e precisam de intervenção; não há reconciliação automática de duas aplicações de negócio divergentes. Não são replicados fluxos da inspeção HTTP/DNS, hairpin, SIP ALG, tabelas ARP, serviços, banco, leases DHCP ou estado MQTT. Não há VRRP IPv6. As sessões IPv6 usam o mesmo canal, mas a redundância de rotas IPv6 exige configuração própria.

## Aceite

Os testes cobrem continuidade com a mesma conexão, PAT e retorno assimétrico, failback, UDP/ICMP/IPv6, perda e recuperação do canal, falha antes de copiar, conflito PAT, expiração, remoção, CLI e checkpoint com entrega pendente. O ensaio nativo enterprise/DC conserva `before|after|failback|` em ERP e WAN/PAT. A fábrica conserva a mesma conexão Modbus binária para leitura, escrita após failover e leitura após failback, com transações 1/2/3 e registro 777.

O teste visual identificou avisos e tentativas de desenhar cabos antes da medição dos novos handles na troca de zoom. O canvas atualiza essa medição e conserva apenas enlaces com os dois pontos prontos, incluindo a passagem entre overview e detalhe. A regressão confere todos os 47 enlaces enterprise e 48 da fábrica, sem avisos, em desktop/mobile.

Evidências desta rodada: `artifacts/ha-remediation-2026-10-13`. O [plano consolidado](../consolidated-remediation-plan.md) mantém o saldo de HA de serviços e acesso em R08/R10.
