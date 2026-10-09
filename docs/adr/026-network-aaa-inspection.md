# ADR-026 — Autorização de rede e inspeção de aplicações

Atualização: este ADR registra a etapa original. RADIUS/TACACS+ e PEAP/TLS foram ampliados nos ADRs 032/033; as ausências desta etapa não descrevem o estado atual.

Status: implementado no motor educacional; testes do motor, API e E2E concluídos.

## 802.1X e RADIUS

A porta access do switch tem plano de controle EAPOL e plano de dados controlado. O supplicant inicia EAPOL (EtherType 0x888E), responde à identidade e a um desafio; o switch envia Access-Request pelo underlay IPv4 ao servidor RADIUS/UDP1812. A resposta exige consulta, origem, porta e autenticador correspondentes. Há três tentativas com timeout. Somente Access-Accept válido autoriza um MAC, com VLAN existente e tempo de sessão limitado. Senha/chave incorreta, VLAN ausente, silêncio do servidor, expiração, logoff e falha física mantêm ou devolvem o bloqueio. Dados recebidos sem autorização não alimentam a tabela MAC.

O modelo ilustra os papéis de supplicant, authenticator e backend; a [RFC 3748](https://www.rfc-editor.org/rfc/rfc3748) orienta EAP, e a [RFC 2865](https://www.rfc-editor.org/rfc/rfc2865) orienta autorização RADIUS. O desafio e o autenticador usam digest didático, sem EAP-MD5 interoperável, PEAP, TLS, certificado, codec RADIUS binário ou proteção de produção. O controle entregue é cabeado e single-host; não há 802.1X empresarial no rádio.

## TACACS+ e terminal de rede

O cliente abre TCP/49 pela rede simulada. Mensagens seladas pelo cipher didático transportam autenticação e autorização. Usuários de rede têm privilégio; quando enforceCli está ativo, configurar pelo terminal exige autorização vigente com privilégio 15. Usuários de leitura continuam consultando o estado. Servidor guarda contadores e registros limitados de autenticação/autorização. CLI oculta senhas e shared secrets no histórico, eventos e running-config. Credenciais pertencem ao laboratório; não alteram contas ou login do produto.

A [RFC 8907](https://www.rfc-editor.org/rfc/rfc8907.html) orienta os conceitos de TACACS+. Esta implementação não usa o formato binário ou algoritmos do protocolo real e não faz autorização individual de comandos, accounting externo ou integração com diretório. A restrição vale para o terminal; o editor do laboratório pode configurar sua própria topologia.

## Inspeção HTTP/DNS

O firewall existente continua validando zonas, sessões TCP/UDP/ICMP, flags, sequência, ACL e retorno relacionado. A inspeção adicional classifica o primeiro pedido HTTP em texto ou consultas DNS. Regras ordenadas combinam Host, prefixo de caminho, sufixo de domínio DNS e porta. A regra é contada uma vez por classificação HTTP; retransmissões não repetem o hit. DNS conta por datagrama. A ação padrão cobre HTTP sem regra ou dados TCP desconhecidos.

O classificador acumula até 8192 caracteres de cabeçalho na sequência do TCP, preservando buffer/decisão/timer no snapshot. Cabeçalhos incompletos podem passar antes da classificação; o segmento que completa um pedido bloqueado é descartado, e o servidor não processa o pedido. Não há proxy, buffering de toda a conexão, inspeção TLS, decodificação de protocolos cifrados ou inspeção de múltiplos pedidos HTTP em keep-alive. Fluxos classificados expiram após 120 s sem dados. Os serviços HTTP do simulador encerram uma transação por conexão.

## Evidência

Testes verificam bloqueio pré-autenticação, EAPOL e datagramas RADIUS reais, senha/shared secret/VLAN incorretos, reautenticação, cabo, HTTP autorizado, TCP TACACS+, privilégio do terminal, ACL e persistência. Inspeção testa Host/caminho, PAT, cabeçalho segmentado, retransmissões, sufixo DNS com fronteira de domínio, ação unknown e timers. API retoma negociações/classificação e rejeita estados adulterados. Templates e painéis expõem configuração, estados, contadores e PDU. E2E verifica autenticação/VLAN, TACACS+, HTTP permitido/bloqueado, regras e save/load em desktop/mobile.
