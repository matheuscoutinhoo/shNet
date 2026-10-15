# ADR-049 — NICs e caminhos de acesso redundantes

Data: 14/10/2026. Contrato em qualificação: `2026.10.14.2`. Snapshot 1 e migration 011 preservados.

## Comportamento

Hosts PC/servidor, incluindo perfis PLC/HMI, podem receber NICs Ethernet adicionais e um bond ativo/backup com duas a oito interfaces. O grupo mantém IP, MAC, DHCP, IPv6 e conexões TCP na interface lógica; somente uma NIC transmite dados. A primária volta a ser preferida quando elegível. Interfaces ocupadas por outros grupos, políticas, DHCP/IPv6 ou serviços incompatíveis são recusadas. O IPv4 estático da primária pode migrar ao grupo. A remoção exige liberar configuração, referências e cabos.

O carrier identifica perda local de NIC/cabo/switch. O monitor opcional envia ARP por cada membro, com MAC físico e origem `0.0.0.0`, evitando aprender o MAC do bond pelo caminho de reserva. O alvo precisa responder no domínio L2. O intervalo padrão é 1 s e o timeout 3 s; esse timeout determina a detecção de uma falha além do carrier. Não se promete detecção de um destino diferente do alvo observado. A troca anuncia IPv4 e IPv6; anúncios ARP atualizam entradas já conhecidas sem aprender anúncios não solicitados de todos os vizinhos.

O modelo se inspira no modo active-backup e no monitoramento descritos pela [documentação do Linux bonding](https://docs.kernel.org/networking/bonding.html). Não implementa todos os modos de bonding ou protocolos de redundância industrial.

## Operação e persistência

A aba **Redundância NIC** instala/remove NICs, configura membros/primária/monitor, mostra elegibilidade e última resposta e abre a configuração IP da interface lógica. Cabos só se conectam aos membros físicos. A clonagem remapeia membros e alvo ARP e reinicia a saúde observada. Snapshots persistem timers, anúncios e sondagens em trânsito; timers ausentes, duplicados ou inconsistentes são recusados.

O modelo nativo **PLC/HMI com acesso e alimentação A/B** inclui oito equipamentos: dois endpoints, dois switches, duas UPS e dois racks. Os endpoints recebem ambas as fontes; cada switch recebe sua própria fonte. Há presets de baseline e perda/retorno de cada rack. Uma falha de rack desliga explicitamente os equipamentos desse domínio: desligar a estrutura de montagem não representa destruição dos equipamentos. Os modelos históricos de fábrica/enterprise conservam seus casos negativos e ainda precisam das variantes completas de HA de serviços previstas em R08.

## Aceite e limites

Os testes cobrem continuidade da mesma conexão echo e Modbus TCP binária, IPv6, renovação DHCP com a mesma identidade, perda/retorno de switch, uplink sem perda de carrier, perda dos dois acessos, migração ARP, clonagem, restauração determinística, configuração inválida e exclusão de NIC. Os três presets nativos são executados no motor e seu resultado final passa pela validação de snapshot. O navegador exercita configuração pelo formulário, failover, ping, salvar/reabrir e mobile.

Esse incremento não replica o processo PLC nem o estado de serviços entre endpoints diferentes. Falha do endpoint e perda dos dois acessos interrompem o fluxo. Não se anuncia garantia de disponibilidade de todo o modelo enterprise/fábrica por adicionar um bond. A qualificação completa desta versão deve ser vinculada aos relatórios da regressão/CI, sem reutilizar hashes do contrato anterior.
