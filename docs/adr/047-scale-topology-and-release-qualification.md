# ADR-047 — escala, operações de topologia e homologação isolada

Data: 14/10/2026. Contrato do motor: `2026.10.13.7`; migrations: 011.

O usuário autorizou as pendências da aplicação, excluiu colaboração/RBAC e manteve novos protocolos/recursos industriais para depois. Informou `https://shnet.up.railway.app/` como ambiente real. A CLI Railway não estava autenticada e não havia navegador conectado; o usuário escolheu executar a homologação isolada na CI por enquanto. Não foram criados serviços pagos ou efetuado rollback no Railway de produção.

## Escala

O perfil de CPU mostrou reconstrução do índice para portas sem conexão. Portas conhecidas sem cabo agora têm resultado negativo em cache; edições explícitas de endpoints em memória devem chamar `invalidateTopologyIndex`. Connect/remove e importações normais invalidam por identidade/tamanho do array. Checagens de carrier usam o índice em vez de percorrer todos os cabos. Expiração de tabelas conserva arrays enquanto nenhuma entrada expira.

Atualizações de BGP/VRRP/STP/LACP/dot1x/wireless e UPS percorrem apenas participantes. A configuração, mudanças de array e novas fronteiras virtuais invalidam esse índice; desativação e alterações de estado continuam lidas dos objetos atuais. Deltas mantêm assinaturas por campo para evitar decodificar todo o dispositivo quando apenas métricas mudam. Testes de convergência, configuração após execução e restore acompanham a otimização.

Deltas transportam patches de campos e portas, com remoções explícitas. Dispositivos novos e alterações estruturais continuam completos. O consumidor preserva identidades dos objetos não alterados. Testes comparam o estado reconstruído ao motor, não apenas a forma do patch.

Inspector, ferramentas de ensaio, captura e painéis educativos carregam sob demanda. Assets têm variantes Brotli/Gzip; os nomes com hash usam cache immutable. Workers continuam com código próprio grande: compressão reduz transferência, não certifica custo de execução ou SLA. A identidade SHA dos bytes descomprimidos permanece a mesma.

O canvas fornece dimensões e handles iniciais para que a virtualização não precise montar todos os nós antes de calcular visibilidade. Nós visíveis são medidos normalmente; controles e cabos refletem essa medição. Testes de heap no navegador usam teto de 256 MiB e crescimento máximo de 32 MiB entre três ciclos após GC explícito; esse orçamento se aplica ao perfil medido, não a qualquer carga enterprise.

Atualizações de dados dos dispositivos preservam as dimensões já medidas pelo ReactFlow. Depois da medição, os handles iniciais deixam de substituir os limites reais. Selecionar novamente os mesmos IDs conserva a identidade do estado. Essas correções eliminam o ciclo de atualizações observado durante construção e playback de uma LAN; o teste também exige que a inspeção conserve o zoom, que já tinha o duplo clique desativado.

## Desenho e clones

A vista física conserva coordenadas e anotações. A vista lógica é uma projeção de consulta por camada: esconde objetos passivos, atravessa somente jumpers explícitos de patch panels, agrupa cabos paralelos e indica VRF/VNI. Não altera coordenadas físicas nem prova alcance. Edição de cabos, arraste e exclusão pelo canvas ficam na vista física.

Clones de racks incluem dispositivos montados; grupos incluem membros. A revisão prepara uma proposta isolada, remapeia identidades/MAC/IPv4/IPv6/VLAN/VNI, portas, referências de infraestrutura, rotas, pools, políticas e pares HA internos. Tabelas de sessões e leases não são copiadas; protocolos reiniciam. Uplinks externos são deixados para conexão explícita. Rádios/mesh, overlays e túneis começam desativados para revisão. Falta de espaço ou configuração inválida rejeita a proposta inteira. Aplicação exige origem ainda igual e produz uma alteração com undo.

## Evidência e cobertura

Os 42 casos da fábrica e os 73 enterprise/DC têm ligação verificável com testes individuais. O caso histórico P-PCAP exige codecs universais de protocolos novos e permanece explicitamente adiado; capturas dos codecs atuais e exclusões continuam testadas. O verificador de cobertura falha se falta qualquer caso ou se um caso aplicável não passou.

Relatórios incluem sequência ordenada de hops com timestamp/porta/direção, limitada a 128 eventos por amostra. Recovery indica o timestamp virtual da resposta que restabeleceu sucesso e a primeira tentativa observada com falha. A resolução de detecção continua sendo o intervalo entre tentativas; não é prometida observação contínua nem atribuição causal universal. O novo contrato valida esses campos contra as amostras e mantém leitura de contratos históricos.

A matriz migrada reproduziu uma colisão TCP ao reconfigurar BGP com update source em loopback. A origem efetiva agora é escolhida antes da alocação de porta, evitando tuplas duplicadas e snapshots inválidos.

## Homologação

`npm run qualify:remote` verifica somente leitura: cadeia TLS válida, HSTS/CSP/nosniff, readiness do PostgreSQL, endpoints protegidos e hashes dos assets/Worker publicados. `SHLAB_EXPECT_ENGINE_BUILD` permite exigir uma fonte específica após o deploy.

A CI usa PostgreSQL 18 descartável e containers Linux reais. O roteiro `qualify-container-release.ts` verifica cadastro/login/cookies Secure, isolamento entre donos, projeto e ensaio/replay, backup criptografado, restore em banco separado, substituição da imagem pela versão de rollback e reativação sobre o banco restaurado. A imagem anterior é selecionada por `SHLAB_ROLLBACK_REF`, com referência publicada imutável como padrão. O roteiro recusa execução fora da CI e não recebe configuração de produção.

Relatórios e manifests devem distinguir testes executados de roteiros preparados. Qualificar a CI não atesta PITR, capacidade, rede privada ou rollback do projeto Railway real. Essas operações precisam de acesso autenticado e ambiente Railway isolado; continuam externas ao aceite escolhido nesta sessão.
