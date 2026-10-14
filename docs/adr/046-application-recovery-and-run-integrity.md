# ADR-046 — Recuperação e integridade operacional da aplicação

Data: 13/10/2026. Contrato do motor: **2026.10.13.6**. Migração SQL: **011**; o agregado da topologia continua em schemaVersion 1.

O escopo solicitado agora é o funcionamento da aplicação. Novos protocolos, HA de serviços/NICs, processos PLC e recursos industriais especializados ficam para outra etapa. O modelo atual continua sendo de laboratórios privados por usuário; RBAC de equipes é uma ampliação de produto.

## Trabalho e persistência

Autosave usa debounce de 1,5 s e um intervalo máximo de 5 s durante alterações contínuas. Uma chamada de save espera sua versão capturada, sem perseguir indefinidamente versões produzidas pelo realtime. Falhas de transporte têm timeout de 30 s; respostas HTML/JSON incompletas recebem erros recuperáveis.

Expiração de sessão pausa o processamento e preserva o trabalho antes de voltar ao login. Se o armazenamento local também falhar, o Workspace permanece aberto para exportação; a aplicação não encerra automaticamente o editor com trabalho desprotegido.

IndexedDB guarda rascunhos por usuário/projeto/aba: até 30 entradas/64 MiB por navegador e 16 MiB por rascunho. Não há descarte silencioso para abrir espaço. A recuperação mostra diferenças, permite exportar e só remove a versão recuperada após save correspondente. Carregar uma versão remota arquiva o trabalho anterior separadamente, para que a próxima edição não o sobrescreva. O painel também recupera rascunhos de projetos excluídos. Quotas ou armazenamento bloqueado são mostrados; IndexedDB não garante gravação após encerramento abrupto do processo.

WebSocket reconecta com backoff de 1 a 30 s e consulta a revisão ao reconectar. Alterações remotas atualizam um projeto limpo; trabalho pendente entra em conflito e permite exportação, carregamento protegido ou cópia. Ownership/revisões da API continuam autoritativos. Histórico undo/redo limita contagem e bytes conjuntamente a 64 MiB; um checkpoint grande não destrói o redo existente.

## Configuração e cenários

Lotes suportam portas/IP/DNS/gateway/MTU/VLANs/trunks, rotas IPv4 e política de firewall existente. O formato anterior hostname/port continua aceito. A proposta normaliza aliases, rejeita ambiguidades e valida o lote inteiro em uma cópia. A revisão pausa o processamento e recusa aplicação se a configuração mudou. Aplicar um lote conserva o relógio/estado atual; importar uma topologia restaura o agregado inteiro e informa isso na revisão.

O executor oferece `configure`/`rollback`, além de `checkpoint`/`restore`. `changes` é permitido somente em configure; rollback exige uma proposta anterior. Há no máximo 16 ações, quatro checkpoints de simulação/32 MiB e quatro reversões ativas/8 MiB. Rollback restaura apenas campos explicitamente alterados; não recupera sessões de firewall encerradas pela reconfiguração nem retrocede tempo. Somente restore incrementa a época. Hashes de propostas/preimagens e contagem de objetos acompanham o resultado; esses dados de cliente são conferidos por replay para obter atestado.

Formulários cobrem os nove adaptadores já existentes, suas opções/SLA, falhas, ações e assertions. O baseline da interface remove intervenções e assertions dependentes delas, preservando fluxos/SLA. O servidor recusa ações/falhas em um baseline. Workers têm geração de operação, cancelamento e limites de espera: 30 s sem resposta no realtime, três minutos para cenário no cliente, 20 s para replay no servidor. Um resultado parcial não recebe aprovação.

## Origem do ensaio e causalidade

Builds compilados gravam no ensaio o SHA-256 de fontes do motor/dependências e o SHA-256 dos bytes do Worker efetivamente carregado. O servidor compara ambos com os instalados e recusa divergência; o relatório deve corresponder à origem registrada. Fontes são normalizadas para LF antes do fingerprint. Builds de desenvolvimento são rotulados `development` e não recebem identidade binária. A API `/api/build` informa motor, artefato, contrato e migração.

O helper de identidade é incluído explicitamente no runtime Docker. O smoke local monta apenas os arquivos declarados na etapa runtime, inicia a API/migrações e compara fonte/artefato com o build qualificado. Esse teste de empacotamento não representa uma execução de imagem no daemon Docker nem um deploy remoto.

Replay grava sua própria identidade de fontes e compara o resultado com a origem do cliente. Copiar metadados de origem para a comparação não atesta execução de código confiável no navegador. Um lease atômico no banco admite uma verificação por banco, compartilhada entre réplicas: expira em 45 s e é removido apenas pelo token proprietário. Não há fila distribuída de trabalhos; clientes ocupados recebem 503/retry. Ensaios antigos sem identidade de origem continuam identificados como tal.

Evidências seguem trace IDs, quadros VXLAN internos e conexões frontend/upstream de proxy/LB, excluindo health checks e requisições concorrentes. A busca possui limites de oito intermediários/quatro encapsulamentos. Causas mantêm referências aos eventos; razões, eventos e caminhos têm limites compatíveis com o relatório. Retenção/truncamento é explícita. Recuperação continua baseada em amostras, sem promessa de precisão por evento ou correlação universal de todos os codecs.

## Operação e desempenho

Autolayout ordena o grafo em uma grade limitada, preservando grupos e rádios que dependem das coordenadas do desenho. Não altera coordenadas RF nem converte o canvas em planta física. Clones recebem MACs/IDs separados e não ingressam no par HA original. Loopbacks/transporte VXLAN usam /32 livres em 10.255.0.0/16, com overlay desabilitado; os demais endereços continuam exigindo revisão do usuário.

Preflight acrescenta próximos saltos sem interface, redes não canônicas e regras IPv4/IPv6 totalmente cobertas por regras anteriores. Ao exceder 5.000 achados, informa revisão truncada. Configuração potencial não certifica alcance ou isolamento.

Fatias incompletas conservam a fronteira virtual e não atualizam CPU/temperatura fora da fronteira, eliminando dependência do tempo de processamento. Busca de ambientes de rack é agregada nas atualizações gerais. O catálogo do painel tem entrada própria e não carrega o motor antes da abertura do laboratório. Simulação/captura/deltas permanecem limitados; atraso de realtime é visível e permite reduzir velocidade ou pausar.

O benchmark registra três repetições, p95 de fatias/deltas e heap Node para enterprise nativo e árvores L2 de 100/500/2.000 dispositivos. Esses casos não representam a mesma carga. A capacidade depende do host; 2.000 dispositivos não constituem garantia de realtime 1×. O Workspace e Workers ainda têm bundles grandes; os avisos não foram ocultados. Homologação/TLS/deploy remotos continuam dependentes de um ambiente fornecido.

Evidências e comandos: [validação deste incremento](../../artifacts/application-stability-2026-10-13/CORRECOES-E-VALIDACAO.md).
