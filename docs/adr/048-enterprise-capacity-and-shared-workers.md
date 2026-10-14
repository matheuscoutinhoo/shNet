# ADR-048 — capacidade enterprise e módulos compartilhados de execução

Data: 14/10/2026. Contrato do motor: `2026.10.14.1`. Migrations: 011.

O usuário solicitou concluir os dois P2 de capacidade concorrente e tamanho dos bundles, depois retomar as frentes R08/R10/R17–R20/R25. R24 de colaboração de equipes e os requisitos condicionais R29/R30 continuam fora desta etapa. A homologação operacional permanece na CI isolada; produção Railway recebe apenas verificações de leitura.

## Workers e identidade

Os Workers de simulação e cenários são entradas de módulos no mesmo grafo de build do editor. O código comum do motor é transferido uma vez e reutilizado pelo cache. O entrypoint `@shlab/engine/runtime` evita importar o catálogo de templates e laboratórios por conveniência. O desenvolvimento conserva o carregamento de Workers pelo Vite.

O build medido tem 2.403.216 bytes de JavaScript/CSS, ou 635.759 bytes em Brotli. O anterior tinha 4.237.887 e 1.103.209 bytes, respectivamente: redução de aproximadamente 43%. O motor compartilhado ainda tem cerca de 904 kB descomprimidos. Os pequenos arquivos de entrada dos Workers não representam todo o seu código nem seu custo de heap; cada contexto executa sua própria instância.

A identidade de execução passa a ligar o entrypoint e todos os módulos transitivos com SHA-256, em manifesto ordenado. O descobridor acompanha os nomes com hash emitidos pelo bundler. Dependência ausente, grafo excessivo ou origem externa são recusados. Workers históricos de arquivo único conservam o hash dos próprios bytes. API, cliente e verificador remoto usam a mesma regra; modificar só o motor compartilhado altera a identidade do ensaio.

## Convergência e custo por evento

O novo campus de 2.000 equipamentos reproduziu uma multiplicação de BPDUs antes de completar a convergência inicial. O motor agora coalesce notificações durante `tcWhile`, preserva a limpeza das tabelas MAC, propaga TC à raiz e limita rajadas a seis BPDUs por segundo/porta/instância. Anúncios adiados são reconstruídos com a informação atual e seus timers são persistidos e validados. Informação inferior recebida numa porta designada recebe a resposta superior local; mudanças do vizinho de raiz continuam aceitas.

O comportamento se baseia nas descrições oficiais de [RSTP](https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/24062-146.html) e [transmit hold-count](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/lyr2-fwd/stp/stp-configuration-guide/m-stp.html). A implementação continua um modelo de simulação, sem alegar equivalência integral ao firmware.

A primeira CI passou em regressão, containers e capacidade, mas o navegador encontrou uma segunda mudança de caminho dentro de `tcWhile`. A correção conserva a notificação desse novo caminho até a raiz, sem eco para a porta de recepção, e remove imediatamente MACs de uma porta local bloqueada/desconectada. A limpeza respeita os outros escopos PVST/MSTP. O caso original do navegador passou localmente sem aumentar seu orçamento de 64 eventos; a nova CI precisa concluir os dois temas antes da promoção.

Expiração de MAC/ARP/DNS acompanha o próximo prazo e os aprendizados antecipam esse prazo. Refresh de STP acompanha expirações e mudanças de carrier; BGP acompanha alterações de configuração, rotas, transporte e acesso. Fronteiras públicas invalidam os caches para reconhecer edições em memória. O índice de conexões de captura evita buscar em todas as conexões por frame. O estado final é comparado à execução que faz refresh a cada evento, incluindo perda de core, além dos testes de convergência, failover e restore.

## Concorrência da API

Snapshots com mais de 200 dispositivos ou 1 MiB de JSON são validados em dois Workers compartilhados pelas instâncias de API do processo. A admissão limita o total a 32 tarefas e 128 MiB de JSON pendente; cada Worker tem limite de heap de 256 MiB e validação ativa de até 30 segundos. Saturação ou interrupção produz 503 recuperável; nenhum projeto é parcialmente salvo. Ownership e revisão são conferidos antes da validação cara e o UPDATE mantém a condição de revisão para cobrir alterações concorrentes.

O ensaio cria e remove seu próprio banco em PostgreSQL de testes em loopback. Usa HTTP/WebSocket reais, duas instâncias lógicas de API e um processo separado de clientes. Testa 20 donos, três rodadas de salvar/reabrir/listar, revisão obsoleta, acesso de outro dono e notificações entre instâncias sem cruzar donos. Não autentica usuários reais nem usa o banco de produção.

Nos perfis locais de 500 e 2.000 dispositivos por projeto, todos os saves/reaberturas/listagens passaram. O perfil de 2.000 teve p95 de save de 21,3 s, heap principal após GC entre 67,6 e 67,8 MiB e RSS de até aproximadamente 996 MiB, incluindo Workers. Atraso de event loop chegou a p95 de 516 ms. Esses resultados quantificam a capacidade deste hardware e carga; não certificam a capacidade do plano Railway nem latência de 20 navegadores simultâneos.

## Carga de simulação e gates

`npm run benchmark:enterprise` cobre 100, 500 e 2.000 dispositivos sobre o template enterprise/DC nativo, com RSTP, VRRP, firewall/state sync, DNS, BGP/EVPN e HTTP. Cada perfil tem três repetições com 20 clientes concorrentes: 126 respostas HTTP e 120 consultas DNS bem-sucedidas, incluindo hits de cache. Após desligar FW-A, 20 novas requisições são verificadas após seis segundos virtuais de espera. Isso testa recuperação nesse ponto de observação, sem medir o primeiro instante de recuperação ou continuidade das mesmas sessões TCP.

O perfil de 500 rodou a 0,98–1,12×; o de 2.000 a 0,23–0,28×. O p95 da fatia completa de 2.000, incluindo delta/JSON, chegou a 177 ms apesar do orçamento de processamento de 100 ms. O orçamento é cooperativo; não interrompe um evento ou a serialização. Os ramos adicionais de acesso conservam SPOFs explícitos. R10 trata redundância de endpoints e não é declarado concluído por este benchmark.

A CI adiciona gate de capacidade com PostgreSQL 18 e os dois tamanhos de projetos concorrentes. O navegador também verifica o build de produção com Workers de módulos, autosave, recuperação e replay com identidade. Relatórios locais e da CI ficam separados em `artifacts/capacity-and-services-2026-10-14`. O aceite operacional inclui regressão, dois temas de navegador e containers; scripts preparados não são usados como prova de execução.
