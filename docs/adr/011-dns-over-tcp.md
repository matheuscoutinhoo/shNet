# ADR-011 — DNS sobre o transporte TCP simulado

O cliente DNS agora inicia uma conexão TCP/53 quando recebe TC=1 em modo automático. Também há modos TCP e UDP explícitos, pelo painel e por `nslookup -tcp|-udp`. O servidor DNS habilita UDP e TCP/53; outro listener habilitado nessa porta é recusado. Cache, validação de respostas e limites de tentativas são compartilhados pelos transportes.

A consulta atravessa a máquina TCP existente, incluindo handshake, segmentação, ACK, retransmissão, FIN, ACL, NAT e firewall. O parser espera a mensagem inteira antes de responder; receber apenas um segmento não encerra a consulta. A correlação exige conexão, IPs, porta, ID e pergunta. Uma resposta UDP não completa uma consulta que está aguardando TCP. Cada tentativa tem 5 s virtuais; uma tentativa truncada ganha um novo prazo de 5 s para TCP. Timeout cancela a conexão e pode iniciar a tentativa/servidor seguinte.

Escolhemos uma consulta por conexão, com fechamento após a mensagem, dentro do transporte educacional de 16 KiB por direção. Não há reutilização, pipelining ou codec DNS binário. Como o stream atual é texto UTF-8, quatro caracteres hexadecimais representam o comprimento de 16 bits, seguidos de JSON validado pelo contrato DNS. Essa representação é interna ao simulador e não corresponde aos bytes de um servidor DNS real. A sequência TCP conta os bytes desse texto.

O servidor retorna SERVFAIL quando o resultado excede 64 registros ou o buffer do transporte, sem apresentar resposta parcial como resolução completa. Os campos opcionais de transporte/conexão e processamento da aplicação preservam snapshots v1 anteriores. Consultas TCP pendentes exigem referência a uma conexão consistente, inclusive ao restaurar uma resposta parcial. Conexões terminadas referenciadas por consultas ainda pendentes não são removidas para liberar histórico.

Referências de comportamento: [RFC 7766](https://www.rfc-editor.org/rfc/rfc7766.html). Esta implementação não representa conformidade completa com essa RFC.
