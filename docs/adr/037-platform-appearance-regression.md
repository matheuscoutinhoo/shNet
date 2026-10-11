# ADR-037: aparência da plataforma e regressão funcional

Data: 2026-10-11. Estado: implementado.

## Identidade visual e preferência

A plataforma oferece Claro, Escuro e Sistema no acesso, no painel de laboratórios e no workspace. Sistema é o padrão e acompanha mudanças de `prefers-color-scheme` sem recarregar. A escolha explícita prevalece sobre o sistema, persiste na chave `shlab.appearance` do navegador e se propaga a outras abas da mesma origem. Não depende de serviços externos nem altera a conta ou a topologia. Quando o armazenamento está indisponível, a escolha continua funcionando durante a página aberta.

O tema escuro usa bases em azul-marinho, superfícies em azul petróleo, texto claro com níveis de contraste distintos e interação em verde-água. Ações principais mantêm o azul; sucesso, alerta e erro preservam cores distintas. Formulários, tabelas, menus, cards, modais, estados de foco e barras de rolagem usam as mesmas variáveis semânticas. Cabeçalho, marca e terminal mantêm os tratamentos próprios da identidade do shLab.

`theme-init.js` aplica a preferência antes da renderização. É um arquivo da própria origem, compatível com a política `script-src 'self'`, sem código inline ou enfraquecimento da CSP. O módulo React acompanha seleção, sistema e eventos de armazenamento. O seletor nativo é identificado para leitores de tela e funciona por teclado; em telas pequenas usa o ícone correspondente ao tema efetivo.

## Canvas independente

Os fundos Claro, Cinza e Escuro continuam controlados pela topologia e pelas opções existentes do laboratório. A mudança de aparência da plataforma não modifica fundo, marcação, conexões, estado de simulação ou histórico de desfazer. Não torna um laboratório salvo pendente. Os equipamentos e controles dentro do canvas têm variáveis locais para preservar legibilidade em cada fundo, mesmo quando a interface ao redor usa outro tema.

O fundo padrão do React Flow foi neutralizado para não cobrir a cor selecionada para o canvas. O minimapa segue a paleta do canvas. O terminal mantém sua paleta própria.

## Problemas encontrados na revisão

- Alguns painéis usavam `--border` sem definir a variável. Ela agora aponta para a borda compartilhada.
- Cores claras fixas em formulários, tabelas, menus e modais impediam uma aparência coerente. Elas usam variáveis semânticas.
- O fundo escuro interno do React Flow sobrepunha o fundo do laboratório. O componente passa a usar fundo transparente sobre o canvas.
- Os filtros de eventos comprimiam seus rótulos quando o inspector reduzia o espaço disponível. Agora mantêm os rótulos completos, quebram por botão e têm rolagem quando necessário.
- A hierarquia de títulos do inspector saltava do equipamento para subseções. O corpo agora identifica sua seção para tecnologias assistivas.
- Uma falha de salvamento permanecia como alerta mesmo após uma nova tentativa bem-sucedida. O sucesso agora remove o alerta daquela falha, preservando mensagens de outros erros surgidos durante a operação.
- Uma falha de rede no logout fechava a interface local sem revogar a sessão no servidor; recarregar poderia abrir a conta novamente. A saída explícita agora informa a falha e permite tentar de novo. Sessões efetivamente expiradas continuam sendo encerradas localmente.
- A exclusão da conta e a revogação da sessão atual já encerravam a sessão no servidor, mas a interface tentava executar logout novamente com o cookie removido. Essas operações agora usam a confirmação recebida do servidor para fechar a sessão local; a saída manual continua exigindo confirmação da API.
- O aviso de sessão expirada não aparecia na tela de acesso e reaparecia depois de entrar. Ele agora aparece dentro do formulário, respeita os dois temas e é removido ao tentar entrar novamente. Revogação atual, troca de senha e exclusão confirmadas não deixam avisos de falhas anteriores.

## Cobertura e interpretação dos testes

Playwright executa os cenários existentes nos projetos Claro e Escuro. Eles cobrem conta e sessões, labs, templates, filtros, favoritos, histórico, desafios, tutorial, configuração de equipamentos, tráfego, inspeção de pacotes, captura, importação/exportação, falhas/recuperação, salvamento e reabertura, desktop/mobile e simulação com 2.000 dispositivos.

Os novos cenários verificam mudança do sistema, prioridade da escolha explícita, recarga, sincronização entre abas, valores inválidos e falha do armazenamento. Também verificam as nove combinações de tema da plataforma e fundo do canvas, ausência de alteração do estado salvo, contraste e controles nos modais e na conta. Uma passagem pelo catálogo abre as abas de todos os 47 perfis e verifica renderização, limites do painel e acessibilidade dos tipos de painel.

Os cenários de resiliência interrompem o salvamento e o logout, verificam a recuperação sem perda de alterações, recusam uma topologia inválida sem substituir a rede aberta e alternam a aparência enquanto o Worker processa um ping. Essas falhas são induzidas somente em contas e requisições do ambiente de teste.

O cenário adicional de sessões revoga a sessão do navegador por outra sessão real da mesma conta. Ele verifica que uma tentativa de salvar sem autorização não altera o laboratório persistido, que o aviso de expiração aparece na tela de acesso e que reentrada, revogação da sessão atual e troca de senha funcionam. A troca de senha também invalida a segunda sessão. Os helpers de login respeitam `Retry-After` quando a API limita tentativas; a proteção não foi desativada para os testes.

As suítes de motor validam encaminhamento, estados dos protocolos, erros de configuração, falhas e recuperação, isolamento, persistência e rejeição de snapshots incoerentes. As suítes de API e operação podem usar PostgreSQL servidor para verificar sessões, concorrência, notificações entre instâncias e backup/restauração.

A validação desta alteração executou 482 testes nas 59 suítes usando PostgreSQL servidor, sem testes ignorados. A passagem completa de navegador concluiu 98 cenários (49 por tema); após a correção final do aviso de sessão, oito cenários de aparência e conta passaram novamente, incluindo dois novos casos, totalizando 100 cenários distintos validados. Build, TypeScript, lint, formatação e auditoria de dependências passaram. O frontend compilado também foi aberto no navegador pelo servidor em modo de produção: bootstrap da aparência, CSP, carregamento dos arquivos e persistência da seleção passaram sem erros de JavaScript ou bloqueios da política de segurança.

Scapy, independente dos codecs TypeScript, validou 13 pacotes de captura, 11 checksums TCP, DNS, descoberta de vizinhos IPv6 e DHCPv6 relay aninhado. Essa verificação usa arquivos gerados pela suíte, sem enviar tráfego para redes externas.

Essa cobertura verifica cenários e invariantes concretos. Ela não constitui prova de ausência de todos os bugs nem equivalência a um equipamento físico. Os limites do modelo, inclusive protocolos ainda restritos a roteadores e a ausência de SPAN/TAP para IDS passivo, continuam registrados no [ADR-036](036-equipment-integrity-responsive-inspector.md) e nos ADRs de fidelidade de protocolos.
