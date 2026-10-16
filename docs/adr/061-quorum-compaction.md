# ADR-061 — Compactação e recuperação do estado confirmado

Data: 16/10/2026. Contrato `2026.10.16.3`, aprovado nos cinco gates da CI: 1.000 testes e 144 cenários de navegador aprovados. Incremento de R08 sobre os [ADRs 058](058-quorum-laboratory.md) e [060](060-quorum-backed-sql-service.md). A [evidência](../../artifacts/quorum-compaction-2026-10-16/VALIDACAO.md) registra a qualificação; integração e publicação em preparação.

## Problema e decisão

O limite de 256 entradas encerrava laboratórios longos mesmo quando as consultas apenas atualizavam uma linha. O núcleo agora mantém índices absolutos e um checkpoint do prefixo confirmado, contendo índice, termo, chaves e tabelas SQL materializadas. Compactação automática começa com 192 entradas retidas e conserva 64 entradas confirmadas recentes, além do sufixo não confirmado. O painel também permite compactação administrativa do prefixo confirmado. Entradas não confirmadas nunca são incorporadas ao checkpoint.

O algoritmo usa os princípios de compactação da seção 7 e de InstallSnapshot da figura 13 do [artigo original de Raft](https://raft.github.io/raft.pdf): metadados do último índice/termo incluído, transferência em blocos e preservação do sufixo compatível. O modelo continua educacional, com composição fixa de três ou cinco membros; não constitui prova formal nem implementação interoperável de um produto de consenso.

## Recuperação por mensagens

Um líder envia o checkpoint quando o próximo índice da réplica já foi descartado do histórico local. Cada bloco contém até 4096 bytes UTF-8 representados em hexadecimal. Há um bloco aguardando confirmação por réplica. O receptor mantém uma área parcial limitada; confirma o deslocamento esperado, tolera duplicações e solicita reinício quando necessário. Apenas o conteúdo completo com tamanho, schema e SHA-256 válidos é instalado atomicamente. SHA-256 verifica integridade do conteúdo, sem autenticar remetente ou arquivo.

Após a instalação, um sufixo com termo compatível é conservado; um sufixo incompatível não confirmado é descartado. A réplica aplica as entradas recentes pela troca normal de mensagens. Confirmar a instalação informa recebimento de um prefixo já confirmado; não inventa uma maioria para operações novas. Checkpoints antigos não reduzem o índice confirmado. Termos e eleições continuam locais, sem consulta a energia, links ou memória dos pares.

O emissor usa seu checkpoint atual. Nova compactação reinicia a transferência daquele par, evitando reter múltiplas imagens completas. A maioria pode continuar confirmando operações enquanto uma réplica está atrasada. Recuperação sob compactações muito frequentes pode exigir redução de carga; este incremento não promete um SLA universal para essa situação.

## SQL, persistência e compatibilidade

A mesma máquina de estados determinística produz os dados do checkpoint e aplica as consultas SQL. Instalar um checkpoint atualiza as tabelas e o índice aplicado antes de continuar pelo sufixo. O checkpoint não armazena a resposta individual de cada consulta antiga: uma resposta pendente coberta pela imagem resulta em resultado indeterminado, sem fabricar linhas de SELECT ou contagens afetadas. Leituras novas continuam exigindo sua própria entrada confirmada por maioria.

Save/reload preserva imagem, índices absolutos, cursores de envio, buffer parcial, mensagens, TCP e consultas pendentes. Arquivos anteriores sem checkpoint continuam aceitos; o campo de envio ausente recebe um mapa vazio. A validação compara o estado confirmado e o histórico ainda disponível entre os membros. Quando a interseção histórica foi descartada, o arquivo não oferece prova criptográfica de toda a história anterior.

## Capacidade e limites

O orçamento é de 512 KiB para os dados materializados serializados, compartilhado por chaves e tabelas. A admissão considera as operações pendentes antes de aceitar crescimento. Redução de dados permanece possível enquanto houver espaço no histórico. Dados confirmados de arquivos antigos acima do orçamento são conservados; a compactação é recusada até caberem. Um legado já cheio continua recusando propostas se nenhum prefixo elegível couber no orçamento. Não há truncamento silencioso para cumprir quota.

Há até 256 entradas retidas e 128 propostas não confirmadas. A contenção de propostas reserva espaço para controle e barreiras de eleição; não promete progresso sob eleições malsucedidas ilimitadas. As demais quotas de banco, transporte, projeto e fila continuam vigentes. O número histórico de operações deixa de ser limitado a 256, desde que os dados vivos e os recursos atuais caibam nos limites. Checkpoints não preservam auditoria nem recibos individuais anteriores ao prefixo descartado.

R08 continua parcial: autoridade de endereço/VIP, descoberta do líder pelo cliente e adaptadores de dados/logs/sessões para os demais serviços permanecem no [plano consolidado](../consolidated-remediation-plan.md). Não há migração de TCP, retry automático de mutações, mudança de membros ou codec PCAP do canal abstrato de quorum.

## Verificação exigida

Os ensaios devem cobrir mais de 256 operações, sufixo não confirmado, partições, eleições, líder antigo, termos obsoletos, transferência interrompida, corrupção, perda, duplicação, UTF-8, instalação atômica e save/reload parcial. O adaptador SQL deve demonstrar essas propriedades por consultas HTTP/TCP e a interface nos dois temas. A evidência de publicação deve distinguir testes focados, regressão completa, cinco gates de CI e verificação de leitura do Railway.
