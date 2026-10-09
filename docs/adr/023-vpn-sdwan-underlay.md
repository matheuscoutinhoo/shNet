# ADR-023 — VPN L3 e SD-WAN sobre underlay

Status: implementado como modelo educacional.

## Encaminhamento

Roteadores criam interfaces TunnelN com endereço próprio, peer, canal, chave, transporte e selectors de prefixos. HELLO/ACK autenticados percorrem UDP/4500, ARP, links, ACLs e NAT reais do modelo. A rota do underlay é resolvida somente pela WAN configurada, evitando dependência circular do overlay. ACK correlacionado ativa a interface e instala prefixos remotos com distância 200; rotas estáticas podem preferir outro caminho. Falha de carrier/dead timer retira a disponibilidade.

Frames IPv4/IPv6 internos são serializados canonicamente, cifrados com o mesmo mecanismo didático usado no rádio e encapsulados em UDP. Há verificação de integridade, sessão e janela de 64 sequências contra repetição. A origem responde à porta observada, permitindo PAT no roteador intermediário. MTU do túnel é limitada a 1400; não há fragmentação. IPv6 mantém sua MTU mínima de 1280. ACLs do túnel inspecionam o pacote interno; ACLs da WAN inspecionam UDP encapsulado.

## Seleção SD-WAN

Cada túnel mede RTT nas respostas aos probes de controle e perda nas tentativas expiradas, mantendo 16 amostras. Políticas ordenadas classificam destino IPv4, protocolo e porta. A preferência Internet/MPLS/LTE é aplicada entre túneis operacionais que anunciam o destino e cumprem o SLA. Fallback aceita caminhos fora do SLA; política estrita e ausência de caminhos bloqueiam o tráfego. Contadores e eventos identificam a decisão.

Um controller distribui políticas por UDP/5000 para edges identificados por site e chave. Solicitações, respostas, nonce e configuração via rede fazem parte do snapshot. Uma resposta só é aplicada ao pedido pendente correspondente. Políticas recebidas permanecem em cache após indisponibilidade do controller. Configuração manual continua disponível.

Painéis, CLI, templates VPN/SD-WAN, inspeção de PDU e save/load usam os mesmos contratos. Validação recusa referências, timers, sequências e estados inconsistentes. Cópias no canvas preservam os túneis desabilitados; endereços físicos devem ser configurados antes da ativação.

## Evidência e limites

Testes cobrem ping/HTTP, IPv6, autenticação, replay/corrupção, PAT, ACL da WAN, MTU, falha/reconvergência, SLA estrito/fallback, controller, CLI e restauração determinística; a API valida snapshots em negociação. E2E verifica configuração, HTTP, failover, PDU e persistência desktop/mobile.

A [RFC 3948](https://www.rfc-editor.org/rfc/rfc3948) é referência para o conceito de encapsular ESP em UDP e atravessar NAT. Este modelo usa mensagens tipadas próprias: não implementa IKE, ESP/AH, AES, certificados, negociação de algoritmos, PFS/rekey ou interoperabilidade IPsec. O identificador `ipsec` representa uma VPN didática, sem garantia criptográfica. MPLS e LTE na política são classes de transporte; não tornam o enlace automaticamente uma rede MPLS ou um rádio celular. Seleção é por pacote, sem garantia de ordenação de um fluxo após mudança de SLA. Não há controller externo, BFD, balanceamento ponderado, steering IPv6 ou UDP IPv6. Nenhum socket real é aberto.
