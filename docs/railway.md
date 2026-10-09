# Implantação no Railway

Implantação do shLab a partir do repositório [matheuscoutinhoo/shNet](https://github.com/matheuscoutinhoo/shNet), usando a conta GitHub `matheuscoutinhoo`.

## Arquitetura

Um serviço `shlab` serve a SPA compilada, a API e o WebSocket na mesma origem HTTPS. Um serviço PostgreSQL separado armazena usuários, sessões e topologias. O container da aplicação é descartável; não usa PGlite nem grava e-mails locais em produção.

O Dockerfile usa Node 24, build em estágio separado, dependências de produção e usuário não-root. O runtime contém o motor, a API, as migrations e o frontend compilado. O processo Node recebe SIGTERM diretamente. O host padrão de produção é `::`, recomendado pelo guia Fastify do Railway; a porta vem de `PORT` e tem padrão 8080 na imagem.

## GitHub

Confirme a identidade antes de publicar:

```sh
gh auth switch --hostname github.com --user matheuscoutinhoo
gh api user --jq .login
gh repo view matheuscoutinhoo/shNet --json viewerPermission,isEmpty
```

Se não houver sessão da conta, autentique pelo fluxo oficial `gh auth login` no seu terminal/navegador. Nunca coloque tokens no chat, em URLs de remote ou em arquivos versionados.

O repositório estava vazio na preparação. Após revisar e autorizar a publicação, se a pasta ainda não for um repositório Git:

```sh
git init -b main
git remote add origin https://github.com/matheuscoutinhoo/shNet.git
git status --short
```

Revise os arquivos antes de criar o commit e fazer push. `.env`, `.data`, tokens de e-mail, dependências e resultados de teste são ignorados. Não substitua um remote existente sem verificar seu destino. Configurar a fonte na IaC não envia código ao GitHub.

## Configuração da plataforma

1. Use um projeto Railway dedicado e vincule o GitHub `matheuscoutinhoo`, permitindo acesso ao repositório `shNet`.
2. Instale/atualize a CLI oficial, autentique e vincule a pasta ao projeto e ambiente corretos com `railway login` e `railway link`.
3. No ambiente Railway, crie as variáveis compartilhadas `MAIL_FROM` e `RESEND_API_KEY`. Use remetente de domínio verificado no Resend e trate a chave como segredo/variável selada.
4. Execute `railway config plan`. Revise a criação de `shlab` e `postgres`, a origem GitHub e todas as mudanças. Só então execute `railway config apply`. Isso provisiona recursos faturáveis; não faça apply em um projeto diferente nem aprove exclusões inesperadas.
5. Em `shlab`, gere um domínio público em Settings > Networking. `RAILWAY_PUBLIC_DOMAIN` permite calcular a origem HTTPS. Se usar domínio próprio, declare `APP_ORIGIN` exata na configuração do serviço/IaC. Gere o domínio e ajuste as variáveis antes de considerar o primeiro deploy pronto; faça redeploy se necessário.
6. Mantenha a raiz do serviço em `/`, o Dockerfile na raiz, uma réplica e o PostgreSQL privado. Não importe separadamente API e frontend como dois serviços independentes.
7. Configure Pre-deploy Timeout de 300 s no painel para o comando de migration. O comando já está declarado na IaC; falha da migration deve impedir a publicação.

A documentação atual recomenda `.railway/railway.ts` (Infrastructure as Code). Config as Code com novos `railway.json`/`railway.toml` está descontinuado. A CLI avalia a IaC; push no GitHub não aplica mudanças de infraestrutura automaticamente. Não foi adicionado workflow que faça apply sem revisão.

## Variáveis

| Variável              | Configuração                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`            | `production`                                                             |
| `DATABASE_MODE`       | `server`                                                                 |
| `DATABASE_URL`        | Referência ao PostgreSQL privado; definida pela IaC                      |
| `HOST`                | `::`                                                                     |
| `PORT`                | `8080` na imagem/IaC; a aplicação respeita o valor recebido              |
| `APP_ORIGIN`          | Origem HTTPS, sem caminho; opcional quando há `RAILWAY_PUBLIC_DOMAIN`    |
| `MAIL_PROVIDER`       | `resend`, compatível com todos os planos                                 |
| `MAIL_FROM`           | Remetente verificado, via variável compartilhada                         |
| `RESEND_API_KEY`      | Segredo via variável compartilhada/selada                                |
| `TRUSTED_PROXY_CIDRS` | Opcional: lista explícita dos IPs/CIDRs dos proxies realmente confiáveis |

Não copie a `.env` de desenvolvimento para produção. Não use senhas do Compose, PGlite ou armazenamento local como persistência de produção. Nunca desative a validação TLS para contornar erros de certificado.

## E-mail e proxy

Railway Free, Trial e Hobby bloqueiam SMTP de saída. O adaptador Resend usa HTTPS, timeout e idempotency key. SMTP permanece disponível como alternativa nos planos que o permitem: configure `MAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` e `MAIL_FROM`. SMTP em produção exige TLS.

Cookies são Secure, HttpOnly e SameSite=Strict. A origem é uma configuração confiável, não derivada de cabeçalhos recebidos. A confiança em proxy fica desabilitada por padrão: configure `TRUSTED_PROXY_CIDRS` somente depois de confirmar os peers de entrada da sua implantação. A versão atual do Fastify rejeita confiança apenas por número de saltos. Não use `true`, redes `/0` ou faixas amplas por tentativa. Sem configuração do proxy, limites por IP agregam clientes que chegam pelo mesmo proxy; valide isso antes de abrir o serviço a vários usuários.

## Validação e operação

- A CI usa PostgreSQL 18, executa testes/build/E2E, constrói a imagem, roda migrations e verifica `/api/health` e a SPA no container.
- `/api/health` verifica conexão com o banco. O healthcheck de deploy não substitui monitoramento contínuo nem teste de entrega de e-mail.
- Valide cadastro, verificação, login, recuperação de senha, salvamento e WebSocket pelo domínio HTTPS real.
- Configure backups/PITR do PostgreSQL e teste restauração antes de armazenar dados importantes.
- A migration 007 compartilha rate limits em PostgreSQL; notificações privadas usam LISTEN/NOTIFY. Duas instâncias foram verificadas localmente. Valide proxy, readiness, reconexão dos clientes e capacidade do banco no ambiente antes de aumentar réplicas. A definição IaC conserva uma réplica inicial.
- O banco embarcado local não é migrado automaticamente para o Railway. Exporte/importe os laboratórios ou planeje uma migração de dados separada.

Nesta máquina foram validados o SDK/IaC, build e testes locais. Docker e Railway CLI não estavam instalados: a imagem Linux, o plano contra uma conta Railway e a entrega real de e-mail precisam ser verificados na CI/implantação. A preparação não cria recursos pagos nem publica commits automaticamente.

## Referências oficiais

- [Fastify no Railway](https://docs.railway.com/guides/fastify)
- [Monorepos](https://docs.railway.com/guides/monorepo)
- [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
- [Referência da IaC](https://docs.railway.com/infrastructure-as-code/reference)
- [PostgreSQL](https://docs.railway.com/guides/postgresql)
- [Pre-deploy](https://docs.railway.com/deployments/pre-deploy-command)
- [Rede de saída e e-mail](https://docs.railway.com/networking/outbound-networking)
- [API de envio do Resend](https://resend.com/docs/api-reference/emails/send-email)
