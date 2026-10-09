# ADR-028: perfis, mídia física, análise e labs avançados

Atualização: este ADR registra a etapa original. Os recursos e limites ampliados são descritos no [ADR posterior](031-network-appliances-voice-print-iot-hardware.md); ausência registrada nesta etapa não descreve o estado atual.

Data: 2026-10-07. Estado: implementado no motor educacional.

## Catálogo extensível

Os quatro tipos fundamentais continuam definindo host, bridge, roteador e servidor. Um registro de 36 perfis compõe quantidade/tipo/capacidade das portas e capacidades existentes, com identificador persistido. Adicionar um perfil de um tipo existente não exige alterar a estrutura central do motor. Perfis de DNS/HTTP/NTP/AAA/syslog/controller habilitam serviços reais; switches de distribuição/core usam portas adicionais e capacidade própria. Perfis de endpoints especializados identificam claramente quando apenas conectividade IP é modelada (sem SIP/RTP, IPP ou firmware IoT).

Fabricante/modelo são fictícios shLab. A CLI permanece NetOS, sem firmware proprietário ou emulação de comandos de outros fabricantes. Copiar um equipamento conserva o perfil e as portas com MACs novos; limpa endereços e estado aprendido para evitar copiar sessões e conflitos. CPU, memória, temperatura e potência elétrica não são inventados como métricas.

## Camada física

RJ45, SFP, QSFP e rádio são mídias distintas. Cobre usa RJ45; fibra e DAC exigem sockets iguais e módulos correspondentes. QSFP suporta 40/100 Gbps no modelo; SFP/RJ45 até 10 Gbps. DAC tem alcance de 7 m; fibra SM 10 km; MM 550 m em até 10G e 150 m em 40/100G. Esses limites são regras educacionais, sem catálogo óptico IEEE/fabricante. Velocidades diferentes tornam o enlace inoperante. MTU, capacidade, latência, jitter e perda afetam as entregas de frames. A configuração de módulos é utilizável no editor de interface e CLI; trocar módulos incompatíveis exige desconectar o cabo.

Não há serial/console, PoE, QSFP breakout, autonegociação elétrica, firmware, rack/patch panel elétricos ou transceivers por wavelength. Wireless Controller/CAPWAP, mesh 802.11s, proxy, load balancer e IDS/IPS dedicados não são anunciados como perfis funcionais. A arquitetura permite essas extensões, mas criar apenas um nome/ícone não implementaria seus conceitos.

## Análise e aprendizagem

O inspetor global inclui protocolos, overlays/QoS, segurança/AAA, automação/relógio e dependências, além de interfaces/VLANs/rotas/erros/caminho existentes. Cada linha deriva da configuração e estado do motor. Dependências mostram referência a IP e presença/energia do equipamento; não prometem conectividade. Tráfego ainda valida rotas, ACL e serviços.

Dezessete labs avançados somam-se aos seis anteriores. Falhas iniciais cobrem controle/encaminhamento de BGP/OSPF/RIP, SVI, VRF, LACP, tracking VRRP, SLAAC, wireless, VPN, SD-WAN, QoS, MPLS, EVPN, AAA, inspeção e automação. A avaliação usa cópia isolada, estado de protocolo renovado e tráfego novo. LACP/VRRP/SD-WAN também sofrem falha adicional para validar continuidade; VRF exige resposta específica de cada tabela. O guia do produto e network-concepts.md explicam causa, experimento e limite.

## Verificação

Testes cobrem persistência de todos os perfis, MACs únicos, serviços pela rede, HTTP sobre DAC/QSFP, alcance/socket/velocidade, análise, avaliações com cenário quebrado/corrigido e descarte de resultados históricos. A API salva perfis e avalia labs avançados. E2E cobre editor de transceiver, duplicação, análise, correção SVI e progresso persistido em desktop/mobile.
