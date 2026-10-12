# ADR-038: plataforma escura e visualização de tráfego

Data: 2026-10-12. Estado: implementado e validado nos cenários abaixo.

## Aparência única da plataforma

Este redesign substitui a seleção Claro/Escuro/Sistema descrita no [ADR-037](037-platform-appearance-regression.md). A plataforma passa a usar somente o tema escuro. A preferência do sistema operacional, valores antigos de `shlab.appearance` e a indisponibilidade do armazenamento não alteram essa decisão. Não há seletor de aparência no acesso, nos laboratórios ou no workspace.

A identidade preserva o azul-marinho, o azul petróleo, o azul das ações e os acentos ciano/verde-água do shLab. As superfícies, divisórias, menus, dados e estados de interação recebem níveis distintos de contraste. Os acentos luminosos destacam atividade e seleção; mensagens de sucesso, atenção e falha continuam distinguíveis por texto, ícone e cor.

As referências visuais consultadas foram a [revisão de design do Linear](https://linear.app/now/behind-the-latest-design-refresh), as [diretrizes de interface da Vercel](https://vercel.com/design/guidelines) e a [página do Supabase](https://supabase.com/). Elas orientam a hierarquia das superfícies, a apresentação de dados técnicos e a moderação dos efeitos. O redesign mantém os componentes e a marca próprios da aplicação.

O bootstrap continua sendo um arquivo da própria origem, executado antes da renderização e compatível com a CSP existente. O tema não depende de serviços externos nem interfere com autenticação, persistência ou configuração da rede.

## Canvas independente e eventos reais

Os fundos Claro, Cinza e Escuro permanecem sob os controles atuais do laboratório. Novos laboratórios usam Escuro como escolha inicial do formulário; essa escolha não migra os fundos dos laboratórios já salvos. Suas cores e a preferência persistida na topologia continuam independentes da interface escura. Equipamentos, cabos, rótulos, grade, minimapa e controles do canvas mantêm paletas locais para preservar legibilidade em todos os fundos.

Os efeitos de transmissão, recepção, controle, sucesso e descarte representam eventos emitidos pelo motor. O marcador de pacote identifica o evento e o sentido do enlace. Um equipamento ligado, um enlace operacional ou um histórico salvo não constituem, por si só, tráfego em andamento. Abrir novamente um laboratório não reproduz efeitos de eventos antigos.

Os destaques expiram em 1,4 segundo de tempo de apresentação. A coleta considera até 256 eventos recentes e limita os efeitos a 96 equipamentos e 64 enlaces; essa amostragem visual não elimina eventos do histórico nem pacotes do motor. Seleção e estado operacional permanecem visíveis sem exigir movimento. A preferência `prefers-reduced-motion: reduce` mantém os marcadores e as informações estáticas, suprimindo deslocamento e pulsação. Ao ocultar a página, os efeitos móveis devem ser suspensos. Esses recursos não alteram tempo virtual, entrega de pacotes, decisões dos protocolos ou estado da simulação.

## Cobertura da validação

Os projetos Playwright `sistema-claro` e `sistema-escuro` variam somente a preferência de cor do sistema operacional. Ambos esperam que a plataforma permaneça escura. Isso permite detectar uma regressão que volte a depender do sistema sem restaurar uma opção clara para o usuário.

Os cenários de aparência foram adaptados para verificar preferências antigas, mudanças do sistema, recarga, segunda aba, armazenamento indisponível e ausência do seletor. Também verificam os três fundos do canvas, persistência, conta, modais, diferentes larguras de tela e acessibilidade com Axe. A passagem pelas abas dos 47 perfis continua verificando renderização e limites do inspector.

Os cenários de tráfego acompanham os marcadores transitórios durante pings reais na LAN, por passo manual e pelo Worker com vários eventos por delta. Eles comparam os identificadores e os sentidos dos marcadores com o histórico do motor, verificam os destaques dos equipamentos, exercitam movimento normal e reduzido, conferem a pausa e garantem que a reabertura não anima o histórico. Um delta pode reunir ida e volta; a visualização mostra a atividade mais recente por enlace e não promete reproduzir individualmente todos os frames desse lote. As falhas induzidas de salvamento e logout continuam cobertas; abrir menus durante a simulação não deve interromper o Worker.

As verificações de motor e API existentes continuam sendo a referência para comportamento e integridade dos protocolos. O redesenho visual não amplia suas capacidades nem remove os [limites do modelo](036-equipment-integrity-responsive-inspector.md).

## Resultados

Na suíte de domínio e API desta revisão, 498 testes passaram em 60 arquivos. Uma execução posterior dos testes específicos da atividade visual concluiu 21 casos, incluindo cinco novos casos para distinguir dados UDP e mensagens de controle tipadas, como DHCPv6 relay, CAPWAP e túneis.

O primeiro lote de navegador concluiu dez cenários de aparência e fluxo, distribuídos entre as duas preferências de cor do sistema operacional. Passaram os casos de preferência antiga, armazenamento indisponível, tema escuro fixo, ausência do seletor, conta e modais, fundo inicial escuro para novos laboratórios, fundos independentes e persistência, larguras de tela e acessibilidade com Axe. O fluxo real passou nos modos normal e reduzido, por passo manual e pelo Worker, incluindo associação com os eventos, sentidos dos enlaces, pausa e reabertura sem replay do histórico.

A inspeção visual percorreu acesso, dashboard, modal de criação, workspace e destaques de tráfego no canvas escuro. Um segundo lote concluiu 14 cenários de catálogo, controles e funcionalidades: todos os 47 perfis, resiliência, equipamentos, ações do canvas, dashboard, formulários e acessibilidade, TCP, wireless, desenhos e comentários, LAN e roteamento, serviços IPv6, DNS e aprendizagem.

O caso de escala com 2.000 equipamentos encontrou atraso na drenagem da fila de eventos. A correção separou a geometria dos equipamentos dos destaques transitórios, reutilizou a geometria dos enlaces e suas consultas de estado e manteve a visão geral estática, sem sombras, gradientes ou animação. A nova execução passou com o critério original de fila vazia em até 60 segundos, sem reduzir a topologia nem aumentar os prazos; o cenário completo durou aproximadamente 1,3 minuto. Esses lotes confirmam 25 execuções de navegador. Não foi realizada medição de FPS. Os resultados do ADR-037 pertencem à revisão anterior.

O lote final concluiu oito cenários: repetiu fluxos normal e reduzido, equipamentos, IPv6 e wireless; verificou VPN/SD-WAN e RSTP; e validou desenho livre, cancelamento com Escape e acessibilidade com Axe nos três fundos do canvas. Ao todo, 27 cenários de navegador foram validados localmente, considerando cenário e projeto e sem contar repetições entre os lotes. A listagem Playwright confirma 104 execuções configuradas para a CI, distribuídas entre os dois projetos; esse total não representa uma execução local completa.

A validação cobre cenários e invariantes concretos, sem constituir prova de ausência de todos os bugs ou equivalência a firmware e equipamentos físicos.
