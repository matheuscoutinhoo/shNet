# Validação local — fábrica, enterprise e datacenter

O ambiente usado em 13/10/2026 contém Node 24, PostgreSQL nativo 18.6 e Scapy 2.8.0. Os testes PostgreSQL criam bancos efêmeros exclusivos no cluster local; não usam o banco da aplicação. Configuração e binários ficam em `.data`, ignorado pelo Git.

## Preparar PostgreSQL no Windows

Disponibilize os binários PostgreSQL em `.data/tools/pgsql/bin`, incluindo `initdb.exe`, `pg_ctl.exe`, `psql.exe`, `createdb.exe`, `pg_dump.exe` e `pg_restore.exe`. Execute:

```powershell
powershell -NoProfile -File scripts/local-postgres.ps1 start
npm run test:postgres -- tests/production.test.ts tests/api.test.ts --no-file-parallelism
```

O cluster escuta em `127.0.0.1:55438`. O helper gera a senha e guarda a conexão em `.data/test-postgres/connection.json`; a configuração antiga `netlab_test` também é aceita. Cada rodada `test:postgres` cria seu próprio banco `shlab_test_validation_*` e o remove ao concluir. A conta desse cluster precisa poder criar bancos e executar dump/restore.

Para conferir ou parar o cluster, use `scripts/local-postgres.ps1 status` ou `stop`. Para outro PostgreSQL isolado, execute Vitest diretamente com `TEST_DATABASE_URL`, `PG_DUMP_PATH` e `PG_RESTORE_PATH` configurados fora do Git. O nome do banco de backup precisa conter `test`.

## Build e qualificação local

```powershell
npm test
npm run build
npm run lint
npm run qualify:local
```

`qualify:local` usa o cluster acima e cria outro banco efêmero. Confere migrações, configuração de produção, login, Secure cookie/CSP/HSTS, readiness, assets compilados, persistência/replay e restauração de uma cópia do artefato pelo hash. Gera `release-manifest.json` e `local-release-qualification.json` em `artifacts/remediation-2026-10-13`.

Esse procedimento não publica uma aplicação nem testa handshake TLS real. O rollback de uma cópia do index não substitui o ensaio operacional de aplicação/banco em homologação.

## Capturas e interface

Crie um venv em `.data/scapy-venv` e instale Scapy 2.8.0. A regressão gera as capturas em `.data/captures`; depois execute:

```powershell
npx tsx scripts/build-remediation-fixtures.ts
.data/scapy-venv/Scripts/python.exe scripts/verify-enterprise-captures.py
```

Os roteiros `verify-enterprise-datacenter-ui.mjs`, `verify-enterprise-api.mjs`, `verify-remediation-browser.mjs` e `verify-factory-ui.mjs` usam API/web locais e uma sessão sintética autenticada em Edge/CDP 9223. A sessão é lida apenas em memória. Configure `SHLAB_AUDIT_OUTPUT=artifacts/remediation-2026-10-13`; para fábrica, use o subdiretório `factory-ui`.

Por último, `node scripts/build-remediation-report.mjs` consolida evidências e o status do [plano](consolidated-remediation-plan.md). A auditoria inicial permanece histórica. Perfis de navegador, cookies, bancos, senhas e binários locais não fazem parte da entrega.
