# ADR-034 — Desafios, pontuação e tutorial interativo

## Decisão

O botão Desafio abre um editor com objetivos, pesos, dicas e predicados de rede. O formulário permite selecionar equipamentos/interfaces e importar ou editar JSON. O vocabulário é fechado: quantidade de equipamentos, enlace, IPv4, VLAN, DHCP, rota, ping IPv4/IPv6, TCP echo, HTTP e DNS/DNSSEC. Não há execução de código enviado pelo usuário.

Uma definição possui de 1 a 16 objetivos, pesos de 1 a 20 e referências validadas. Salvar captura a topologia inicial e exige revisões otimistas da definição e do projeto. Reiniciar restaura essa topologia; editar os objetivos invalida os resultados e pontos anteriores.

A avaliação acontece na API sobre uma cópia independente do motor. Cache ARP/DNS, conexões, leases e estados de protocolo são reiniciados, preservando configurações e criando tráfego novo depois da convergência. Um resultado ICMP negativo exige rejeição de protocolo: timeout não aprova bloqueio. Trabalho é limitado a 24 equipamentos, 48 conexões, 128 regras ACL e orçamento de eventos.

A pontuação de cada desafio é floor(100 × pesos aprovados / pesos totais). O melhor resultado é mantido; tentativas repetidas não somam pontos. Labs internos contam seu melhor resultado por lab, mesmo se houver vários projetos do mesmo lab. Desafios contam por projeto/definição atual. Tutorial conta uma vez pelo melhor progresso entre projetos. O dashboard mostra o total e sua distribuição.

O tutorial acompanha cinco etapas: equipamentos, cabos, endereçamento, ARP/ICMP e TCP. O cartão deixa a topologia acessível, oferece dicas e abre a área da etapa. A verificação exige os pré-requisitos anteriores e salva a etapa no backend. PCs podem servir echo TCP para o exercício; outros serviços seguem as restrições do equipamento.

## Persistência e integração

Migrations 004/005 armazenam definições, baseline, resultado, melhor pontuação e etapa. A API exige ownership/CSRF e valida os resultados no servidor. Os contratos estão no OpenAPI. A restauração do baseline atualiza a revisão do controller web, encerra execução e limpa undo/redo para evitar conflito com a versão antiga.

## Limites

Pontuação é progresso privado de aprendizagem; não há ranking público, compartilhamento, avaliação de terceiros ou recursos de conta novos. O tutorial inicial cobre uma LAN; desafios avançados continuam disponíveis nos 23 labs e no editor declarativo.

## Evidência

Testes verificam pesos, novo tráfego após quebrar o enlace, preservação da topologia original, rejeição de scripts/referências, transporte IPv6, sequência do tutorial, persistência, ownership, revisão, reinício, melhor resultado e impossibilidade de enviar uma pontuação fabricada.
