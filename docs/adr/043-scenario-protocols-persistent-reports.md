# ADR-043 — Protocolos e relatórios persistidos dos ensaios industriais

> Registro histórico deste incremento. O [ADR-044](044-enterprise-integrity-fabric-binary-modbus.md) atualiza IMET/loopbacks, Modbus binário e funções adicionais, executor dual stack, checkpoints e verificação no servidor. Os limites descritos abaixo representam a versão original.

Data: 2026-10-13. Escopo: fábrica PLC/HMI com Modbus TCP e rede IP. Complementa o [ADR-042](042-factory-modbus-scenarios-remediation.md).

## Problema e comportamento entregue

O executor aceitava apenas ICMP, HTTP e Modbus. DNS, concessões DHCP, MQTT e gerência exigiam scripts externos. Os resultados desapareciam ao fechar o painel, e uma resposta divergente podia ser confundida com ausência de acesso em ensaios `deny`.

O executor agora oferece **nove protocolos** e **17 modelos de fábrica**. Uma resposta recebida que viola a assertion reprova o fluxo e a expectativa de bloqueio. Origem inexistente ou operação que não chega a iniciar também não comprova bloqueio. `deny` significa ausência de resposta no deadline definido, com evidência para investigação; não prova sozinho uma política de segurança.

| Protocolo | Parâmetros do fluxo                                                                 | Verificação                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ICMP      | `source`, `target`                                                                  | Echo reply, RTT, deadline e perda.                                                                                                                                                           |
| HTTP      | `port` opcional                                                                     | Resposta completa HTTP 200 e deadline.                                                                                                                                                       |
| Modbus    | `modbus`, `expectedRegisters` opcional                                              | Transação, Unit ID, função, tamanho, eco de escrita, exceções e valores.                                                                                                                     |
| DNS       | `dns.name`, `type`, `clearCache`, `expectedAnswers`                                 | Consulta ao destino informado; valores esperados, status e deadline. Cache limpo por padrão.                                                                                                 |
| DHCP      | `dhcp.interface`, `fresh`, `expectedServer`, `expectedAddress`                      | Concessão adquirida durante a amostra; lease antigo não conta. Aquisição nova por padrão. `target` identifica o destino no cenário; `expectedServer` valida o servidor efetivo da concessão. |
| MQTT      | `mqtt.operation`, `topic`, `payload`, `retain`, `receiver`, `filter`, `credentials` | CONNECT/CONNACK ou publicação QoS 1/PUBACK; recepção com tópico/payload quando receptor informado. Aguarda instalação da assinatura no broker.                                               |
| SNMP      | `snmp.community`, `oids`, `operation`, `expectedVarbinds`                           | GET/GETNEXT, status, valores e deadline; noSuchObject/endOfMibView não contam como sucesso.                                                                                                  |
| NTP       | `ntp.maxOffsetMs`                                                                   | Nova amostra do servidor informado, sincronismo e tolerância do relógio.                                                                                                                     |
| Syslog    | `syslog.text`, `severity`                                                           | ID da mensagem encontrado no coletor de destino e deadline de entrega. Não representa ACK na rede UDP.                                                                                       |

Falhas agendadas: equipamento (`device`), enlace (`link`), interface (`port`), serviço (`service`) e alimentação UPS (`power`). Serviço admite DNS/DHCP/HTTP/Modbus/MQTT/SNMP/NTP/syslog já configurado; HTTP aceita `servicePort`. Falha de alimentação corta rede e bateria da UPS; restauração devolve a rede elétrica. Falha de interface usa `setPort`, preservando o comportamento do motor.

O intervalo de DHCP/MQTT/NTP deve ser maior ou igual ao deadline. Origens e receptores desses fluxos são exclusivos no cenário, com resolução de aliases por ID/nome, para impedir substituição de estado de outra amostra. Permanecem os limites de 180 amostras, 16 fluxos, 32 falhas e 120 segundos virtuais.

## Origem imutável e persistência

Antes do Worker iniciar, a interface pausa e salva o laboratório. `POST /api/projects/:id/scenario-runs` verifica a revisão, valida a definição e suas referências e guarda a topologia, cenário, tipo baseline/ensaio e SHA-256 do JSON canônico. O Worker usa essa cópia capturada no servidor. Uma edição posterior do projeto não altera o ensaio.

`PUT .../:run` conclui o ensaio com relatório estruturalmente validado, definição correspondente e contagens/assertions consistentes com as amostras. Reenvio idêntico é idempotente; cancelamento ou finalização impedem sobrescrita. `PATCH` cancela um ensaio em execução, `GET` reabre resultados e origem, e `DELETE` permite remover um registro. Projeto excluído remove seus ensaios por cascade.

A migration **008_scenario_runs.sql** cria a tabela e seus índices. Até 50 ensaios por laboratório; relatório limitado a 2 MiB. Rotas exigem dono do projeto e CSRF em mutações. A interface mantém resultado ainda não salvo, permite tentar novamente e exportar. Um fechamento normal cancela a execução ativa; término abrupto do navegador pode deixar o registro em execução, que pode ser excluído ao reabrir.

Os resultados são calculados no navegador e armazenados pelo backend. O servidor valida a estrutura, origem e consistência; não atesta independentemente o resultado executando novamente a simulação.

## Evidência e limites

Eventos de ACL/firewall/inspeção/IPS incluem o pacote que originou a decisão. Diagnósticos passam a reter negações. Falhas das amostras correlacionam identificadores de ICMP/TCP/DNS/SNMP/DHCP/syslog e endpoints NTP com eventos dentro da janela do ensaio. O relatório mostra bloqueio por política, falha de enlace/interface, transporte, resposta divergente, timeout ou causa indeterminada; inclui eventos de evidência e dispositivos observados no caminho.

O caminho é a sequência de dispositivos distintos observados, não uma reconstrução completa de cada retransmissão ou tradução NAT. Retenção limitada, retries DHCP e fluxos intermediados podem reduzir a evidência. A ausência de evidência não permite atribuir uma causa específica. Serviço parado e link caído sem evento correspondente podem aparecer como timeout.

O motor é observado a cada até 100 ms virtuais entre tarefas, para avançar etapas MQTT e conferir deadlines. Os tempos de resposta usam timestamps do protocolo quando disponíveis. A recuperação continua baseada no intervalo de amostragem declarado e não é um timestamp exato de disponibilidade. A implementação não adiciona HA de dados/sessões, transporte Modbus binário, protocolos de anel ou PTP/TSN.

## Validação

Regressão executa os 17 modelos. Novos testes verificam nove protocolos, respostas divergentes em `deny`, isolamento da origem, estado restaurável, sobreposição, aliases, falhas inválidas, porta interrompida/restaurada e correlação sem contaminar fluxo permitido. A API testa origem imutável, conclusão após editar projeto, isolamento entre usuários, CSRF, revisão, relatório incompatível, idempotência, cancelamento e cascade. O roteiro da interface exercita Modbus, publicação MQTT, reabertura dos relatórios e acessibilidade.

Pendente: ações de checkpoint/restauração dentro do executor e migração integral dos 42 casos para a interface. O [backlog](../factory-remediation-backlog.md) mantém as próximas prioridades.
