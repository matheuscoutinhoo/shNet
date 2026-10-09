# Contribuir

1. Node 24+, npm ci; siga README para .env e banco.
2. Regras de domínio ficam no engine, nunca em componentes React.
3. Cada protocolo novo precisa de modelos serializáveis, explicação educacional e testes de falha/recuperação.
4. Registre comandos na CLI; jamais execute entrada via shell.
5. Snapshot schemaVersion exige migração explícita ao quebrar compatibilidade.
6. Toda rota privada valida ownership; mutations precisam de origem + CSRF.
7. Rode lint, typecheck, testes e build. Mudanças na experiência principal exigem E2E.
8. Documente fidelidade e limites em protocols.md; não exponha funcionalidades decorativas como protocolos implementados.

Contratos REST estão em /api/openapi.json. Interfaces TypeScript do engine são compartilhadas por workspace. Estilo utiliza tokens CSS, ícones SVG próprios para equipamentos e Lucide para controles.
