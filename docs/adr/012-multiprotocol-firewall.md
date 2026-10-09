# ADR-012 — Firewall stateful para UDP e ICMP

Status: aceito. Amplia o firewall de trânsito do ADR-009. As restrições de zonas e ICMP relacionado abaixo descrevem esta entrega histórica; foram substituídas pelo [ADR-015](015-firewall-zones-and-related-icmp.md).

O firewall agora escolhe quais protocolos rastrear: TCP, UDP e ICMP. Configurações novas incluem os três; um snapshot antigo sem seleção mantém apenas TCP. Sessões TCP antigas sem discriminante recebem o protocolo TCP durante a validação, preservando sua máquina de estados.

UDP usa IPs, portas e interfaces de entrada/saída para correlacionar o retorno. Não há handshake: o primeiro datagrama que sai da interface confiável cria UNREPLIED; retorno correspondente muda para REPLIED. Ambos os sentidos permitidos renovam a expiração de 120 segundos. Uma porta, origem ou interface diferente não corresponde à sessão. O firewall não interpreta o ID DNS: a aplicação continua responsável por sua própria correlação.

ICMP rastreia somente Echo Request iniciado na interface confiável e Echo Reply com IPs invertidos e o mesmo probeId. O identificador é conceitual, compartilhado com ping/PAT, sem campos binários Identifier/Sequence separados. Expiração por inatividade: 60 segundos. Echo Request externo e erros ICMP não abrem nem reutilizam a sessão. Erros relacionados, inclusive Time Exceeded gerado por outro roteador, exigiriam citação tipada do pacote original e tradução NAT dessa citação; estão fora desta entrega.

O rastreamento acontece depois de DNAT e antes de SNAT. ACL in/out permanecem aplicadas. Protocolos desmarcados passam pelas ACLs; desmarcar um protocolo não cria uma regra deny. Tráfego entre duas interfaces confiáveis passa; entre duas não confiáveis é bloqueado para protocolos rastreados. Tráfego originado ou destinado ao próprio roteador usa ACLs e não este firewall de trânsito.

Todas as sessões usam a mesma coleção limitada a 1024 entradas e um timer exato no relógio virtual. Alterar configuração apaga sessões e timers. Snapshot valida tipos, política, interfaces, tuples únicos e expiração. A avaliação de labs usa uma cópia e descarta sessões antigas para gerar tráfego novo. Um pacote TCP é validado sobre uma cópia da sessão; a versão rastreada só é atualizada após autorização.

Não há DPI, IDS/IPS, ALG, TLS, regras por aplicação, zonas com políticas individuais, ICMP relacionado ou conformidade de firewall comercial. Os testes verificam trânsito real, DNS/ping com PAT, portas/interfaces adulteradas, ICMP incorreto, ACL, expiração, API e reabertura pela UI.

Referências para conceitos de tuples/filtragem e ICMP/NAT: [RFC 4787](https://www.rfc-editor.org/rfc/rfc4787.html) e [RFC 5508](https://www.rfc-editor.org/rfc/rfc5508.html). Estes documentos não são uma especificação integral do firewall implementado.
