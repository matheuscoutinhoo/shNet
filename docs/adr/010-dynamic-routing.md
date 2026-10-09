# ADR-010 — OSPF e RIPv2 na rede simulada

Status: implementado no escopo educacional abaixo.

Cada roteador calcula rotas a partir de mensagens recebidas pelas suas interfaces. OSPF usa IPv4/protocolo 89; RIPv2 usa UDP/520. Os anúncios percorrem Ethernet, VLANs, STP, MTU, perda e ACL. Não há consulta à topologia global para descobrir destinos ou próximos saltos. A observação local de carrier usa o modelo físico já existente.

OSPF mantém vizinhos, descrições paginadas da base, solicitações, LSAs, confirmações e retransmissões. Router LSAs e Network LSAs formam o grafo SPF com enlaces recíprocos. Summary LSAs permitem trânsito entre áreas através da área 0. Redes broadcast elegem DR/BDR por prioridade e router ID, mantendo DROTHER em 2-Way. O next hop único é escolhido de forma determinística. A troca de banco usa um protocolo conceitual com páginas e resposta explícita; não implementa a negociação master/slave binária completa da RFC.

RIP mantém o melhor vetor recebido por prefixo, anuncia mudanças e atualizações periódicas, aplica split horizon com poison reverse opcional e retira rotas por infinito/timeout. Redes conectadas têm custo 1; o receptor soma 1. A coleta de uma rota inválida não é adiada por anúncios repetidos de infinito. Anúncios periódicos e triggered updates usam jitter derivado da seed.

As rotas dinâmicas permanecem separadas da configuração estática. O encaminhamento compara comprimento do prefixo, distância administrativa e métrica: conectado 0, estático 1, OSPF 110, RIP 120. Não há redistribuição automática entre os protocolos.

Configurações, bases, tabelas e timers são opcionais no snapshot v1, preservando a leitura dos projetos anteriores. Importações passam por validação referencial; OSPF verifica também se as rotas correspondem ao SPF da base local. Campos novos não são compatíveis com leitores antigos. Não há alteração de DDL.

O relógio de manutenção tem resolução de 1 s virtual. Configurações reiniciam o processo local. OSPF limita vizinhos a 256, LSAs a 1024 e rotas selecionadas a 1024; RIP limita a tabela a 1024. São modelos de ensino com limites explícitos, sem autenticação de anúncios ou interoperabilidade com equipamentos externos. Fidelidade e comandos estão em [protocols.md](../protocols.md).
