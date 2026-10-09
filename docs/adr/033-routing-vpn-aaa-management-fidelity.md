# ADR-033 — Fidelidade de roteamento, VPN, AAA e gerenciamento

## Decisão

Ampliar as máquinas de protocolo existentes e preservar o transporte pela topologia, as falhas reais do modelo, o relógio virtual e a retomada de snapshots. Os novos controles são configuráveis pela CLI e pelos painéis OSPF, RIP, VPN/SD-WAN, AAA e Gerenciamento.

- OSPF: áreas normal/stub/NSSA, default de stub, redistribuição de rotas alcançáveis, LSAs externos/Type-4/Type-7 e tradução pelo ABR, preferência intra/inter/externa, métricas E1/E2, forwarding address, checksum Fletcher e autenticação HMAC com janela contra replay.
- RIPv2: next-hop, filtros de prefixo por interface, custo, hold-down configurável, redistribuição estática/tag e key chains com validade. O codec produz cabeçalho/RTEs e autenticação SHA-256; anúncios autenticados limitam cada mensagem a 24 RTEs.
- VPN: troca INIT/AUTH por UDP/4500, DH X25519, HKDF/HMAC-SHA256, SAs com SPI, AES-GCM, selectors IPv4, janela de replay e renovação por lifetime. O underlay, PAT, ACL, MTU e SLA continuam participando do fluxo.
- AAA: CHAP-MD5 e RADIUS em octetos com Message-Authenticator/Response Authenticator, Session-Timeout, VLAN e filtros de comandos. Requests repetidos recebem a resposta correlacionada sem duplicar contabilização. TACACS+ usa cabeçalho de 12 octetos, pad MD5, CHAP, autorização separada e accounting START/STOP/command pelo TCP/49.
- NETCONF: capabilities/hello, base 1.0 e framing 1.1 por contagem de octetos UTF-8, XML RPC/reply/rpc-error, running/candidate/startup, copy/delete-config, validate/commit/discard, lock e revisão.
- RESTCONF: recursos network/hostname/interfaces/routes, GET/PATCH/PUT/POST/DELETE, Content-Length, tipos de conteúdo, ETag/If-Match e erro estruturado. Um patch é limitado ao recurso selecionado; PUT substitui network completo.
- Gerenciamento: handshake com verificação de certificado/autoridade/nome/validade, transcript/Finished, credenciais protegidas e registros de aplicação AES-GCM. Parser XML limitado rejeita DTD, entidades externas, profundidade e tamanho excessivos.

## Limites explícitos

OSPF usa LSAs tipadas e checksum sobre sua representação canônica, não todos os cabeçalhos RFC em binário. NSSA não inclui eleição completa de translator ou todos os casos de redistribuição. VPN modela IKE/ESP com criptografia real e PDUs tipadas; não implementa interoperabilidade com IPsec externo. Selectors IPv6 e cadeias completas de certificados ficam fora deste subconjunto.

TLS usa X25519, Ed25519, HKDF e AES-GCM, mas certificados são objetos tipados e as flights são serializadas no modelo; não são X.509 DER ou records TLS binários interoperáveis. NETCONF não inclui SSH, interpretação genérica de YANG, confirmed-commit ou todas as extensões. Locks são por equipamento com lease de 30 segundos. TCP textual representa octetos TACACS+/MQTT em hexadecimal. O pad MD5 TACACS+ é obfuscação, conforme RFC 8907, e não recebe uma alegação de cifra moderna. Credenciais/configurações privadas do laboratório permanecem no snapshot.

## Evidência

Os testes verificam rotas e ping após redistribuição/withdraw, autenticação e replay, codec RIPv2, renegociação VPN e rejeição de SA antiga, retomada do handshake TLS, candidate/startup e recursos RESTCONF, rejeição de revisão antiga, ausência de senha em tráfego e política/accounting TACACS+.

## Referências

[OSPF RFC 2328](https://www.rfc-editor.org/info/rfc2328), [RIPv2 RFC 2453](https://www.rfc-editor.org/info/rfc2453), [RIP Authentication RFC 4822](https://www.rfc-editor.org/info/rfc4822), [IKEv2 RFC 7296](https://www.rfc-editor.org/info/rfc7296), [RADIUS RFC 2865](https://www.rfc-editor.org/info/rfc2865), [TACACS+ RFC 8907](https://www.rfc-editor.org/info/rfc8907), [NETCONF RFC 6241](https://www.rfc-editor.org/info/rfc6241), [NETCONF framing RFC 6242](https://www.rfc-editor.org/info/rfc6242), [RESTCONF RFC 8040](https://www.rfc-editor.org/info/rfc8040).
