# ADR-013 — SNMP e syslog sobre UDP simulado

Status: aceito.

Consultas e registros de gerenciamento usam o mesmo IPv4, ARP, VLAN, encaminhamento, ACL, NAT/PAT, firewall e relógio virtual dos outros serviços. Nenhum protocolo usa sockets ou serviços externos do sistema operacional. O template Rede sob observação configura agentes SNMP no router/servidor e um coletor syslog no servidor.

SNMP é um modelo de leitura v2c, com GET, GETNEXT, request ID, community, resposta, noSuchObject, endOfMibView e tooBig. O agente consulta o próprio estado. A MIB inclui sysDescr, sysName, sysUpTime, ifNumber, ifIndex, ifDescr, ifMtu, ifSpeed/ifHighSpeed e estados administrativo/operacional. O tempo do agente é contado desde sua ativação pelo relógio virtual, sem reset automático ao alternar power. Contadores de frames e erros da simulação usam OIDs próprios na árvore de exemplo 1.3.6.1.4.1.32473.1; não são apresentados como contadores de unicast/octetos da IF-MIB.

GETNEXT compara arcos numericamente. Há até 16 OIDs por consulta e 128 consultas por equipamento, sem remover pendentes para abrir espaço. Cada tentativa recebe request ID novo, timeout de 5 s e no máximo duas tentativas. Retorno exige IPs, portas, request ID, community e OIDs correspondentes. Respostas acima da MTU de saída retornam tooBig sem varbinds; requisições acima da MTU são descartadas pela camada física. O caminho intermediário pode ter MTU menor, sem fragmentação.

A community é texto no protocolo simulado e no snapshot do próprio projeto. Ela controla a resposta do agente, mas não fornece criptografia ou autenticação forte. O log do comando de configuração a oculta; o packet inspector pode mostrá-la, como dado do SNMP v2c. Não há SET, GETBULK, traps/informs, SNMPv3, USM, VACM ou codec BER interoperável. Counter64 está limitado a inteiros seguros de JavaScript.

Syslog usa mensagens tipadas com hostname, facility 0–23, severity 0–7, appName, ID, texto e instante virtual. PRI é facility × 8 + severity. O filtro permite severidades iguais ou menores ao limite. O transporte é UDP/514, sem ACK/retry. A origem conserva sua porta UDP para reutilizar a sessão NAT/firewall entre mensagens. Cada origem mantém até 64 envios pendentes; o coletor retém os 500 registros mais recentes, com origem observada e horário de chegada.

Eventos automáticos incluem configuração, link up/down, vizinhança OSPF e alterações de STP. Não reenviamos mensagens recebidas nem falhas de entrega; isso evita realimentação de logs. Configuração da origem cancela os envios pendentes anteriores. Não há relay, TLS, RFC 5424 textual/binário completo, relógios independentes, timestamp UTC ou envio confiável. Perda, duplicação e origem não autenticada continuam possíveis no modelo UDP.

PC, router e server possuem a stack necessária. Switch L2 ainda não tem IP de gerenciamento/SVI e, portanto, não oferece estes serviços. Configuração e estado ficam em campos opcionais do snapshot v1. Importação valida referência de consulta, timer exato, OIDs, correlação de resposta, tamanho conceitual do datagrama e timestamps dos registros. Saídas de CLI removem caracteres de controle de terminal de dados recebidos.

Referências: [SNMP operações RFC 3416](https://www.rfc-editor.org/rfc/rfc3416.html), [SNMP MIB RFC 3418](https://www.rfc-editor.org/rfc/rfc3418.html), [Interfaces MIB RFC 2863](https://www.rfc-editor.org/rfc/rfc2863.html), [enterprise para documentação RFC 5612](https://www.rfc-editor.org/rfc/rfc5612.html), [syslog RFC 5424](https://www.rfc-editor.org/rfc/rfc5424.html). A árvore de exemplo permanece dentro do simulador, sem envio a agentes externos. O modelo não declara conformidade completa nem interoperabilidade com agentes/coletores externos.
