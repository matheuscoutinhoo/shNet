# Segurança

Autenticação simples, sem RBAC/organizações. Segue recomendações aplicáveis da [OWASP para senhas](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) e [autenticação](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

- Argon2id: 19 MiB, 2 iterações, paralelismo 1. Senhas de 12–128 caracteres; login aceita senha antiga sem impor novas restrições.
- Token de sessão: 32 bytes criptograficamente aleatórios; só hash SHA-256 no PostgreSQL. Expiração de 7 dias. Rotação no login e revogação no logout/reset/change.
- Sessões são listadas por UUID independente do token/hash. Revogação individual exige ownership; exclusão de conta exige senha atual e remove dados relacionados em transação. Nome de perfil é o único campo editável por esse endpoint.
- Cookies HttpOnly, SameSite=Strict, path=/; Secure obrigatório em produção.
- Mutations exigem Origin exata configurada. Autenticadas também exigem token CSRF derivado por HMAC do token de sessão, obtido via login/me. Tokens nunca vão para localStorage.
- Verificação expira em 24h, reset em 30min; links usam fragment para evitar logs/referrer. Tokens são consumidos atomicamente uma vez.
- Rate limit global e por rota de autenticação, bloqueio temporário por conta após tentativas repetidas, hash dummy para usuário inexistente.
- Consultas parametrizadas; validação estrita contra mass assignment; payload máximo de 16 MiB.
- Ownership explícito em todos os recursos privados, inclusive snapshots e upgrades WebSocket. Conexões WebSocket verificam sessão novamente ao enviar notificações e a cada 30 segundos.
- CSP, frame-ancestors none, nosniff, HSTS em produção, sem CORS permissivo.
- Logs estruturados com request ID e redaction de cookies/credenciais. Sem logs de body/senha/token de e-mail.
- NetOS nunca chama exec, eval, shell ou sistema operacional. Parser usa registry finito de comandos.
- Avaliações de labs exigem ownership/CSRF, usam somente o snapshot salvo, rejeitam resultados fornecidos pelo cliente e executam tráfego novo em cópia isolada com limite de tamanho/eventos. Não são um sistema de certificação inviolável para topologias arbitrárias.
- E-mails locais contêm segredos temporários em .data/mail, ignorado pelo Git; modo exclusivamente local. Produção exige SMTP com TLS ou Resend HTTPS, com secrets por variáveis e sem log do corpo da resposta do provedor.

## Operação

Rate limits são compartilhados em PostgreSQL, e notificações privadas usam LISTEN/NOTIFY com verificação de sessão/ownership em cada instância. Falha da assinatura retira readiness e fecha WebSockets locais. Isso não implementa colaboração nem uma fila durável. TRUSTED_PROXY_CIDRS aceita somente IPs/CIDRs confiáveis e fica desabilitado por padrão; não confiar em X-Forwarded-For arbitrário nem apenas em uma contagem de hops. Não usar credenciais de Compose em produção. A configuração Railway referencia secrets compartilhados, não contém chaves.

Readiness e liveness são separados; métricas exigem um token próprio e não incluem IDs, query strings ou credenciais nos labels. Backups usam AES-256-GCM, ferramentas PostgreSQL com senha por ambiente e confirmação do banco vazio de destino. A API recebe somente metadados de sucesso em volume read-only. HTTPS, e-mail, alertas e cópia externa dos backups exigem execução no ambiente de implantação; veja [operação de produção](production-operations.md).

Este documento registra medidas e limites; não representa certificação ASVS nem auditoria independente.
