# ADR-022 — Wireless, associação e transporte pelo rádio

Atualização: este ADR registra a etapa original. Os recursos e limites ampliados são descritos no [ADR posterior](032-wireless-controller-mesh-enterprise-ids.md); ausência registrada nesta etapa não descreve o estado atual.

Status: implementado como modelo educacional.

## Rede e associação

Um switch pode atuar como AP/bridge; PC e servidor podem adicionar o rádio Wlan0 como cliente. A interface de rádio participa do encaminhamento Ethernet, com broadcast/multicast, ARP, DHCP, TCP/HTTP e IPv6/NDP. Wlan0 do AP usa access VLAN para associar o SSID ao domínio de broadcast. Dois clientes podem comunicar pela mesma interface compartilhada; ela não é tratada como cabo ponto a ponto exclusivo.

APs transmitem beacons periódicos. O cliente registra BSSID, SSID, segurança e RSSI recebidos, escolhendo o melhor candidato compatível que ouviu no canal configurado. Autenticação e associação usam PDUs serializadas, com token de negociação e nonce. Rede aberta libera dados após associação. WPA2-PSK exige a troca key1/key2/key3/key4 e autorização; WPA3-SAE acrescenta uma troca didática de commit/confirm antes da associação e das mensagens de chave. Credencial incompatível é recusada e dados permanecem bloqueados. As etapas de associação e troca de quatro mensagens refletem conceitos descritos pela [Cisco](https://www.cisco.com/c/en/us/support/docs/wireless-mobility/wireless-lan-wlan/116493-technote-technology-00.html).

Cliente envia keepalive. Beacons ausentes, AP desligado, canal incompatível ou perda de alcance desfazem a associação, iniciando nova busca. Outro AP compatível pode receber a associação; isso não garante preservação de sessões L3 nem mudança de sub-rede. Negociações perdidas são reiniciadas com limite e intervalo de nova tentativa. Depois da autorização, frames de dados são selados em ciphertext didático por cliente, com tag de integridade e janela anti-replay de 64 sequências. O frame protegido não carrega o ARP/IP em claro; a interface autorizada abre o payload antes do forwarding. A chave fica na configuração persistida e não é incluída nas PDUs ou nos eventos CLI; a configuração exibida pelo terminal mascara a chave.

## Rádio e interferência

Enlaces wireless são criados entre APs e clientes próximos. O canvas usa escala didática de quatro pixels por metro. RSSI é potência mínima dos dois rádios menos perda logarítmica pela distância, atenuação configurada e penalidade de banda 5 GHz. Ruído configurado e APs ativos em canais sobrepostos reduzem SNR. A banda 2.4 GHz usa sobreposição decrescente até cinco canais de separação; a banda 5 GHz usa interferência co-channel. O planejamento 1/6/11 em 2.4 GHz ilustra o conceito de canais não sobrepostos apresentado pela [Cisco](https://www.cisco.com/en/us/support/docs/wireless/aironet-340-series/8117-connectivity.html).

RSSI/SNR insuficientes tornam o rádio indisponível. Perda probabilística determinística pela seed, latência e taxa de serialização variam com SNR/interferência e afetam PDUs e dados. Mover o cliente, mudar canal ou introduzir um AP interferente altera tráfego e associação; os valores não são resultados de sucesso pré-calculados. Selecionar um AP mostra uma área circular de cobertura aproximada calculada pelo modelo. A propriedade do enlace permite interromper/restaurar o caminho; potência, canal e obstáculos são configurados no rádio.

## Uso e persistência

O catálogo inclui Access point. A aba Wireless configura SSID, segurança, chave, banda, canal, potência, ruído e atenuação; apresenta associação, clientes, APs descobertos e medidas de sinal. Configure IPv4/DHCP ou IPv6 em Wlan0 pelas abas existentes. O template **Do rádio à resposta HTTP** usa SSID Campus, canal 1 e chave Wireless-123; HTTP em 192.168.50.20 atravessa rádio e bridge.

```text
enable
conf t
wireless client ssid Campus security wpa2-psk key Wireless-123 channel 1 band 2.4
interface Wlan0
ip address dhcp
end
show wireless radio
show wireless scan
```

PDUs pendentes, estado de negociação, vizinhos e timers são persistidos. Validação verifica interface, papel, canais, temporizadores e enlaces compartilhados. Testes cobrem associação, rejeição de credencial, canais/SSID distintos, interferência, perda de alcance, retorno, troca de AP, dois clientes, DHCP, ICMPv6, HTTP, CLI/rollback e continuação após restauração, ciphertext pendente, integridade e anti-replay.

## Limites

WPA2/WPA3 são conceitos de negociação e controle de acesso neste simulador: a prova usa um digest determinístico educacional, e o payload usa uma cifra de fluxo didática sem garantias criptográficas. Não implementa PBKDF2, HMAC, CCMP/GCMP, grupos SAE, cifragem padronizada, segurança real ou quadros binários completos de 802.11/EAPOL. O modo WPA3 não pode ser usado para avaliar resistência criptográfica. Não há 802.1X empresarial nesta etapa, WLC/CAPWAP, mesh, DFS, MIMO/OFDMA, escolha automática de canal/banda, power saving, 802.11r/k/v, espectro por tempo nem CSMA/CA/ACK/retransmissão MAC completo. Perda, latência e taxa são aproximações, não uma previsão de cobertura para instalações reais. WPA/SSID não são contas de usuário do produto.
