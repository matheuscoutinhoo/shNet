# Laboratório de disponibilidade integrada

Use **Enterprise com acesso, WAN e DC A/B** ou **Fábrica com acesso, WAN e DC A/B**, no catálogo de modelos. O primeiro possui cinco VLANs de acesso; o segundo possui oito. Ambos acrescentam a VLAN 250 de trânsito e redes próprias de WAN/datacenter. Os equipamentos externos também pertencem à simulação.

## Endereços para os exercícios

| Rede/função              | Endereço ou equipamento                                            | Gateway          |
| ------------------------ | ------------------------------------------------------------------ | ---------------- |
| Usuários, VLAN 10        | HA-CLIENT `10.70.10.10`, HA-DHCP-CLIENT inicialmente `10.70.10.11` | `10.70.10.1`     |
| Visitantes, VLAN 20      | HA-GUEST `10.70.20.10`                                             | `10.70.20.1`     |
| Serviços, VLAN 30        | VIP DNS/HTTP/NTP/syslog `10.70.30.100`; DHCP A/B `.67`/`.68`       | `10.70.30.1`     |
| Corporativa, VLAN 40     | HA-ERP `10.70.40.10`; SCADA 1–3 `.20`–`.22`; MES `.50`             | `10.70.40.1`     |
| Gestão, VLAN 99          | HA-ADMIN `10.70.99.10`                                             | `10.70.99.1`     |
| Células 1–3, VLANs 11–13 | PLC `10.70.<VLAN>.10`, HMI `10.70.<VLAN>.11`                       | `10.70.<VLAN>.1` |
| WAN                      | HA-WAN-SERVER `198.51.100.10`                                      | `198.51.100.1`   |
| Datacenter roteado       | HA-DC-SERVER `10.80.100.10`                                        | `10.80.100.1`    |

SCADAs, MES e células estão presentes somente na variante de fábrica. Os VIPs de trânsito são `10.70.250.254` nos firewalls, `.1` nos gateways WAN e `.253` nos gateways DC. Cada VIP tem dois participantes; a tabela não atribui o VIP permanentemente ao lado A.

## Comparar baseline e falhas

1. Abra **Opções do laboratório → Validar rede e cenários → Cenários e SLA**. Carregue **Modelo: HA integrada — baseline** e clique em **Executar cenário**. Os ensaios usam uma cópia isolada e guardam a topologia de origem.
2. Confira HTTP/DNS no VIP, HTTP na WAN/DC, NTP e syslog. O baseline exige zero perda e comprova bloqueio Guest→serviços por evidência de política. Na fábrica, confira também Modbus entre VLANs e as sete verificações de comunicação HMI/SCADA/MES.
3. Execute separadamente os presets de perda de firewall, WAN-GW, DC-GW, core, acesso, UPS e rack. Compare amostras antes/durante/depois e a recuperação por fluxo. Os tempos são virtuais: 12 s de aquecimento, janela de 16 s, amostras a cada 1 s e deadline de 800 ms. Cada falha deve terminar com resposta, dentro da tolerância declarada de até seis perdas em 16 tentativas.
4. Execute **uplink sem perda de carrier no host**. A NIC continua fisicamente ligada ao switch, mas seu caminho ao gateway falha. Observe a diferença entre carrier e o monitor ARP do bond.
5. Execute **perda e retorno do core A**. Compare failover e retorno; ter dois caminhos não significa convergência instantânea.

Para observar os estados no laboratório aberto, desligue o componente manualmente e avance a simulação. Use **Localizar equipamento** para encontrar dispositivos fora do viewport. Inspecione **Redundância NIC**, **VRRP**, **EtherChannel**, as sessões de firewall e os eventos de descarte. Salvar imediatamente após uma falha física deve preservar um projeto que reabre sem precisar avançar um timer.

## Conservar uma conexão existente

Em HA-CLIENT, abra **TCP / HTTP**, selecione **Abrir conexão** e conecte a `198.51.100.10:7777`. Na conexão estabelecida, use **Enviar dados TCP** para transmitir `before|`. Desligue HA-WAN-GW-A, avance até a convergência e envie `after|` na mesma conexão. Repita com HA-FW-A e, usando `10.80.100.10:7777`, com HA-DC-GW-A. Ligue o participante antigo, aguarde a convergência e envie outro trecho. A resposta acumulada permite distinguir continuidade da conexão de uma nova tentativa bem-sucedida. A operação Echo TCP encerra após a troca inicial; por isso este exercício usa Abrir conexão.

O teste atravessa gateways alternativos até o mesmo servidor; não demonstra transferência de uma sessão entre servidores de aplicação.

## Troca de servidor DHCP

Em HA-DHCP-CLIENT, use DHCP na interface **Bond1**. Confira a concessão entre `10.70.10.200` e `.220`, o gateway e o DNS recebidos. Avance até a réplica estar confirmada nos servidores. No painel DHCP de HA-DHCP-B, **Promover reserva e desligar HA-DHCP-A** executa a troca administrativa com fencing.

O cliente tenta renovar com o servidor antigo em T1; em T2 pode encontrar o novo por broadcast e pelos relays. Compare o endereço antes/depois e o identificador do servidor. Ao religar HA-DHCP-A, ele retorna como reserva. Não deduza morte de um servidor apenas porque seu cabo de réplica foi cortado: a promoção exige a revisão atual recebida.

## Investigar limites

- Desligue os dois cores ou as duas vias de um endpoint. A comunicação deve interromper. Não altere a expectativa para mascarar uma falha em um ensaio de disponibilidade.
- Compare ausência de resposta e bloqueio por regra. Durante convergência, um gateway ausente não prova isolamento. O verificador automatizado repete o teste Guest→serviços depois de cada recuperação e exige evidência de política.
- Desligue o próprio PLC e observe os alarmes de comunicação; NICs e energia A/B não replicam seu processo. Desligar apenas uma UPS deve conservar os endpoints alimentados pela outra fonte.
- Compare logs nas duas instâncias de serviço. O VIP muda o atendimento; os logs e as sessões dessas aplicações ainda não são replicados. Quorum/eleição automática de serviços permanece em R08.
- A captura PCAP informa exclusões e retenção. Ela ainda não representa todos os protocolos do laboratório; um pacote transmitido também pode não chegar ao destino.

Execute `npx tsx scripts/verify-resilient-laboratories.ts` para produzir as duas topologias importáveis, 26 relatórios de disponibilidade e 26 de isolamento. Os [critérios técnicos](adr/057-integrated-redundant-laboratories.md) e o [plano consolidado](consolidated-remediation-plan.md) registram implementação, qualificação e saldo.
