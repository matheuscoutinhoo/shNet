# Correções e homologação da aplicação

Atualizado em 14/10/2026. Contrato 2026.10.13.7, migrations 011. Este incremento atende desempenho, rastreabilidade, métricas e operações de topologia; colaboração e novos protocolos/recursos industriais continuam adiados.

## Resultado local

- Regressão completa: **826 aprovados, 0 falhas, 2 ignorados**. Os testes ignorados são PostgreSQL externo nessa rodada e P-PCAP de codecs adicionais.
- PostgreSQL 18 local isolado: **59 aprovados**, nenhuma falha/skip. Contagens se sobrepõem; não devem ser somadas.
- Matriz histórica: **115 casos rastreados, 114 aplicáveis aprovados, um de novos codecs adiado**. [Rastreabilidade](case-coverage.json).
- Clones têm testes adicionais para LAN, IPv6, rack/UPS, factory, enterprise, VRRP/BGP/OSPF/LACP/VPN/SD-WAN/VRF/VXLAN e políticas com prefixo amplo. [Última execução](final-clones.json).
- Dois E2E em Edge: vistas/clone/revisão/undo/save e 2.000 equipamentos/Worker/heap. Axe sem violações no fluxo de clone. Heap principal após GC: **57.67–59.29 MiB**, teto 256 MiB; três ciclos de pause/resume. Não mede o heap interno do Worker. [Medição](browser-heap-2000-sistema-escuro.json).
- SPA compilada: autosave contínuo, save finito, identidade fonte/Worker, replay matched, falhas conjuntas de servidor/IndexedDB e sessão expirada com trabalho exportável. Falha de import de painel é contida; editor continua disponível. [Resultado](built-application-ui.json).

## Desempenho

| Dispositivos | Virtual/real, três repetições | p95 Worker + delta | Heap Node durante execução | Respostas por repetição |
| --- | --- | --- | --- | --- |
| 38 | 1.38–1.54× | 26.20–26.29 ms | 123.09–136.88 MiB | 12/12 |
| 100 | 72.14–85.62× | 13.37–16.81 ms | 98.59–105.79 MiB | 6/6 |
| 500 | 18.43–21.27× | 26.98–28.02 ms | 88.87–97.64 MiB | 6/6 |
| 2000 | 3.43–3.53× | 35.74–39.32 ms | 151.54–205.20 MiB | 6/6 |

O perfil 38 usa controle BGP/EVPN/VRRP e HTTP ERP/LB; os demais são árvores L2 com seis ICMP entre extremos e recursos dos hosts habilitados. Não equivalem à mesma carga. Processo Node local, budget nominal 20 ms antes do delta, aquecimento fora da medição. O motor não pula eventos nem tempo para melhorar a taxa. [Dados, volume de deltas e limites](performance.json).

O canvas agora conhece dimensões/handles iniciais e não monta todos os nós antes de virtualizar. CPU foi reduzida com índices de portas sem cabo e participantes de protocolos; patches conservam identidade dos objetos não modificados e remoções explícitas.

Workspace passou de cerca de 1.619 kB no incremento anterior para cerca de 353 kB, com motor compartilhado separado e painéis sob demanda. O motor compartilhado (~965 kB) e Workers (~912/948 kB) continuam grandes descomprimidos. 19 assets JS/CSS têm Brotli/Gzip; conjunto bruto 4.04 MiB, Brotli 1.05 MiB. Isso reduz transferência e reaproveita cache; não elimina custo de execução.

## Bugs novos corrigidos

- Portas sem cabo reconstruíam o índice inteiro repetidamente.
- Canvas de 2.000 dispositivos ficava bloqueado ao medir todos os nós/handles antes do culling.
- Reconfigurar BGP com loopback podia reutilizar porta TCP e gerar snapshot com tupla duplicada.
- CI abortava na importação JSON antes dos testes de navegador/Docker. Import attribute corrigido.
- Falha em um chunk sob demanda podia derrubar o editor; painéis têm fronteira de erro própria.

Clones remapeiam redes/políticas/portas/MAC/VLAN/VNI/IPv6 e referências internas, preservam origem e recusam proposta inválida ou maior que o limite de persistência. Rádios/mesh, overlays e túneis começam desativados; uplinks externos precisam de revisão. Vista lógica projeta conexões/jumpers/cabos paralelos sem alterar posições físicas e sem provar reachability.

## Homologação externa

O Railway público **https://shnet.up.railway.app** respondeu com TLS verificado, HSTS/CSP/nosniff, readiness do banco e hash real do Worker igual ao anunciado. Endpoints privados não foram expostos. [Smoke somente leitura](remote-release.json).

O usuário escolheu **CI isolada por enquanto**, pois a CLI Railway não tinha autenticação e não havia navegador conectado. O job containers constrói a imagem atual e a publicada de rollback, usa PostgreSQL 18 descartável, HTTPS/WSS com CA explicitamente confiável, ownership, projeto/ensaio/replay, backup criptografado e restore em banco distinto. **Roteiro preparado ainda depende da execução aprovada da CI**; seu resultado será anexado separadamente.

O pacote de runtime foi exercitado por cópia de filesystem, não por Docker local. Qualificação local não fez handshake TLS nem rollback operacional de imagem. Docker/rollback real pertencem ao job containers. PITR, capacidade e rollback do projeto Railway real continuam fora da evidência executada nesta máquina; nenhuma operação destrutiva foi feita em produção.

[ADR-047](../../docs/adr/047-scale-topology-and-release-qualification.md) · [Plano consolidado](../../docs/consolidated-remediation-plan.md)
