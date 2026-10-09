# Persistência

Registros de servidor DNS, consultas pendentes/finalizadas e cache também são campos opcionais do agregado JSONB. O backend rejeita timers ausentes, CNAMEs conflitantes e cache incompatível com a pergunta ou TTL. Snapshots v1 antigos continuam aceitos; não há alteração de DDL nem migration SQL nesta extensão. Leitores anteriores não conhecem os novos payloads/ações DNS.

Migrations SQL versionadas em apps/api/migrations; schema_migrations registra aplicação em transação com bloqueio. Produção exige PostgreSQL servidor. PGlite utiliza PostgreSQL WASM para desenvolvimento/testes e roda exatamente a mesma migration.

- users: identidade, senha Argon2id, verificação e bloqueio de tentativas.
- sessions: hash SHA-256 de token aleatório, FK de usuário, expiração.
- auth_tokens: hashes de tokens de verificação/reset, finalidade e expiração.
- projects: dono, título, favorito, revisão otimista e agregado topology JSONB.
- topology_versions: snapshots nomeados do agregado, associados a projeto.
- lab_progress: avaliação do lab por projeto/revisão, tarefas e histórico de conclusão.

Migration 002 acrescenta UUID público e user-agent às sessões; o token/hash não é exposto na listagem. Migration 003 acrescenta modo/lab ao projeto e a tabela de progresso. O executor aplica arquivos SQL numerados em ordem, preservando versões já aplicadas.

Device/Interface/Connection/Configuration pertencem ao agregado JSONB nesta fase; não há tabelas paralelas que possam divergir. Um PUT exige a revisão atual, incrementa-a atomicamente e rejeita conflito com 409. O backend valida tipos, tamanhos, IDs únicos, interfaces existentes, ocupação de portas e fila consistente.

Pools e bindings DHCP, leases por interface e temporizadores também pertencem ao agregado de simulação. A API valida subnet, intervalos, exclusões, referências e consistência entre concessão, IP/gateway/DNS e timers. São dados de simulação persistidos no checkpoint, não sessões de rede do servidor da aplicação.

Os novos campos DHCP são opcionais no schemaVersion=1; snapshots anteriores continuam legíveis. Não há alteração de DDL, portanto esta extensão não requer uma migration SQL. Leitores antigos não suportam os novos pacotes/timers DHCP. Veja ADR-005 para a decisão de compatibilidade.

O cliente nunca escolhe owner: toda consulta de projeto/version filtra pelo usuário da sessão. Eventos efêmeros têm retenção limitada no engine, não uma tabela de alta frequência. Até 100 projetos/usuário e 50 snapshots/projeto. JSON importado é validado antes da aplicação e novamente no save.

Para backup, use ferramentas PostgreSQL adequadas à implantação. O formato de exportação inclui schemaVersion=1 e pode ser reimportado sem cookies ou dados de usuário.

## Aprendizagem

Migrations 004/005 adicionam project_challenges (definição, baseline e revisão), learning_progress (resultado, melhor pontuação e etapa) e best_score dos labs existentes. Foreign keys com exclusão em cascata preservam ownership pelo projeto. Editor, avaliação e reset usam revisões otimistas; editar a definição remove o progresso antigo. O score agrega melhores resultados sem somar tentativas.
