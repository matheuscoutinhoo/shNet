# ADR-040: inicialização manual e continuidade do terminal

Data: 2026-10-12. Estado: implementado.

## Equipamentos novos

O catálogo e o arraste para o canvas usam a criação de hardware de fábrica. Os equipamentos ativos começam desligados, sem endereços IP, SSID, credenciais, serviços habilitados, associações, eventos ou ações de protocolo agendadas. Portas, MACs, modelos, módulos físicos e capacidades permanecem disponíveis. Rack e patch panel são elementos passivos; a UPS começa com a saída desligada e sem equipamentos conectados.

O estado de fábrica não remove as abas de configuração: os recursos disponíveis são determinados pelo perfil e pelas capacidades físicas, além das configurações existentes. Os formulários são propostas até que o usuário aplique os valores. O rádio novo é apresentado como não configurado, com SSID vazio e habilitação desmarcada.

Os templates e laboratórios preparados mantêm seu provisionamento explícito. Adicionar um equipamento de fábrica não configura os equipamentos existentes, não inicia sua associação wireless nem modifica seus timers. A instalação de cabos também não liga equipamentos; esse comportamento e as condições físicas estão descritos no [ADR-039](039-physical-link-conditions.md).

A duplicação parte do hardware de fábrica e copia somente configurações presentes na origem. Um equipamento vazio continua vazio. Configurações de serviços e rádio são preservadas, com sessões e contadores separados. Como no comportamento anterior, os endereços IP não são copiados para evitar conflitos; pools DHCP precisam ser reconstruídos, e configurações que dependem de underlay aguardam um endereço próprio antes da ativação. Links wireless e mesh derivados são reconstruídos pelos protocolos.

## Terminal por equipamento

Cada equipamento mantém uma sessão de terminal em memória, vinculada ao motor do laboratório aberto. Trocar uma aba do inspector, fechá-lo ou selecionar outro equipamento conserva a saída, o histórico de comandos, o contexto CLI, a linha em edição e os resultados já apresentados. Equipamentos e laboratórios diferentes não compartilham esses dados.

A reabertura reconcilia o prompt com o hostname atual, sem repetir o banner ou resultados concluídos. O transcript concluído fica separado da linha em edição, permitindo que comandos longos sejam redistribuídos na largura atual sem duplicação. A edição limpa a linha lógica usando o buffer público do XTerm e respeita a ordem das escritas. A saída é limitada a 256 KiB, e o XTerm mantém seu limite de scrollback. Esse histórico não entra no snapshot ou na API; reabrir o laboratório em outra sessão inicia novos consoles.

## Ajustes visuais

A seleção e a atividade usam a borda existente do dispositivo. Não há outline externo ou anel de sombra sólido formando uma segunda borda. O brilho suave permanece como destaque transitório; a visão geral continua estática.

Botões primários e links usam o verde-água da identidade, com texto escuro para preservar contraste. Ícones antes azuis passam ao verde correspondente à superfície. Estados de falha, atenção e controle conservam suas diferenças semânticas.

Equipamentos desligados conservam o contraste do texto, com borda tracejada e indicador de energia. A tabela de eventos pode receber foco para rolagem por teclado, inclusive quando vazia. O formulário de IDS/IPS novo começa desativado e sem regras de exemplo.

## Validação

A revisão verifica criação dos 47 perfis, integridade das interfaces, MACs únicos, persistência do hardware sem configuração, ausência de efeitos sobre redes existentes e habilitação manual seguida de comunicação real. A regressão de terminal verifica retenção, isolamento entre equipamentos e laboratórios e limites de memória. Os cenários de navegador cobrem seleção, contraste, troca de abas, contexto CLI, comandos em edição, condições físicas e persistência das escolhas.

Passaram a suíte de motor/API com PostgreSQL isolado (520 testes), as regressões finais direcionadas (30 testes em cinco arquivos) e 13 cenários de navegador, incluindo todas as abas dos 47 perfis. A versão final passou em build, typecheck, lint e formatação. Os testes de navegador também cobrem DHCP, HTTP pelo rádio, duplicação, telas pequenas, acessibilidade e movimento reduzido; as capturas de borda única e draft longo foram conferidas visualmente.
