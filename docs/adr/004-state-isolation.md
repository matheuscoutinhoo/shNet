# ADR-004 — Isolamento

Status: aceito.
Complementado pelo ADR-008: o workspace permanece local, mas a avaliação de labs pode executar uma cópia isolada e limitada do engine no backend, sem interpretar shell ou acessar rede externa.
Uma instância do engine por laboratório aberto. API valida documento como dados, não executa protocolos/CLI. Owner sempre vem da sessão. Engine não toca DB/DOM/OS. PGlite permitido só para desenvolvimento/testes, PostgreSQL servidor obrigatório em produção.
