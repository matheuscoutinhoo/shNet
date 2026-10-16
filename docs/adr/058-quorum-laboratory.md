# ADR-058 — Laboratório de quorum e histórico replicado

Data: 16/10/2026. Contrato: `2026.10.16.1`.

## Problema e decisão

R08 ainda precisa impedir que serviços confirmem alterações conflitantes quando o antigo ativo perde contato com a reserva. A promoção administrativa DHCP existente permanece independente. Acrescentamos primeiro um armazenamento de estudo com consenso, utilizável pelo catálogo e pelo painel Banco de dados, sem anunciar integração que os serviços ainda não possuem.

O núcleo segue eleição por termos/votos e replicação de histórico descritas no [artigo original de Raft](https://raft.github.io/raft.pdf). Um voto exige histórico suficientemente atualizado; cada termo conserva o voto persistido. O líder somente avança a confirmação por maioria de réplicas completas, com uma entrada do termo atual. Heartbeats perdidos podem causar eleições, mas não autorizam confirmar gravações por ausência de resposta.

## Implementação

- `quorum.ts`: máquina determinística que recebe mensagens e retorna estado e mensagens de saída. Não consulta energia, conectividade ou estado dos outros membros. O chamador instala o estado antes de transmitir os resultados. As APIs clonam/validam os argumentos; não alteram objetos do chamador.
- `quorum-lab.ts`: três ou cinco servidores com malha de cabos dedicados. Usa fila e relógio virtuais, perda/jitter/latência do cabo e tempo de serialização. Portas operacionais determinam entrega; nenhuma consulta global de maioria substitui votos ou ACKs. No máximo oito entregas em trânsito por emissor; saturação descarta mensagens e depende de retransmissão.
- Snapshot inclui termos, votos, histórico, índices, sementes e mensagens em trânsito. Importação recusa identidade incoerente, timers ausentes, históricos confirmados divergentes e mensagens incompatíveis com o emissor. Isso verifica coerência do modelo, sem conferir autenticidade criptográfica a arquivos importados.
- Duplicar um servidor não o associa ao grupo original. Clonar todos os membros cria outro grupo, sem os dados de execução. Seleção parcial emite aviso. Excluir um membro desmonta o grupo fixo e seus eventos; não simula mudança de composição em operação.
- O modelo **Quorum, eleição e dados replicados** oferece três servidores. O painel permite formar um grupo, propor um par chave/valor e distinguir proposta de confirmação. O preflight explicita o alcance e alerta próximo do limite do histórico.

## Critérios exercitados

Os testes cobrem maioria de três/cinco réplicas, falha de uma/duas instâncias, ausência de maioria, perda total, atraso, duplicação, reordenação, candidatos desatualizados, voto persistido e retorno do líder antigo. Comparam prefixos confirmados em seis sequências reproduzíveis de partições e entregas defeituosas. Há testes de cabos reais do modelo, energia, clonagem, remoção e restauração determinística com eventos em trânsito. O E2E verifica proposta/ACK, save/reload e painel mobile em ambos os temas.

Um teste de recuperação revelou o custo de recuar um índice por heartbeat numa réplica vazia. A rejeição agora informa um limite de histórico para acelerar o retorno; o líder conserva o limite inferior já confirmado para que rejeições atrasadas não apaguem conhecimento válido. Recuperação não tem SLA universal; depende do histórico e transporte.

## Limites e trabalho restante

Este incremento **não conclui R08**. O armazenamento de estudo ainda não controla respostas, VIPs, dados ou sessões de DNS, DHCP, banco SQL, MQTT, syslog, RADIUS, LB, MES ou SCADA. Cada adaptador precisará confirmar alterações antes de responder ao cliente e tratar autoridade/leitura na troca de líder. Transportes TCP existentes não são copiados entre instâncias por este recurso.

Um líder isolado pode continuar se considerando líder localmente. Sem novos ACKs de maioria, não confirma novas propostas. A visão de dados confirmados é histórica; um serviço que precise de leitura atual deve confirmar uma nova barreira. Não há lease de liderança ou desligamento físico inferido de silêncio.

Até 256 entradas por membro, 16 por mensagem, valores de até 4096 caracteres. Novas propostas são recusadas no limite; não há compactação silenciosa, snapshot installation ou alteração dinâmica de membros. O canal é didático, sem codec PCAP de fabricante, autenticação de mensagens ou proteção contra membros maliciosos. São limitações explícitas do modelo, não garantias de um serviço de consenso de produção.

R19/R18/R20/R25 e as extensões correspondentes de R22 permanecem pendentes conforme o plano consolidado. A [qualificação](../../artifacts/quorum-laboratory-2026-10-16/VALIDACAO.md) registra 976 testes, 142 cenários de navegador e cinco gates aprovados na CI. A publicação Railway exige sua própria conferência de identidade e endpoints.
