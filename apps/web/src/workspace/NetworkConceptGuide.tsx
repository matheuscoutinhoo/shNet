import { useState } from 'react';
const topics = [
  [
    'BGP / OSPF / RIP',
    'O protocolo de controle aprende destinos. A tabela instalada escolhe o próximo salto; ARP e o enlace ainda precisam funcionar.',
    'Compare vizinhos e rotas com o HTTP. Retire um anúncio e repita o tráfego.',
    'OSPF inclui áreas stub/NSSA, externos E1/E2, checksum e HMAC; RIP inclui next-hop, filtros, hold-down e codec RIPv2 com SHA-256. BGP e OSPF usam PDUs tipadas.',
  ],
  [
    'SVI / subinterfaces / VRF',
    'VLAN separa broadcast. Uma interface L3 resolve o gateway; VRF seleciona uma tabela independente, inclusive com IPs sobrepostos.',
    'Use os labs do switch L3 e de VRF. Compare ARP, interfaces e resposta HTTP de cada tabela.',
    'Não há route leaking automático; configure a tabela de cada fluxo.',
  ],
  [
    'LACP / gateway VRRP',
    'LACP negocia membros antes de encaminhar pelo agregado. VRRP elege um gateway; tracking reduz a prioridade quando o caminho observado falha.',
    'Desligue um membro LACP ou o uplink do primário VRRP e envie uma nova conexão.',
    'Não equivale a todas as máquinas IEEE de agregação nem a HSRP proprietário.',
  ],
  [
    'IPv6 / NDP / SLAAC',
    'DAD verifica duplicação; RA anuncia prefixos e gateways; NDP resolve o vizinho do próximo salto usando multicast.',
    'Compare endereço tentative/preferred, tabela NDP e ping com Hop Limit 1.',
    'TCP, UDP/echo e DHCPv6 atravessam rotas, VRF, ACL e NDP. DHCPv6 oferece IA_NA/IA_PD; RA fornece o gateway.',
  ],
  [
    'Wireless',
    'O cliente escolhe rádio compatível e autentica antes de associar. Sinal, distância, canal e interferência influenciam perdas e capacidade.',
    'Erre a chave, observe falha, corrija e envie HTTP. Afaste o notebook ou altere canal e compare o RSSI.',
    'PEAP/TLS valida certificados e deriva chaves para AES-GCM. WLC/CAPWAP e mesh encaminham dados pela rede. RF e certificados são modelos limitados, sem chipset ou interoperabilidade binária completa.',
  ],
  [
    'VPN / SD-WAN',
    'O túnel depende de rotas e conectividade do underlay. SD-WAN mede RTT/perda e aplica a política de transporte ao tráfego correspondente.',
    'Inspecione a negociação UDP, a política recebida e o caminho após queda do primeiro transporte.',
    'INIT/AUTH, DH X25519, AES-GCM, SPI, selectors e rekey são simulados. PDUs IKE/ESP tipadas não oferecem interoperabilidade com VPN externa.',
  ],
  [
    'QoS / MPLS',
    'QoS classifica frames e escolhe quem usa a capacidade da saída. MPLS classifica uma FEC e encaminha pela pilha e LFIB.',
    'Reduza capacidade, compare DSCP/filas/drops. No MPLS, acompanhe push, swap e pop até o HTTP.',
    'Filas físicas simplificadas e MPLS estático; sem LDP/RSVP ou ASIC.',
  ],
  [
    'VXLAN / EVPN',
    'VXLAN transporta Ethernet em UDP pelo underlay. EVPN anuncia onde o MAC/IP está; route targets controlam importação.',
    'Compare VLANs locais distintas com o mesmo VNI, rotas MAC/IP e frames UDP/4789.',
    'Subconjunto MAC/IP educacional; sem multihoming/DF, type-5 ou codec MP-BGP.',
  ],
  [
    '802.1X / AAA / firewall',
    'O supplicant responde ao authenticator; RADIUS autoriza o MAC/VLAN. TACACS+ autoriza o terminal. Inspeção de aplicação classifica HTTP/DNS em claro.',
    'Compare a porta antes/depois do Access-Accept e teste Host HTTP permitido/bloqueado.',
    'CHAP/RADIUS e TACACS+ têm codecs em octetos, políticas de comandos e accounting. IDS/IPS detecta assinaturas e taxas. O controlled port cabeado aceita um MAC por porta.',
  ],
  [
    'Automação / telemetria / NTP',
    'Candidate separa proposta de configuração ativa. Jobs aguardam respostas reais. Telemetria envia sensores; NTP mede quatro timestamps para corrigir o relógio do equipamento.',
    'Faça edit-config, validate e commit. Compare offset, stratum e sensores do coletor com os contadores de interface.',
    'NETCONF usa XML/framing/capabilities e RESTCONF recursos HTTP/ETag. O modelo TLS usa criptografia real e certificados tipados; NTP não disciplina frequência ou UTC real.',
  ],
  [
    'Mídia / transceivers',
    'Socket, módulo, velocidade e alcance devem combinar antes de transmitir. Capacidade serializa os bytes; perda e latência afetam cada entrega.',
    'Conecte SFP/QSFP com módulo correspondente; compare DAC de 7 m com fibra. Provoque diferença de velocidade.',
    'PoE negocia classe e orçamento de energia; serial usa DCE/DTE, clock e FCS; console fornece terminal sem IP. Alcances e elétrica são regras do modelo.',
  ],
];
export function NetworkConceptGuide() {
  const [index, setIndex] = useState(0),
    topic = topics[index];
  return (
    <section className="learning-card">
      <h3>Conceitos de rede</h3>
      <label>
        Conceito para explorar
        <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
          {topics.map((t, i) => (
            <option key={t[0]} value={i}>
              {t[0]}
            </option>
          ))}
        </select>
      </label>
      <p>{topic[1]}</p>
      <p>
        <strong>Experimento:</strong> {topic[2]}
      </p>
      <p className="muted">{topic[3]}</p>
    </section>
  );
}
