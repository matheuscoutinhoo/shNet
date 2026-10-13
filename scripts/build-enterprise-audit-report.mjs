import { readFileSync, writeFileSync } from 'node:fs';
import console from 'node:console';
const out = 'artifacts/enterprise-datacenter-audit';
const read = (name) => JSON.parse(readFileSync(out + '/' + name, 'utf8'));
const main = read('scenario-results.json'),
  protocols = read('protocol-results.json');
const ui = read('ui-results.json'),
  api = read('api-results.json'),
  scale = read('scale-results.json');
const diagnostic = read('diagnostics.json'),
  regression = read('regression-tests.json');
const matrix = [...main.results, ...protocols.results];
const findings = [
  [
    'ED01',
    'P0',
    'Lacuna de segurança',
    'Política de zonas IPv4 não protege IPv6',
    'P-DUALSTACK-ZONES; P-DUALSTACK-HTTP; P-DUALSTACK-ACL',
    'GUEST→ERP é negado em IPv4, mas ping e HTTP IPv6 chegam. ACL IPv6 explícita bloqueia o ping.',
    'Pipeline IPv6 usa ACL própria e não consulta o firewall por zonas. A matriz de fidelidade não explicita essa diferença.',
    'R01',
  ],
  [
    'ED02',
    'P0',
    'Bug',
    'Relatório aceita recuperação incoerente com as amostras',
    'P-REPORT-CONSISTENCY; api-results.json',
    'Recuperação original de 2072,426 ms/observedFailure=true substituída por 0/false; schema e API aceitam, HTTP 200, resultado persistido.',
    'O validador confere nomes/resolução, mas não recalcula recoveryMs/observedFailure. Não comprova execução independente no servidor.',
    'R02; R15',
  ],
  [
    'ED03',
    'P1',
    'Bug de interface',
    'Rótulos sem contraste em canvas claro com tema escuro',
    'ui-results.json; screenshots/desktop.png',
    'Axe: color-contrast serious em 30 elementos. Exemplos: texto #c5d8e5 sobre #ffffff, razão 1,46.',
    'Cores dos rótulos acompanham o tema da aplicação sem considerar o fundo escolhido para o canvas.',
    'R03',
  ],
  [
    'ED04',
    'P1',
    'Limitação',
    'Dois spines não garantem failover do VXLAN',
    'D11; D12; D13',
    'Perda SPINE-2 mantém HTTP; perda SPINE-1 interrompe; retorno recupera. Todos os leaves têm dois enlaces e rotas alternativas.',
    'VTEP ligado a p1; resolveUnderlay/sendVxlanFrame/receiveVxlan restringem o transporte à interface configurada. Rotas usam estado administrativo e não oferecem ECMP.',
    'R06; R18',
  ],
  [
    'ED05',
    'P1',
    'Limitação e validação ausente',
    'Route target divergente não isola peers estáticos no mesmo VNI',
    'D16; D17; P-PREFLIGHT-RT',
    'RIB importada fica vazia, mas HTTP continua por flooding/aprendizado de peers estáticos; preflight não alerta.',
    'RT controla importação de MACs no modelo. VNI e peers controlam o plano de dados. Não tratar RT sozinho como barreira de segurança.',
    'R07',
  ],
  [
    'ED06',
    'P1',
    'Configuração e validação ausente',
    'DHCP de backup depende de pool para seu giaddr',
    'E08; E14; P-DHCP-backup-pool; P-PREFLIGHT-DHCP',
    'Pool somente para 10.60.10.2 atende o primário e falha no backup .3, apesar de ambos terem relay. Pool adicional não sobreposto recupera a concessão.',
    'A regra atual de preflight detecta relay ausente, mas não confere cobertura dos pools por endereço do relay.',
    'R05; R08',
  ],
  [
    'ED07',
    'P2',
    'Melhoria de análise',
    'Avisos de IP duplicado não consideram o domínio L2/VNI',
    'D02; D03; D04; P-PREFLIGHT-TENANTS',
    'Dois avisos DUPLICATE_IP para endereços intencionalmente sobrepostos em VNIs isolados. Tráfego de cada tenant chega ao servidor correto.',
    'Heurística global por nome de VRF/IP não reconstrói domínios de broadcast e contexto do endpoint.',
    'R22',
  ],
  [
    'ED08',
    'P1',
    'Recurso ausente',
    'Executor de cenários não aceita IPv6 nem seleção de VRF',
    'U01; U02; P-VRF-BLUE; P-VRF-RED',
    'Schema recusa endereço IPv6 e campo vrf. O motor executa IPv6 e TCP nas duas VRFs separadamente.',
    'Cobertura automática inferior à capacidade do motor; cenários de segurança dual stack ficam fora do executor nativo.',
    'R11',
  ],
  [
    'ED09',
    'P2',
    'Melhoria de produto',
    'Nenhum preset enterprise/datacenter para a topologia completa',
    'ui-results.json; templates.ts',
    'Zero opções Modelo na topologia de 38 equipamentos. Executar cinco fluxos exige editar JSON; menu/modal ainda se chamam fábrica.',
    'Templates campus/EVPN existentes são demonstrações pequenas, sem matriz integrada de HA/segurança e assistente de cenários.',
    'R12; R21',
  ],
  [
    'ED10',
    'P1',
    'Fidelidade parcial',
    'PCAP não inclui VXLAN e BGP interoperáveis',
    'P-PCAP; diagnostics.json',
    `${diagnostic.pcap.excluded['Payload UDP VXLAN sem codec binário.']} frames VXLAN e ${diagnostic.pcap.excluded['Aplicação TCP bgp usa enquadramento didático.']} BGP omitidos, além de ${diagnostic.pcap.excluded['Envelope didático ou enlace sem codec Ethernet interoperável.']} envelopes sem codec. Exportação informa as exclusões.`,
    'Mensagens do overlay/controle usam envelopes didáticos. Não é um arquivo completo para validação externa de EVPN.',
    'R19',
  ],
  [
    'ED11',
    'P2',
    'Fidelidade parcial',
    'Fabric de datacenter não implementa todos os recursos de produção',
    'docs/adr/025-vxlan-evpn.md; ipv4.ts; vxlan.ts',
    'Inspeção confirma ausência de RR EVPN, ESI/DF, IMET, Type 5, proxy ARP e MAC/IP IPv6 no controle. Underlay/VRF dinâmico completo não está disponível.',
    'Limites documentados do modelo educacional, sem emulação de ASIC/firmware ou MP-BGP binário.',
    'R18; R19',
  ],
  [
    'ED12',
    'P1',
    'Risco do desenho',
    'SPOFs e ausência de replicação de estado continuam',
    'E18; E19; D07; D10; D19; D20; P-HA-EXISTING-TCP',
    'Switch de acesso, DNS, LB, gateway DC/WAN e serviços únicos não têm HA completo. Sessão echo recebia before|, permanece ESTABLISHED, mas after| não chega após failover; backup tem zero sessões.',
    'VRRP protege gateway e novas sessões; não replica firewall/NAT/estado de serviço. UPS única do LB não representa alimentação A/B.',
    'R08; R09; R10',
  ],
  [
    'ED13',
    'P2',
    'Limite de evidência e desempenho',
    'Carga de fabric esgota a retenção de captura',
    'scale-results.json; ui-results.json',
    'Perfis 38/62/86: 1/25/49 pings entregues; descartes da captura 0/487/2642. Realtime 5× acompanha aproximadamente 92,7% do ritmo solicitado nesta medição.',
    'Retenção de 2 MiB é deliberadamente limitada; descarte não é perda de pacote. Uma medição local não comprova escala de produção ou vazamento de memória.',
    'R23',
  ],
  [
    'ED14',
    'P1',
    'Bug de convergência',
    'Editar edge de uma porta desconectada reinicializa o bridge',
    'P-RSTP-PORT-EDIT; diagnostics.json',
    'ACCESS-USERS p20 muda forwarding→discarding ao editar p3 sem cabo. HTTP falha nos primeiros 5 s e volta após reconvergência.',
    'setSpanningTreePort chama rebuildSpanningTree e initialize no equipamento inteiro. DHCP snooping passou depois de aguardar essa convergência.',
    'R04',
  ],
  [
    'ED15',
    'P2',
    'Documentação',
    'Matriz de capacidades e documentação ainda divergem',
    'docs/protocols.md:63; fidelity.ts; ADR-018; ADR-025',
    'Texto afirma ausência de IP de gerência em switch L2 apesar da correção entregue. Matriz genérica não detalha IPv6 do firewall, VRFs, codecs EVPN ou underlay preso à porta.',
    'Atualização das entregas não foi refletida em todas as descrições e superfícies de produto.',
    'R26',
  ],
].map(([id, priority, kind, title, evidence, observed, cause, plan]) => ({
  id,
  priority,
  kind,
  title,
  evidence: evidence.split('; '),
  observed,
  cause,
  plan: plan.split('; '),
  status: 'aberto',
}));
const rows = [
  [
    'R01',
    0,
    'P0',
    'ED01; L10',
    'Impedir falsa aprovação de segurança dual stack',
    'Expor o alcance IPv4 das zonas, emitir preflight para IPv6 sem política e aplicar políticas equivalentes de IPv6/IPv4 ou recusar cenário incompatível. Preservar NDP e erros necessários.',
    'GUEST→ERP/PLC negado em ICMP/TCP nas duas famílias; retorno autorizado funciona; regra ausente não recebe selo de segurança.',
    '',
  ],
  [
    'R02',
    0,
    'P0',
    'ED02; U05',
    'Validar recuperação com base nas amostras',
    'Recalcular recoveryMs, observedFailure e resolução no servidor; validar null, ausência de recuperação, múltiplas falhas e cada fluxo. Rotular resultados anteriores como não revalidados.',
    'Relatório adulterado do ensaio recebe HTTP 400; relatório original e retry idêntico passam; métricas exibidas coincidem com as amostras.',
    '',
  ],
  [
    'R03',
    1,
    'P1',
    'ED03; U02',
    'Corrigir contraste das topologias',
    'Usar cores de nós/rótulos conforme fundo do canvas; validar combinações de tema/fundo, semantic zoom e seleção.',
    'Zero violações color-contrast no caso de 38 nós; legibilidade desktop/mobile em fundos claro/cinza/escuro.',
    '',
  ],
  [
    'R04',
    1,
    'P1',
    'ED14; B04',
    'Editar RSTP sem reinicializar portas não afetadas',
    'Recalcular papel/custo/edge somente onde necessário; conservar informações válidas, timers e acordos das demais portas.',
    'Editar edge em p3 desconectada mantém p20 forwarding e fluxo ERP; mudanças reais convergem sem loops; RSTP/LACP e snapshot continuam determinísticos.',
    '',
  ],
  [
    'R05',
    1,
    'P1',
    'ED06; D03; U04',
    'Validar relay e pools no HA DHCP',
    'Relacionar giaddr/pools/escopos em todos os membros; alertar cobertura ausente, sobreposição e servidor único; revisar templates e renovação/rebinding.',
    'Preflight identifica pool ausente de FW-B; novas concessões e renovação após failover funcionam sem IPs conflitantes.',
    'R04',
  ],
  [
    'R06',
    1,
    'P1',
    'ED04',
    'Permitir failover real do underlay',
    'Introduzir endpoint VTEP estável/loopback e resolução por interfaces operacionais, desacoplar origem de egress/ingress, retirar nexthops sem carrier e testar caminhos alternativos.',
    'D12 passa com SPINE-1 fora; restauração não quebra overlay; tráfego bidirecional, MTU e BGP reconvergem dentro do SLA por fluxo.',
    'R04',
  ],
  [
    'R07',
    1,
    'P1',
    'ED05; U04',
    'Validar isolamento EVPN nos planos de controle e dados',
    'Definir modo EVPN estrito e política de flooding/peers; alertar RT divergente no mesmo VNI. Validar isolamento por VNI/VRF/ACL com ensaios negativos.',
    'Divergência RT é alertada; controle e dados têm comportamento explícito. Tenant B nunca recebe resposta de A; nenhuma aprovação baseada somente em RIB vazia.',
    'R01',
  ],
  [
    'R08',
    1,
    'P1',
    'D03; ED06; ED12',
    'Implementar HA de serviços, WAN e alimentação',
    'Definir primário/backup e replicação de DNS, DHCP, MES, SCADA, broker, RADIUS, NTP, syslog, LB e banco quando aplicável; redundância DC-GW/WAN e alimentação A/B.',
    'Desligar uma instância, gateway, WAN ou fonte prevista preserva cada fluxo crítico no SLA; dados/leases/sessões de serviço continuam consistentes.',
    'R02; R05; R06',
  ],
  [
    'R09',
    1,
    'P1',
    'D02; D03; ED12',
    'Replicar estado de firewall/NAT',
    'Sincronizar sessões/tuplas, tradução NAT e expiração entre membros; distinguir continuidade de sessão existente de nova conexão.',
    'P-HA-EXISTING-TCP recebe after| após failover; cenários PAT e retorno assimétrico não vazam nem bloqueiam fluxos legítimos.',
    'R02; R08',
  ],
  [
    'R10',
    1,
    'P1',
    'D04; ED12',
    'Eliminar domínios únicos de acesso e endpoint',
    'Modelar duas interfaces/caminhos de hosts e PLC/HMI, switches alternativos e bonding compatível; conferir destino de cada carga UPS e perdas de rack/célula.',
    'Perda de um switch/NIC/caminho previsto mantém PLC/HMI e servidores críticos ou demonstra interrupção dentro do SLA declarado.',
    'R06; R08',
  ],
  [
    'R11',
    2,
    'P1',
    'ED08; U01',
    'Ampliar executor para IPv6 e VRF',
    'Adicionar família, VRF e escopo; considerar referências de origem/target e interfaces; suportar ICMP/HTTP IPv6 e serviços compatíveis com limites explícitos.',
    'U01/U02 passam; cenários dual stack e IPs sobrepostos executam sem cruzar tenants; API/Worker/report validam o mesmo contrato.',
    'R01; R02',
  ],
  [
    'R12',
    2,
    'P1',
    'U01; ED09',
    'Entregar matriz completa na interface',
    'Migrar os 42 casos de fábrica; criar modelos enterprise/DC completos e presets dos 73 ensaios aplicáveis. Oferecer edição por formulário e assertions de rota, EAP, BGP/EVPN, LB, MTU e energia.',
    'Matriz catalogada com caso, requisito e evidência; execução nativa dispensa scripts para os casos suportados; lacunas são recusadas ou indicadas.',
    'R04; R05; R11',
  ],
  [
    'R13',
    2,
    'P1',
    'U01',
    'Adicionar ações de checkpoint e restauração',
    'Programar snapshot/restore no executor preservando timers, filas, captura, versão e revisão; implementar rollback de configuração com diff.',
    'Restaurar durante DHCP/TCP/BGP/Modbus gera mesmo estado serializado e resultado; evidência liga antes/depois à origem correta.',
    'R02; R11',
  ],
  [
    'R14',
    2,
    'P1',
    'U05; ED05; ED10; ED13',
    'Melhorar causalidade e métricas de SLA',
    'Correlacionar NAT, proxy/LB, overlay, retries e evidências descartadas; separar timeout de bloqueio de política. Usar timestamps de resposta/evento para recovery e declarar resolução/percentis/jitter. Ampliar a análise binária após R19.',
    'Cada negação exigida por política mostra regra ou permanece inconclusiva; caminho intermediado é rastreável; recovery não promete precisão maior que a medição.',
    'R02; R11',
  ],
  [
    'R15',
    2,
    'P1',
    'U05; ED02',
    'Confiabilidade e ciclo de vida dos ensaios',
    'Identificar build/commit/schema do motor; marcar execução no cliente; validar resultado contra execução autoritativa quando exigido. Timeout/cancelamento recuperável de registros running e erro de persistência com retry durável.',
    'Fechar navegador/Worker não deixa execução indefinidamente running; resultado não salvo reaparece para retry; relatórios não confundem hash da origem com atestado de execução.',
    'R02; R13',
  ],
  [
    'R16',
    3,
    'P1',
    'L01; L09',
    'Transportar Modbus binário e exportar PCAP',
    'Substituir hex+newline por bytes MBAP/PDU no transporte; codec Ethernet/IP/TCP coerente, exceções e framing TCP segmentado.',
    'Decodificador independente interpreta requests/responses 03/06/16 e exceções; snapshots e cenários existentes permanecem válidos.',
    'R13; R19',
  ],
  [
    'R17',
    3,
    'P1',
    'L01; L05',
    'Ampliar o comportamento industrial contratado',
    'Coils/input registers e funções necessárias; ciclos PLC/HMI, alarmes e processo. Definir cargas MES/SCADA e vídeo se requerido.',
    'Ciclos e falhas produzem estados verificáveis, com latência/carga/SLA por célula; substituir HTTP por comportamento contratado sem alegar firmware real.',
    'R08; R10; R16',
  ],
  [
    'R18',
    3,
    'P2',
    'ED04; ED11',
    'Ampliar fabric e multitenancy de datacenter',
    'ECMP/BFD, underlay dinâmico, VRFs dinâmicas e IPv6 conforme contrato; RR EVPN, ESI/DF/multihoming, IMET, Type 5 e proxy ARP em etapas independentes.',
    'Dois spines efetivamente ativos; retirada/mobilidade/partição de leaf/RR não provocam vazamento ou loop; versões e recursos suportados explícitos.',
    'R06; R07; R11',
  ],
  [
    'R19',
    3,
    'P1',
    'L09; ED10',
    'Adicionar codecs para captura interoperável',
    'Codecs VXLAN/UDP e controle BGP/EVPN, depois protocolos de gestão/aplicação prioritários; validar campos/tamanhos/checksums e preservar relatório de exclusões.',
    'Tráfego selecionado é decodificado externamente; número de registros e omissões é consistente. Exportação incompleta continua explicitamente incompleta.',
    'R14',
  ],
  [
    'R20',
    4,
    'P2',
    'L07',
    'Concluir recursos MQTT necessários',
    'QoS 2, TLS, persistência de sessão, reconexão e assinaturas QoS>0; avaliar HA/replicação de broker com estado.',
    'Perda/reconexão preserva semântica contratada de entrega; QoS 1 entregue não é tratado como QoS 2.',
    'R08; R19',
  ],
  [
    'R21',
    4,
    'P2',
    'U02; U03; ED09',
    'Operar e desenhar topologias maiores',
    'Autolayout, agrupamento de trunks/Port-channels, vistas física/lógica; clonagem de célula/rack com remapeamento IP/VLAN/MAC/referências; edição em lote de VLAN/rotas/políticas.',
    'Criar e operar células/racks sem colisões ou referências órfãs, com diff/undo; seleção e enlaces legíveis desktop/mobile.',
    'R03; R12',
  ],
  [
    'R22',
    4,
    'P2',
    'U04; ED07',
    'Preflight baseado em domínio de rede',
    'Reconstruir domínio L2/VLAN/VNI/VRF e papéis; analisar gateways, rotas, MTU de encapsulamento, políticas IPv4/IPv6, falhas de alimentação e peers.',
    'Sobreposição entre VNIs isolados não gera conflito; duplicação real no mesmo domínio é detectada; recomendações indicam evidência e limite da análise.',
    'R05; R07; R11',
  ],
  [
    'R23',
    4,
    'P2',
    'Desempenho; ED13',
    'Medir e otimizar escala e retenção',
    'Perfis integrados de campus/fabric/cargas concorrentes, p95 de UI/Worker, heap estável e atraso realtime; reduzir bundles e delta/snapshot. Captura incremental/streaming e políticas por ensaio.',
    'Orçamentos definidos por perfil e regressão repetível; nenhum crescimento ilimitado; evidência truncada é sinalizada no resultado; descarte da captura distinto de perda de rede.',
    'R12; R14',
  ],
  [
    'R24',
    4,
    'P2',
    'U06',
    'Colaboração com autorização e autoria',
    'RBAC de equipe no servidor, autoria/histórico de alterações e edição simultânea autoritativa; manter locks/revisões/diff existentes.',
    'Papéis têm permissões verificadas por API; conflitos entre sessões são reproduzíveis e rastreáveis sem sobrescrita silenciosa.',
    'R15',
  ],
  [
    'R25',
    4,
    'P2',
    'L08; L09',
    'Ampliar gestão segura e integrações',
    'SNMPv3 authPriv, traps e codecs; autenticação/TLS de gestão e integrações externas em ambiente isolado conforme necessidade.',
    'Ensaios de credenciais, integridade, eventos e transporte validam o protocolo contratado com decodificador independente.',
    'R19',
  ],
  [
    'R26',
    4,
    'P2',
    'ED15; L10',
    'Sincronizar documentação e fidelidade',
    'Atualizar SNMP/L2, IPv6/firewall, VRF, BGP/EVPN, underlay e codecs; indicar limites no painel de configuração, preflight e relatório.',
    'Nenhuma descrição anuncia recurso ausente ou nega correção entregue; documentação liga cada capacidade ao teste e versão.',
    'R01; R07; R11',
  ],
  [
    'R27',
    5,
    'P1',
    'Validação anterior',
    'Qualificar PostgreSQL externo e backup/restauração',
    'Executar teste ignorado com TEST_DATABASE_URL isolado; validar migrações, backup consistente, restore, relatórios imutáveis e recuperação.',
    'Teste externo passa; restore preserva projetos/revisões/runs/hashes e permissões; ensaio não usa banco de produção.',
    'R02; R15',
  ],
  [
    'R28',
    5,
    'P1',
    'Validação anterior',
    'Qualificar implantação e integração',
    'Ambiente de homologação com artefato versionado, TLS/configuração, observabilidade, backup e smoke tests; ensaiar rollback antes de produção.',
    'Deploy homologado reproduz fluxos e persistência, sem erros de inicialização; publicação Git não é usada como evidência de implantação.',
    'R01; R02; R27',
  ],
  [
    'R29',
    5,
    'Condicional',
    'L02; L03',
    'Avaliar redundância e sincronismo industriais adicionais',
    'Confirmar requisito e escopo de MRP/DLR/PRP/HSR e PTP/TSN; implementar somente os protocolos contratados e seus modelos de tempo.',
    'Ensaios específicos passam; RSTP não é anunciado como anel industrial nem NTP como PTP/TSN.',
    'R17',
  ],
  [
    'R30',
    5,
    'Condicional',
    'L04; L06; L05',
    'Qualificar RF, hardware e cargas externas',
    'Se necessário, física RF com reflexão/difração, firmware/hardware real, RTSP/H.264 e interoperabilidade em laboratório separado.',
    'Critérios de campo/laboratório definidos e medidos; modelo aproximado não certifica cobertura RF nem hardware.',
    'R17; R19; R28',
  ],
];
const plan = rows.map(
  ([id, phase, priority, references, title, implementation, acceptance, dependencies]) => ({
    id,
    phase,
    priority,
    references: references.split('; '),
    title,
    implementation,
    acceptance,
    dependencies: dependencies ? dependencies.split('; ') : [],
    status: 'pendente',
  })
);
const cell = (value) => String(value).replaceAll('|', '\\|');
const report = `# Auditoria enterprise e datacenter — 13/10/2026

**O simulador atende os fluxos básicos ensaiados, mas ainda não comprova uma rede enterprise/datacenter completa com continuidade e segurança dual stack.** Foram registrados 15 achados, incluindo três bugs reproduzíveis: métricas de recuperação incoerentes aceitas pela API, contraste dos rótulos e reinicialização RSTP ao editar uma porta desconectada. As demais entradas distinguem configuração, limite de fidelidade e melhoria de produto.

## Método e cobertura

Base de código auditada: main, commit 3d35c2e1e4e59a382c9d319eac6dc97311a55de5. Execução local e conta sintética, sem tráfego em rede real. [Snapshot importável](enterprise-datacenter.shlab.json), [inventário](inventory.json) e scripts no diretório scripts do repositório. A API importou a topologia; a interface a executou, salvou o laboratório e reabriu o histórico persistido.

Topologia integrada: **38 equipamentos, 46 enlaces**, cinco VLANs de campus, dois cores, dois firewalls VRRP, RSTP/LACP, usuários/visitantes/DMZ/corporativo/gerência, RADIUS/EAP-TLS, DNS/DHCP/NTP/syslog e WAN simulada. Datacenter com dois spines, três leaves, dois VNIs, tenants com IPs sobrepostos, EVPN/BGP, dois backends, LB e UPS. LB, DC-GW e WAN únicos e pool DHCP apenas do relay primário são condições deliberadas de ensaio, não desenhos aprovados para produção.

**${matrix.length} casos no motor: ${matrix.filter((r) => r.passed).length} expectativas atendidas e ${matrix.filter((r) => !r.passed).length} divergências.** Divergência não equivale a bug: alguns casos exigem capacidade ausente ou continuidade não provisionada. [Matriz campus/fabric](scenario-results.json), [protocolos/segurança](protocol-results.json), [diagnóstico](diagnostics.json). Testes complementares usaram templates OSPF/BGP/VPN/SD-WAN/VRF e a topologia integrada.

Na aplicação, cinco fluxos × seis amostras passaram: usuário→ERP, visitante bloqueado, tenant A→APP-1, campus→VIP DC e Wi-Fi empresarial→ERP. Relatório salvo e reaberto; zero pageerrors e zero respostas de erro dos endpoints de projetos no roteiro positivo. Desktop 1600×1100 e mobile 390×844; bodyWidth=390 e relatório width/scrollWidth=350/350. Axe encontrou 30 elementos com contraste insuficiente no canvas claro; modal e relatório móvel sem violações detectadas. [Resultados UI](ui-results.json), [captura desktop](screenshots/desktop.png), [relatório](screenshots/scenario-report.png), [mobile](screenshots/mobile.png).

Realtime 5×: razão virtual/real solicitada ${(ui.realtime.ratio * 100).toFixed(1)}% em uma janela de ${(ui.realtime.elapsedMs / 1000).toFixed(1)} s; sem inferência de SLA para outros computadores. Nos perfis 38/62/86, todos os 75 pings chegaram. Captura descartou 0/487/2642 frames por limite de retenção; isso não é perda de pacote. [Escala](scale-results.json).

Regressão existente: **${regression.numPassedTests} aprovados, ${regression.numFailedTests} falhas, ${regression.numPendingTests} ignorado, 72 arquivos**. O ignorado depende de PostgreSQL externo. [Resultado bruto](regression-tests.json). Testes de auditoria são independentes da suíte Vitest e das suas contagens.

## Achados

${findings.map((f) => `### ${f.id} · ${f.priority} · ${f.title}\n\nTipo: ${f.kind}. Evidência: ${f.evidence.join(', ')}.\n\n${f.observed}\n\nCausa/limite: ${f.cause} Correção/implementação: ${f.plan.join(', ')}.\n`).join('\n')}

## Controles que passaram e diagnósticos descartados

Passaram segmentação IPv4, HTTP/DNS/DHCP baseline, EAP-TLS e certificado inválido, SNMP/credencial inválida, VRRP para novas conexões e retorno WAN VIP, perda de core/uplink/membro LACP, isolamento por VNI e VRF, mobilidade VM, MTU, health checks e recuperação de backend, UPS e snapshots serializados em convergência/tráfego pendente. OSPF/BGP e SD-WAN reconvergem nos templates ensaiados; VPN HTTP passou.

DHCP snooping bloqueou o servidor indevido e obteve lease legítimo após convergência. A aparente falha inicial vinha do reset RSTP provocado ao marcar a nova porta edge; não foi classificada como bug de snooping. Endereço/gateway/VLAN internos do AP foram corrigidos no roteiro antes do resultado final. Diferenças apenas de presença de chaves undefined foram descartadas por comparação do snapshot JSON serializado.

A API passou conflito de revisão (409), retry idêntico (200) e ausência de CSRF (403). Falhou a integridade da recuperação (aceitou 200, esperado 400). O projeto artificial foi removido após a reprodução. [Evidência API](api-results.json), [relatório original](recovery-report-original.json), [relatório adulterado, somente fixture negativa](recovery-report-tampered.json).

## Limites e pendências

O ensaio não certifica firmware, switches reais, ASIC, RF de campo, produção, sessões externas ou todos os recursos de um datacenter físico. Os modelos de protocolo e a captura têm limites documentados. Não há inferência de vazamento de memória a partir dos heap deltas; não houve soak test prolongado nem carga com milhares de VTEPs. PostgreSQL externo, implantação de produção e integrações reais permanecem não validados.

As correções de produto não foram implementadas nesta auditoria: o pedido desta etapa é testar e consolidar o plano. A configuração do laboratório e os roteiros foram ajustados para excluir falsos positivos. [Plano consolidado de correção/implementação](../../docs/consolidated-remediation-plan.md), [backlog JSON](consolidated-backlog.json), [backlog CSV](consolidated-backlog.csv).
`;
const phases = [
  [
    'Fase 0 — P0: segurança e confiança dos resultados',
    'Bloquear conclusões incorretas antes de ampliar recursos. Aceite desta fase é obrigatório para usar os ensaios como evidência de segurança/HA.',
  ],
  [
    'Fase 1 — P1: correções do motor, disponibilidade e arquitetura',
    'Corrigir convergência/legibilidade, validar configuração e implementar os caminhos e estados necessários à continuidade. Definir SLA por fluxo; sem valor inventado para produção.',
  ],
  [
    'Fase 2 — P1: cenários, cobertura e evidência',
    'Fechar a diferença entre capacidades do motor e do executor, migrar os casos existentes e tornar execução/recuperação rastreáveis.',
  ],
  [
    'Fase 3 — P1/P2: fidelidade industrial e datacenter',
    'Entregar codecs e comportamento industrial contratado; ampliar fabric em incrementos de protocolo, cada um com testes de controle, dados e falhas.',
  ],
  [
    'Fase 4 — P2: operação, escala, gestão e colaboração',
    'Melhorar desenho, análise de configuração, desempenho e operação compartilhada após estabilizar o comportamento.',
  ],
  [
    'Fase 5 — qualificação e requisitos condicionais',
    'PostgreSQL/homologação continuam gates P1. Protocolos industriais adicionais, RF avançado, vídeo e hardware real dependem de requisito confirmado; não devem ser declarados concluídos.',
  ],
];
const planDoc = `# Plano consolidado — fábrica, enterprise e datacenter

Atualizado em 13/10/2026. **Fonte única de prioridades a partir desta auditoria:** incorpora todas as pendências do [backlog da fábrica](factory-remediation-backlog.md) e os 15 achados da [auditoria enterprise/datacenter](../artifacts/enterprise-datacenter-audit/RELATORIO.md). São ${plan.length} frentes consolidadas; cada uma possui referências, implementação, dependências e aceite. Estão pendentes; não representam recursos entregues.

P0 bloqueia confiança/segurança dos ensaios. P1 afeta disponibilidade, fidelidade contratada ou qualificação. P2 melhora operação/escala e amplia capacidades. As fases são ordem de dependências, não estimativas de calendário. Aceites de HA exigem SLA aprovado por fluxo, carga e resolução explícitos.

${phases
  .map(
    ([title, description], i) =>
      `## ${title}\n\n${description}\n\n| ID / prioridade / origem | Correção ou implementação | Critério de aceite | Dependências |\n| --- | --- | --- | --- |\n${plan
        .filter((r) => r.phase === i)
        .map(
          (r) =>
            `| **${r.id} · ${r.priority}**<br>${cell(r.references.join(', '))} | **${cell(r.title)}.** ${cell(r.implementation)} | ${cell(r.acceptance)} | ${r.dependencies.join(', ') || 'Nenhuma'} |`
        )
        .join('\n')}\n`
  )
  .join('\n')}

## Encerramento de cada fase

Reexecutar os casos afetados e a regressão necessária; validar schema/API/Worker/UI, importação/reabertura e cenários positivos/negativos. Arquivar build/commit, origem/revisão/hash, matriz de casos, amostras e exclusões de captura. Um timeout sem causalidade é inconclusivo como prova de política. Relatórios fabricados ou antigos não revalidados não recebem selo de validação. Regressão de referência atual: 677 passaram, zero falharam, um teste PostgreSQL externo ignorado.

## Rastreabilidade e itens já entregues

- Fábrica D03→R05/R08/R09; D04→R10; U01→R11/R12/R13; U05→R02/R14/R15; L01→R16/R17; L05→R17/R30; U02→R03/R21; U03→R21; U04→R05/R07/R22; U06→R24; L07→R20; L08→R25; L09→R16/R19/R25; Desempenho→R23; L02/L03→R29; L04/L06→R30; L10→R01/R26; validações externas→R27/R28.
- Os novos ED01–ED15 têm ligações explícitas em [findings.json](../artifacts/enterprise-datacenter-audit/findings.json) e nas origens de cada frente. A sessão TCP interrompida reconfirma D02/D03; não reabre os fixes de novas conexões/retorno WAN.
- Continuam entregues B01–B06, O01, D01/D05 e as parcelas concluídas de D02/U01/U03/U04/U05/U06: realtime, captura separada, gerência L2, ajustes RSTP anteriores, relay ativo VRRP, segmentação/retorno, nove protocolos, 17 presets de fábrica, Modbus 03/06/16, relatórios persistidos, diff e bulk IPv4. ED14 é reprodução nova de edição de porta, diferente do acordo RSTP corrigido anteriormente.
- Não foram reabertas como pendência a persistência já entregue, o funcionamento básico de MQTT QoS 1, o enquadramento móvel corrigido ou toda a implementação EVPN. O plano especifica somente as partes faltantes ou regressões novas.

## Evidências e reprodução

[Relatório completo](../artifacts/enterprise-datacenter-audit/RELATORIO.md), [matriz principal](../artifacts/enterprise-datacenter-audit/scenario-results.json) e [complementos](../artifacts/enterprise-datacenter-audit/protocol-results.json), [interface](../artifacts/enterprise-datacenter-audit/ui-results.json), [API](../artifacts/enterprise-datacenter-audit/api-results.json), [escala](../artifacts/enterprise-datacenter-audit/scale-results.json). A contagem 73 soma as duas matrizes; o primeiro arquivo sozinho contém 46 casos. [CSV para gestão](../artifacts/enterprise-datacenter-audit/consolidated-backlog.csv) e [JSON](../artifacts/enterprise-datacenter-audit/consolidated-backlog.json).

Com o ambiente local e a sessão sintética de teste autenticada em CDP 9223: executar scripts/audit-enterprise-datacenter.ts; depois audit-enterprise-protocols.ts e audit-enterprise-scale.ts; verify-enterprise-datacenter-ui.mjs e verify-enterprise-api.mjs; por último build-enterprise-audit-report.mjs. Os scripts UI/API usam a sessão apenas em memória. O roteiro negativo da API remove o seu projeto artificial. Não adicionar perfil de navegador, cookies ou bancos locais ao repositório.
`;
const csv = (values) => values.map((v) => '"' + String(v).replaceAll('"', '""') + '"').join(',');
writeFileSync(
  out + '/findings.json',
  JSON.stringify({ date: '2026-10-13', count: findings.length, findings }, null, 2)
);
writeFileSync(
  out + '/consolidated-backlog.json',
  JSON.stringify({ date: '2026-10-13', items: plan }, null, 2)
);
writeFileSync(
  out + '/consolidated-backlog.csv',
  '\ufeff' +
    [
      csv([
        'ID',
        'Fase',
        'Prioridade',
        'Origens',
        'Título',
        'Implementação',
        'Aceite',
        'Dependências',
        'Status',
      ]),
      ...plan.map((r) =>
        csv([
          r.id,
          r.phase,
          r.priority,
          r.references.join('; '),
          r.title,
          r.implementation,
          r.acceptance,
          r.dependencies.join('; '),
          r.status,
        ])
      ),
    ].join('\n')
);
writeFileSync(out + '/RELATORIO.md', report);
// A historical audit must not reset an implementation status already reviewed.
const currentPlan = readFileSync('docs/consolidated-remediation-plan.md', 'utf8');
if (!currentPlan.includes('## Status após a implementação'))
  writeFileSync('docs/consolidated-remediation-plan.md', planDoc);
writeFileSync(
  out + '/audit-summary.json',
  JSON.stringify(
    {
      sourceCommit: '3d35c2e1e4e59a382c9d319eac6dc97311a55de5',
      topology: main.topology,
      matrix: {
        total: matrix.length,
        matched: matrix.filter((r) => r.passed).length,
        divergent: matrix.filter((r) => !r.passed).length,
      },
      findings: {
        total: findings.length,
        bugs: findings.filter((f) => f.kind.startsWith('Bug')).map((f) => f.id),
      },
      plan: {
        fronts: plan.length,
        byPhase: phases.map((_, i) => ({
          phase: i,
          ids: plan.filter((p) => p.phase === i).map((p) => p.id),
        })),
      },
      regression: {
        passed: regression.numPassedTests,
        failed: regression.numFailedTests,
        skipped: regression.numPendingTests,
      },
      ui: {
        realtimeRatio: ui.realtime.ratio,
        positiveFlows: 5,
        samples: 30,
        persisted: ui.persisted,
        errors: ui.errors.length,
        contrastNodes: 30,
      },
      api: api.recoveryTampering,
      scale: scale.results,
    },
    null,
    2
  )
);
console.log(
  JSON.stringify({
    cases: matrix.length,
    matched: matrix.filter((r) => r.passed).length,
    findings: findings.length,
    fronts: plan.length,
  })
);
