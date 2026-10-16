# ADR-060 — Banco SQL didático com confirmação por maioria

Data: 16/10/2026. Contrato `2026.10.16.2`, qualificado em cinco gates da CI: 989 testes e 144 cenários de navegador aprovados. Incremento de R08, dependente do [ADR-058](058-quorum-laboratory.md). A [evidência](../../artifacts/sql-quorum-2026-10-16/VALIDACAO.md) distingue a qualificação da publicação efetivamente conferida.

## Decisão

O armazenamento independente de quorum não protegia o banco SQL: o servidor executava a consulta e respondia antes de replicar seus dados. O novo vínculo transforma cada consulta autenticada em uma entrada ordenada no histórico de consenso. Todas as réplicas executam a mesma gramática determinística somente após confirmação. O servidor que recebeu a consulta responde pelo TCP original quando o índice e termo dessa operação estão confirmados.

`SELECT` também entra no histórico. Assim, sua própria confirmação de maioria constitui uma barreira nova antes da leitura. Um membro isolado pode manter o papel local de líder e seus dados históricos, mas não consegue devolver sucesso para uma nova leitura ou alteração sem confirmar a operação. Seguidores recusam consultas com HTTP 503; credenciais inválidas não criam entradas.

## Configuração e uso

O modelo **Banco SQL com consenso e falhas** tem três servidores, um switch de acesso e um cliente. Cada par de servidores usa o canal físico dedicado do quorum, com perdas, latência e jitter; consultas e respostas percorrem a LAN por HTTP/TCP. O painel Banco de dados está disponível no desktop para consultas, sem oferecer configuração de servidor nesse host.

Um grupo existente pode ser vinculado pelo painel ou pelo comando `database ha quorum`. A inicialização administrativa exige réplicas ligadas, sincronizadas, bancos vazios e mesma porta/chave. A configuração é validada inteira antes da alteração. Porta/chave permanecem fixas enquanto o vínculo existe. Desabilitar o listener não interrompe a aplicação do histórico confirmado.

Os servidores usam IPs individuais. A eleição de consenso é automática; a aplicação cliente precisa estabelecer uma nova conexão com o novo líder. Este incremento não gerencia VIP, descoberta automática, migração de TCP ou retry de alterações. Desativar apenas o listener SQL não provoca transferência de liderança de consenso. Essas parcelas de disponibilidade permanecem em R08.

## Transporte, persistência e falhas

Há no máximo 32 respostas pendentes por réplica e deadline de três segundos virtuais. Falta de confirmação ou perda da entrada original retorna HTTP 503 com **resultado indeterminado**. Uma operação pode ser confirmada depois do timeout: o cliente deve consultar o estado antes de repetir uma alteração. Não se promete execução única entre novas requisições distintas.

O TCP conserva `CLOSE-WAIT` quando o cliente envia FIN enquanto uma resposta de quorum está pendente. Um half-close do cliente não autoriza o servidor a enviar seu próprio FIN antes da decisão da aplicação. Resposta/timeout encerram normalmente o envio. Isso corrige o fechamento prematuro identificado durante os ensaios do adaptador.

Snapshot preserva índices aplicados, respostas pendentes, TCP e mensagens em trânsito. Validação reexecuta o histórico confirmado a partir do banco vazio e recusa tabelas divergentes, vínculos incoerentes e respostas que não correspondem à consulta original. A importação verifica coerência, sem autenticar criptograficamente o arquivo.

Remover membro ou grupo fixo desabilita todos os bancos associados, preservando as tabelas históricas. Não cria escritores independentes ativos. Clonar o grupo inteiro gera novo quorum e bancos vazios; duplicação isolada deixa o banco desabilitado e não copia a associação. A interface informa esses limites.

## Aceites e limites

Os ensaios exercitam CRUD HTTP/TCP, rejeição SQL ordenada, confirmação antes da resposta, leitores seguidores, credenciais, partições, perda de energia, eleição, retorno da réplica, snapshot em trânsito, limite de pendências e resultado indeterminado seguido de commit tardio. O navegador exercita consultas pelo desktop, confirmação e save/reload nos dois temas. Resultados completos e publicação devem constar na evidência da versão; este ADR não substitui a qualificação.

Persistem o limite explícito de 256 entradas por membro (incluindo consultas, barreiras e eleições), ausência de compactação e composição fixa. Ao atingir o limite, novas consultas são recusadas e dados confirmados são preservados. Os limites de tabelas/colunas/linhas e a gramática SQL existente não mudam. Não há protocolo PostgreSQL, transações de múltiplas consultas ou emulação de SGBD.

Este incremento não conclui R08: DNS, DHCP automático, MQTT, syslog, RADIUS, MES/SCADA e sessões dos demais serviços ainda precisam dos próprios adaptadores e ensaios. R19/R18/R20/R25 e extensões de R22 continuam no plano consolidado.
