# Conclusão dos blocos de produto

Pedido de 2026-10-08: implementar 2, 3, 4, 5, 6 e 8 da revisão de pendências. Conta e colaboração entre usuários não fazem parte deste pedido.

- [x] 2. Workspace: desenho livre, comentários ancorados e histórico privado de atividades, com persistência e validação.
- [x] 3. Equipamentos: infraestrutura física, serviço de banco de dados, perfis dedicados e métricas derivadas do trabalho do motor.
- [x] 4. Usabilidade: formulários guiados, acessibilidade e verificação em desktop, tablet, mobile e ultrawide.
- [x] 5. Escala: processamento em Worker, índices/filas eficientes, renderização limitada ao viewport, benchmarks e coordenação de múltiplas instâncias da API.
- [ ] 6. Produção: readiness, métricas/alertas, backup/restauração, configuração de produção e smoke tests; publicação real exige ambiente externo acessível.
- [x] 8. Fidelidade: SACK/ECN/timestamps, PMTUD TCP, relay DHCPv6 e codecs/capturas binárias com checksums e limites declarados.

Cada bloco só é marcado após implementação, configuração utilizável e testes de comportamento. Publicação, entrega real de e-mail e serviços externos são registrados separadamente dos testes locais.

Bloco 2: 48 testes focados de motor/API e um cenário E2E aprovados, incluindo histórico paginado, ownership/CSRF, desenhos, âncoras e viewports 390/768/2560 px.

Blocos 3 e 4: 7 testes de equipamentos/serviço/catálogo e E2E de UPS, configuração guiada de IPS, foco de modal e auditoria axe sem violações nos cenários cobertos (WCAG A/AA 2.0/2.1/2.2, incluindo 390/768/2560 px). SQL é um serviço HTTP/TCP limitado, não o protocolo PostgreSQL.

Bloco 5: Worker, pausa/retomada, viewport e save com 2000 dispositivos verificados no navegador. `benchmarks/scale.json` registra os cenários de árvore L2 com 100/500/1250/2000 dispositivos; o cenário maior terminou o ping em 4261 ms, com lotes de até 85 ms medidos fora da thread de UI. Esses valores descrevem esta máquina e esse tráfego, não qualquer topologia/carga. Duas instâncias da API compartilham orçamento por cliente/rota e entregam notificações somente ao proprietário via PostgreSQL.

Bloco 6: implementação local pronta — readiness/liveness, métricas protegidas, Compose com HTTPS/monitoramento, backups AES-GCM, retenção e smoke tests no CI. Backup/restauração e múltiplas instâncias passaram em PostgreSQL servidor 18.6 local. Docker não está disponível nesta máquina; os containers e certificados do domínio ainda exigem execução no host. Publicação, entrega real de e-mail/alertas e cópia dos backups para armazenamento externo continuam pendentes de acesso ao ambiente. O plugin Railway foi sugerido, mas sua instalação/autorização não foi confirmada. Nenhum deploy ou envio externo foi realizado.

Bloco 8: negociação TCP, SACK com duas perdas, CE/ECE/CWR, PAWS, PMTUD IPv4/IPv6, MSS jumbo e integração PAT/firewall verificados; relay DHCPv6 com um/dois saltos e delegação roteada retomam após restore. Codecs e captura passaram nos testes e em validação independente com Scapy; o navegador configurou as opções e baixou/decodificou HTTP no PCAP. O [ADR-035](adr/035-transport-extensions-relay-captures.md) registra os protocolos exportáveis e as omissões.

Verificação final de 2026-10-09: 463 testes de motor/API em 57 arquivos aprovados contra PostgreSQL servidor; 40 cenários de navegador aprovados por execução completa seguida da reexecução dos cenários afetados. Lint, typecheck, build, formatação e auditoria npm passaram (zero vulnerabilidades reportadas). As capturas foram revisadas em desktop/mobile; Scapy validou 13 registros PCAP, 11 checksums TCP, DNS, NDP e relay DHCPv6 aninhado. A última regressão cobre MTU menor na saída do próprio roteador com NAT estático, dinâmico ou PAT, sem alterar o caminho de hairpin.
