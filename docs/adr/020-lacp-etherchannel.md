# ADR-020 — LACP e encaminhamento EtherChannel

Status: implementado no modelo educacional.

## Comportamento

Cada Port-channel reúne até oito portas físicas e mantém uma interface de forwarding. PDUs LACP com actor/partner atravessam os cabos para negociar o parceiro; active inicia a troca e passive responde. Dois lados passive permanecem suspensos. Os números de grupo são locais: parceiros podem usar keys diferentes. O modelo segue esses conceitos de [configuração EtherChannel/LACP](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-3/configuration_guide/b_173_lyr2_9500_cg/configuring_etherchannels.html).

Um membro só distribui/coleta após receber o reconhecimento de seu system/key/port, com carrier e parceiro compatível com os outros membros selecionados. PDUs são periódicos a cada segundo e expiram em três segundos. `min-links` exige o mínimo local de membros sincronizados. Um hash determinístico de endereços/protocolo/portas mantém cada sentido de um fluxo em um membro; broadcast é transmitido uma vez. Ao perder um membro, o hash usa os restantes, sem consulta global às tabelas do parceiro.

Frames de controle são consumidos no enlace e não são inundados como tráfego de usuário. Tráfego recebido em um membro sincronizado entra pela interface agregada: a tabela MAC aponta para Port-channel e VLAN/access/trunk é aplicada nessa interface. STP atua no agregado; as portas membros não mantêm estados independentes de spanning tree. Isso evita tratar os membros como enlaces paralelos de forwarding.

Port-channel suporta switching e modo routed. Subinterfaces 802.1Q podem usar o agregado como parent. IPv4/ARP/TCP/BGP passam pelo mesmo caminho e carrier considera membros sincronizados. Os membros físicos não podem carregar IPv4, DHCP, VRF ou políticas locais conflitantes. MTU/ACL da interface agregada são aplicadas antes da transmissão física.

## Configuração e persistência

```text
enable
configure terminal
interface Gi0/1
channel-group 1 mode active
interface Gi0/2
channel-group 1 mode active
interface Port-channel1
switchport mode trunk
switchport trunk allowed vlan 1,10,20
lacp min-links 1
end
show etherchannel summary
show lacp neighbors
```

Configure o parceiro com active ou passive. `no channel-group` retira a interface física; `no port-channel NUMBER` remove um agregado desocupado. A aba **LACP** cria/edita grupos e apresenta parceiros e collecting/distributing; **Portas** configura VLAN/IP na interface agregada. O template **Dois cabos, um enlace** demonstra negociação, STP e falha de membro.

Snapshot conserva PDUs recebidos, seleção, tokens e um timer por agregado. Validação recusa membros/referências/timers inválidos, cabos em Port-channel, velocidade incompatível e seleção divergente dos anúncios/carrier. Restaurar negociação ou um agregado já estável produz a mesma execução determinística.

## Limites

- LACP educacional com PDUs tipados, multicast de controle e actor/partner; sem TLVs/checksum binários nem todas as máquinas IEEE 802.1AX.
- Sem PAgP, modo estático `on`, MLAG, stacking, hot standby de membros, negociação slow/fast configurável ou limite de banda compartilhado por fila. O grupo usa um modo LACP comum a todos os membros.
- Cada fluxo utiliza um membro por sentido. Agregar não aumenta a velocidade de um único fluxo. Serialização utiliza a velocidade da porta física; filas/congestionamento são um bloco separado.
- Reconfigurar o grupo reinicia sua negociação e, quando habilitado, a árvore STP local. A falha de membro não exige recriar o agregado.

## Verificação

Sete testes verificam active/passive, passive/passive, keys distintas, min-links, broadcast sem duplicação, MAC pelo agregado, hash por fluxo, VLAN/trunk, STP, falha com HTTP, BGP/TCP em subinterfaces e persistência durante negociação/estado estável. A API salva negociação pendente e rejeita membros/timers adulterados.
