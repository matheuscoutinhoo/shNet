# ADR-027: automação, datastores, telemetria e relógio de rede

Atualização: este ADR registra a etapa original. Os recursos e limites ampliados são descritos no [ADR posterior](033-routing-vpn-aaa-management-fidelity.md); ausência registrada nesta etapa não descreve o estado atual.

Data: 2026-10-07. Estado: implementado no simulador educacional.

## Decisão

NETCONF e RESTCONF percorrem TCP, IPv4, ARP, roteamento, ACL e perdas do motor. TCP/830 transporta RPCs JSON; TCP/443 transporta GET/PATCH HTTP com corpo protegido pelo modelo didático. Usuários de rede têm privilégios de leitura ou configuração; não são contas do produto. Segredos são omitidos de eventos e histórico.

O datastore de configuração contém hostname, interfaces existentes e rotas IPv4. get inclui contadores; get-config omite estado operacional. edit-config cria candidate sem alterar running. validate e commit executam as invariantes do snapshot em uma cópia antes de aplicar. Candidate registra a configuração de origem e recusa commit após edição concorrente; RESTCONF usa revisão If-Match. Lock é um lease de 30 segundos por IP/usuário. IDs de RPC impedem reaplicação. Consultas têm timeout de 10 segundos e respostas paginadas.

Jobs executam até 32 RPCs em ordem, aguardando resposta real antes do próximo passo, e param no primeiro erro. Configuração, candidate, jobs, conexões e timers persistem. Remover jobs concluídos libera consultas retidas.

Telemetria publica interfaces, rotas, TCP, QoS e AAA em UDP/57500. Os datagramas respeitam MTU e usam autenticação didática e janela antirreplay de 64 sequências, permitindo reordenação. O coletor conserva 256 registros e contadores de aceitação/rejeição.

NTP usa UDP/123 e quatro timestamps para estimar offset e atraso. O envio é marcado após ARP e filas de saída. O cliente alterna peers após timeout e conserva amostras/stratum. Apenas o offset do relógio do equipamento é corrigido: o relógio global de eventos permanece monotônico e determinístico.

## Verificação

Testes cobrem candidate/commit, concorrência, privilégios, atomização de patches inválidos, tráfego interrompido/recuperado por patch, loopback, perdas/ACL, jobs, restore, NTP/failover, telemetria/MTU/reordenação/replay. A API salva tráfego pendente e rejeita timers adulterados. O E2E verifica operação e persistência em desktop/mobile.

## Limites

Não há SSH, TLS, XML, codec NETCONF interoperável nem schema YANG; os protocolos usam contratos JSON próprios, cifra/integridade didáticas e conexões finitas por RPC. Lock não é uma sessão NETCONF permanente. A configuração remota permite somente campos explicitamente modelados, sem criação de interfaces ou acesso ao processo/arquivos. Telemetria não implementa gNMI, streaming confiável ou OpenTelemetry. NTP não implementa autenticação, disciplina de frequência, leap seconds ou UTC real; timestamps de emissão dentro de payloads já cifrados de túneis não são reescritos.
