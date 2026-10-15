# ADR-050 — endereço virtual e disponibilidade de serviços

Data: 15/10/2026. Contrato em qualificação: `2026.10.15.1`. Snapshot 1 e migration 011 preservados.

## Comportamento entregue

O VRRP IPv4 pode operar em roteadores e servidores. O grupo oferece **accept mode**, desativado por padrão: quando habilitado, o participante ACTIVE aceita tráfego local no VIP mesmo sem ser o dono físico do endereço. BACKUP e INIT continuam recusando esse tráfego. O ativo acessa o próprio VIP pela stack local e pode usá-lo como origem TCP; o backup não pode originar conexões com esse endereço. A configuração sobrevive à edição, CLI, salvamento e restauração.

Esse comportamento segue o parâmetro Accept_Mode do [RFC 9568, seções 6.1 e 6.4.3](https://www.rfc-editor.org/rfc/rfc9568.html). A execução em hosts tem referência operacional no [Keepalived](https://www.keepalived.org/documentation/user-guide/configuration-synopsis/). A aplicação continua um subconjunto educacional de VRRP IPv4.

Tracking observa a habilitação local de DNS, HTTP, NTP, syslog, MQTT, Modbus, DHCP, banco, RADIUS e proxy. Uma porta HTTP pode ser especificada. Ele reduz a prioridade quando o serviço é desativado e permite preempt após a recuperação. Não substitui uma transação de saúde nem detecta dados inconsistentes, dependências defeituosas ou serviço habilitado que não responde corretamente. Alterações de serviços compostos atualizam o tracking antes de permitir salvar o snapshot.

Exemplos de CLI, no contexto da interface: `vrrp 42 accept-mode`, `vrrp 42 track service dns decrement 80` e `vrrp 42 track service http:8080 decrement 80`. O painel VRRP oferece os mesmos controles. O modo padrão continua adequado ao gateway sem atendimento local no VIP.

## Modelo e falhas

O modelo **Serviços com VIP, acesso e energia redundantes** contém nove equipamentos: cliente, dois servidores, dois switches, duas UPS e dois racks. Os três endpoints usam bonds ativo/backup e alimentação A/B. DNS/HTTP têm conteúdo configurado equivalente nas duas instâncias; NTP e syslog também atendem no VIP. O cliente monitora carrier e os servidores sondam o cliente por ARP. Essa escolha evita depender, para levantar o próprio bond, de um VIP que ainda está em eleição.

Os seis presets medem baseline, perda de instância, parada de DNS, parada de HTTP e perda de cada acesso/rack. A perda de rack desliga explicitamente seu switch e sua UPS. Baseline e falhas de acesso exigem zero perda nas amostras; falhas de instância/serviço admitem até 40% em uma janela de 12 s, com sucesso final. As requisições começam a cada 1 s e têm deadline de 800 ms. Isso expõe o intervalo de eleição, sem anunciar failover instantâneo. NTP usa tolerância de 10 ms para comportar assimetria e resolução ARP neste modelo; não é um teste de PTP ou sincronismo de precisão.

O ensaio combinado revelou entradas MAC para portas sem caminho operacional, mesmo sem STP configurado. O encaminhamento descarta a entrada local inválida e aplica flooding restrito à VLAN. Uma entrada EVPN não recebe esse fallback: o controle do overlay continua estrito. O coletor de evidências syslog reconhece o VIP configurado e correlaciona a mensagem realmente recebida, inclusive se a eleição mudar depois do recebimento.

## Limites e qualificação

VRRP move o endereço e o atendimento de novas requisições. **Este incremento não replica leases, banco, logs, sessões MQTT, processo PLC ou conexões TCP de serviço entre instâncias.** As configurações equivalentes são preparadas no modelo. Não há quorum/fencing para impedir split-brain em partições; perder anúncios não prova que o outro servidor morreu. R08 permanece parcial até a replicação e as variantes completas de fábrica/enterprise, WAN e DC-GW serem implementadas e testadas por fluxo.

`tests/service-ha.test.ts` cobre DNS UDP/TCP e HTTP após failover, serviço parado com host ligado, failback, modo padrão, acesso local, origem TCP, shell, restauração determinística, configurações inválidas e snapshots após mudanças de broker/proxy/banco. `scripts/verify-service-availability.ts` executa os seis presets de serviço e os três de PLC/HMI com acesso A/B, valida relatórios e snapshots e arquiva hash da fonte, contrato e métricas. A CI completa e o navegador precisam qualificar cada revisão antes da integração à produção.
