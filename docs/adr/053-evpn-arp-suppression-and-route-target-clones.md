# ADR-053 — supressão ARP EVPN e clonagem de route targets

Data: 15/10/2026. Contrato `2026.10.15.5`; incremento R18 em qualificação.

## Decisão

`proxyArp` é opcional e desabilitado nos modelos existentes. Requer EVPN e política de peers estrita. O VTEP pode responder a uma solicitação ARP broadcast recebida de uma porta local quando existe um único binding remoto MAC/IP elegível, importado para o VNI/RT correto, com sessão BGP estabelecida, membro IMET correspondente e rota underlay operacional. A resposta usa a MAC real anunciada, e o fluxo subsequente continua pelo overlay. O evento `EVPN_ARP_REPLIED` informa binding, VNI, RT e VTEP.

O modelo segue o uso de bindings MAC/IP para reduzir flooding descrito na [RFC 7432, seção 10](https://www.rfc-editor.org/rfc/rfc7432#section-10). Não responde em nome de endereços desconhecidos, bindings ambíguos com MACs diferentes ou hosts locais conhecidos. Ingresso por VXLAN, ARP gratuito, atualizações unicast e probes com origem `0.0.0.0` continuam pela rede. Isso preserva probes de saúde/DAD e evita transformar uma resposta de cache local em uma alegação de presença da VM.

A supressão usa o estado do plano de controle, que pode permanecer desatualizado até uma retirada/expiração BGP. Não verifica a aplicação remota a cada resposta, nem implementa proxy NDP, ESI/DF ou mecanismos adicionais de detecção. Falha real de tráfego continua sujeita aos cenários e SLAs medidos.

## Interface e persistência

O formulário VNI expõe **Supressão ARP EVPN**, junto à política estrita. CLI `vxlan configure` e running-config preservam o campo. Estados legados sem o campo mantêm seu comportamento. Configuração inválida é recusada antes de modificar o dispositivo. Snapshots preservam respostas em trânsito; eventos mostram que a resposta veio do VTEP.

Clonar uma topologia passa a alocar RTs livres dentro dos formatos AS16/local32 e AS32/local16. O RT não precisa ter o mesmo número do VNI. Portas que compartilhavam RT continuam compartilhando o novo RT; tenants com RTs diferentes permanecem separados, inclusive quando usam o mesmo VNI original. VNIs altos não estouram o campo de 16 bits de um RT com AS32. As cópias começam desativadas para revisão, como antes.

## Verificação

Testes de controle/dados cobrem resposta local, ping/HTTP, flooding de destino desconhecido, ausência de IMET, underlay indisponível, RT divergente, bindings ambíguos, probes, ARP gratuito, VLAN, restauração e running-config. A clonagem testa VNI 70000, AS32, compartilhamento e isolamento de RT. Navegadores verificam o diagnóstico, o formulário, salvar/reabrir e a tela mobile nos dois temas. [Evidências](../../artifacts/evpn-arp-2026-10-15/VALIDACAO.md).

R18 continua parcial: ECMP/BFD, underlay/VRFs dinâmicos e IPv6, RR EVPN, ESI/DF/multihoming e Type 5 permanecem no [plano consolidado](../consolidated-remediation-plan.md).
