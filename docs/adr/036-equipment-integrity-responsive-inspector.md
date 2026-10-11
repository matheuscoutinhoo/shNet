# ADR-036: integridade dos perfis e painel de equipamentos

Data: 2026-10-11. Estado: implementado no simulador.

## Capacidades e representação

O tipo interno (`pc`, `server`, `switch`, `router`) define o caminho de encaminhamento do motor, mas não define sozinho as opções do equipamento. AP e mesh usam a implementação de bridge; WLC usa a implementação de bridge com underlay IP. Isso não torna os três switches convencionais. `deviceCapabilities.ts` combina perfil, papel wireless e configuração efetivamente presente para determinar as abas e os recursos dentro de cada aba.

APs oferecem rádio, VLAN/SVI de gerenciamento, autenticação empresarial, mesh e CAPWAP/WTP. O perfil WLC oferece configuração do controlador CAPWAP, sem rádio local, LACP, VXLAN ou protocolos de roteamento de um roteador. Os ícones distinguem AP de teto, AP mesh com antenas e controlador em gabinete. As portas de rádio usam um símbolo Wi-Fi; portas ópticas, Ethernet e console têm indicações distintas. Os nomes automáticos usam AP, MESH e WLC em vez de SW.

Telefone, impressora, broker e proxy oferecem somente seus respectivos serviços. Endpoints gerais mantêm ferramentas de impressão e cliente MQTT. O dispositivo IoT oferece operações de cliente MQTT, sem se tornar um broker. Serviços DNS, DHCP, AAA, coletores e automação seguem suas capacidades; configurações adicionais já presentes continuam acessíveis. PoE distingue fonte PSE e carga PD. Serial WAN é oferecido a roteadores; console não aparece no smartphone.

Rack e patch panel são passivos: não têm botão de ligar/desligar nem opções de host. O rack não apresenta portas de rede. Portas de patch panel não recebem IP, VLAN ou configuração de switch; o painel de infraestrutura configura seus pares. UPS mantém seus controles de alimentação. A interface de portas seriais/console não oferece configuração IP Ethernet.

## Problemas encontrados e correções

- A contagem personalizada de portas convertia as duas últimas portas em SFP mesmo sem uplinks ópticos no perfil. Agora a criação de portas ópticas exige uplinks explícitos. AP, mesh e WLC têm duas portas Ethernet; telefone e impressora têm uma. O switch de acesso mantém 24 Ethernet e dois uplinks SFP; distribuição e core mantêm QSFP.
- O smartphone herdava a porta Ethernet de um PC. O perfil atual mantém somente o rádio e seu MAC próprio.
- APs herdavam abas de LACP, VXLAN/EVPN, controladores WAN e serviços genéricos por serem implementados como switches. As abas e os selects internos agora seguem as capacidades do perfil.
- Portas SVI abriam configuração L2 no editor de IPv4. O editor reconhece SVI como interface IP.
- O redimensionamento CSS nativo ficava na borda errada; as abas também comprimiam ícones e textos. O painel agora tem uma alça na borda esquerda, suporte a ponteiro e teclado, e abas em uma grade com rolagem vertical quando necessário.
- Textos de estado das portas tinham contraste insuficiente. As cores e tamanhos foram corrigidos.

Laboratórios antigos preservam interfaces e cabos. O resumo sinaliza portas ópticas ou quantidades incompatíveis, smartphone com Ethernet e nomes SW herdados por APs/WLCs. Não se removem conexões silenciosamente; a mensagem orienta a revisão e substituição pelo perfil atual. Configurações legítimas de equipamentos genéricos continuam disponíveis.

## Painel responsivo

A largura permanece ao trocar o equipamento ou fechar/reabrir os detalhes durante a sessão do laboratório. Arrastar a borda esquerda para a esquerda expande o painel. As teclas esquerda/direita ajustam 32 pixels; Home/End selecionam os limites. Um `ResizeObserver` recalcula o espaço disponível: no desktop preserva espaço para o canvas e o catálogo; em telas até 700 pixels o painel sobrepõe o canvas sem exceder a largura da tela. A alça usa captura de ponteiro e cancela corretamente gestos interrompidos. A largura não altera a topologia persistida.

## Limites conceituais identificados

Os perfis representam equipamentos fictícios, sem firmware ou equivalência a todos os modelos comerciais. O motor ainda aceita OSPF, RIP, VRRP, VPN e MPLS somente em roteadores. Switches L3 oferecem o encaminhamento inter-VLAN e BGP implementados; não recebem formulários de protocolos que o motor recusaria. A expansão desses protocolos para switches L3 exige mudanças no motor e não é simulada apenas por mostrar uma aba.

O IDS do modelo observa tráfego no caminho de encaminhamento; uma sonda passiva por SPAN/TAP não está modelada. Wi-Fi, PoE, console, mesh e as demais funções mantêm os limites documentados nos ADRs anteriores: não há simulação elétrica analógica, firmware proprietário ou garantia de interoperabilidade com equipamentos físicos. O telefone representa uma interface LAN e chamadas SIP/RTP; uma segunda porta com passagem Ethernet para PC não está modelada. O rack mantém uma interface interna inativa para compatibilidade com o formato de snapshots, sem expô-la como conector no painel.

Referências de papel e arquitetura: [CAPWAP — RFC 5415](https://www.rfc-editor.org/info/rfc5415/), [mesh e bridging Ethernet — documentação Cisco](https://www.cisco.com/c/en/us/td/docs/wireless/controller/8-5/config-guide/b_cg85/connecting-mesh-aps.html). Estas referências sustentam a separação dos papéis; não tornam o modelo uma emulação de firmware Cisco.

## Verificação

`tests/device-integrity.test.ts` cobre todos os perfis, tipos, persistência, unicidade global de MACs, mídias, capacidades negativas, auditoria não destrutiva de perfis antigos e HTTP pelo rádio dos perfis notebook/smartphone. Também verifica HTTP centralizado por CAPWAP com AP e WLC do catálogo, usando uma SVI de gerenciamento no AP. As suítes de perfis, infraestrutura, hardware, CAPWAP, mesh/IDS, aplicações, AAA e wireless verificam comportamento de protocolo.

O cenário E2E de equipamentos verifica expansão por arraste, ajuste por teclado, conservação da largura, limites mobile, opções por papel, ícones e acessibilidade. Os cenários existentes verificam configuração, tráfego, duplicação e persistência após as mudanças no painel.
