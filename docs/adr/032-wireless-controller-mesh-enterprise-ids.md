# ADR-032 — Controller wireless, mesh, EAP empresarial e IDS/IPS

Status: implementado no motor, CLI e interface.

CAPWAP usa descoberta e JOIN por UDP/5246, X25519/HKDF e registros AES-GCM autenticados. O WLC distribui perfis, acompanha Echo/timeout e centraliza frames em UDP/5247 com portas virtuais e VLANs. Perda do controller desabilita o rádio até reconectar.

Mesh descobre pares por Hellos autenticados, calcula caminhos de raiz/airtime sem consultar a topologia inteira e transporta Ethernet cifrado com anti-replay. Portas por vizinho evitam reflexão e loops; falha da raiz converge para outra. APs do mesmo mesh representam backhaul coordenado; APs externos continuam gerando interferência.

WPA2-Enterprise exige autorização EAP antes da troca de quatro mensagens e da liberação dos dados. EAP-TLS autentica certificados de servidor e cliente; PEAP autentica servidor e senha dentro do canal protegido. Há verificação de emissor, nome, validade, CertificateVerify, Finished e resultado protegido, fragmentação EAP, retransmissão RADIUS, MPPE e expiração/reautenticação. A chave PMK exportada habilita AES-GCM nos dados do rádio.

RADIUS/EAP possui codificação em octetos, atributos EAP-Message fragmentados, Message-Authenticator HMAC-MD5, Response Authenticator e chaves MS-MPPE ocultadas conforme os protocolos. Os certificados e os flights TLS são PDUs tipadas com Ed25519/X25519/HKDF/AES reais: não representam X.509 DER nem toda a codificação TLS/DTLS binária. PEAP usa credenciais protegidas e não implementa MSCHAPv2. Mesh modela descoberta e caminhos, sem emulação de chipset/quadros binários 802.11s.

IDS reconstitui fluxos TCP em ordem, incluindo assinaturas entre segmentos; regras de conteúdo, porta, protocolo, origem e limiar produzem alertas. IPS descarta conforme a regra, antes das políticas/aplicação. Memória e janelas são limitadas e persistidas.

Validação: testes de CAPWAP, mesh/IDS, EAP TLS/PEAP, certificados/nome inválido, senha incorreta, HTTP protegido, expiração e continuação determinística de snapshot. Nenhum socket externo é aberto.

Referências: [CAPWAP RFC 5415](https://www.rfc-editor.org/rfc/rfc5415.html), [EAP RFC 3748](https://www.rfc-editor.org/rfc/rfc3748.html), [EAP-TLS 1.3 RFC 9190](https://www.rfc-editor.org/rfc/rfc9190.html), [EAP/RADIUS RFC 3579](https://www.rfc-editor.org/rfc/rfc3579.html), [PEAP Microsoft](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-peap/5308642b-90c9-4cc4-beec-fb367325c0f9).
