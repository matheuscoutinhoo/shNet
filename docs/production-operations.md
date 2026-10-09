# Operação de produção

Há três endpoints: `/api/live` verifica o processo, `/api/ready` verifica SQL e LISTEN/NOTIFY, e `/api/health` mantém compatibilidade com o healthcheck Railway. Falhas de readiness retornam 503 sem detalhes do banco. `/api/metrics` exige `Authorization: Bearer METRICS_TOKEN` (mínimo 32 caracteres) e permanece desativado sem a variável. Os labels usam padrões de rotas; não incluem IDs, parâmetros, e-mails ou tokens.

`deploy/compose.production.yml` prepara PostgreSQL 18, migration antes do app, Caddy com HTTPS, backup diário criptografado, Prometheus e Alertmanager. Apenas Caddy publica portas. Configure DNS, as variáveis indicadas no arquivo e os arquivos de segredo do token de métricas e do webhook autorizado. Execute `docker compose --env-file .env.production -f deploy/compose.production.yml up -d --build`. Os alertas cobrem indisponibilidade, erros HTTP, latência p95 e ausência de backup por 26 horas. Entrega de alertas requer um webhook externo configurado; nenhuma mensagem foi enviada nesta implementação.

## Backup e recuperação

A API monta somente o volume `backup_status`, com metadados de sucesso legíveis e montagem read-only. Os arquivos criptografados ficam em outro volume, acessível apenas ao usuário do serviço de backup. `BACKUP_STATUS_FILE=/backup-status/status.json` une o scheduler às métricas sem expor o diretório dos arquivos à aplicação.

Gere `BACKUP_KEY` com `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"`. Guarde a chave separadamente dos arquivos. O backup usa pg_dump em formato custom e AES-256-GCM com IV aleatório e autenticação do cabeçalho. Senhas são fornecidas por ambiente ao PostgreSQL, nunca como argumentos. O limite operacional é 2 GiB e 30 minutos por ferramenta. O arquivo `.json` contém tamanho, data e SHA-256 do ciphertext. O scheduler grava `BACKUP_STATUS_FILE` apenas após sucesso, retém 30 dias e não remove arquivos sem seu manifesto. Sem essa variável, o status permanece dentro do diretório privado dos backups.

- `npm run backup -- caminho/arquivo.shlab-backup`, com `DATABASE_URL`, `BACKUP_KEY` e pg_dump 18 disponível. `PG_DUMP_PATH` permite escolher o executável.
- Crie um banco **vazio e com nome diferente** do original. Defina `RESTORE_DATABASE_URL` e `RESTORE_CONFIRM_DATABASE` exatamente como o nome do destino. Execute `npm run restore -- caminho/arquivo.shlab-backup`; `PG_RESTORE_PATH` permite escolher pg_restore 18.
- A autenticação GCM termina antes de pg_restore receber dados. Um arquivo temporário de acesso restrito contém o dump durante a recuperação e é removido ao terminar. A restauração usa uma transação e não apaga objetos existentes. Migre/verifique o banco restaurado e a aplicação antes de mudar a URL de produção.
- Copie os arquivos criptografados para armazenamento externo com retenção e versionamento. O volume local é uma camada de recuperação; a configuração não pressupõe um provedor de armazenamento nem executa uploads externos.

## Evidência local e CI

Em 2026-10-09, backup e restauração passaram contra PostgreSQL servidor 18.6 portátil, além dos testes de duas instâncias da API. Foram conferidos topologia, nomes em UTF-8, histórico, aprendizagem e migrations. Ciphertext adulterado, destino ocupado, confirmação incorreta e sobrescrita de backup foram recusados. Para repetir no Windows, os binários oficiais devem estar em `.data/tools/pgsql`; execute `powershell -File scripts/local-postgres.ps1 start` e `npm run test:postgres -- tests/production.test.ts tests/api-instances.test.ts`. Pare o cluster com o mesmo script e `stop`.

O CI inclui os testes contra PostgreSQL 18, construção das imagens e validação dos arquivos Prometheus/Alertmanager. A configuração de containers ainda precisa ser executada no host de implantação: Docker não está disponível no ambiente local. A publicação real, certificados do domínio, armazenamento externo e entrega de e-mail/alertas dependem de acesso ao ambiente e às credenciais. Os tokens GitHub encontrados localmente estão inválidos; nenhum deploy foi realizado.

Referências: [pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html), [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html), [HTTPS Caddy](https://caddyserver.com/docs/automatic-https), [alertas Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/).
