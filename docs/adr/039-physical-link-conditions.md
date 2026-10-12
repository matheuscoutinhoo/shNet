# ADR-039: condições físicas dos enlaces

Data: 2026-10-12. Estado: implementado.

## Controles do laboratório

As propriedades da conexão permitem ativar o enlace, trocar a mídia e definir o comprimento do cabo. Latência, jitter e perda são apresentados somente como resultados/condições do modelo. As condições internas dos templates e testes de falhas continuam no snapshot; editar um cabo não apaga nem substitui essas condições.

Comprimento, sockets, transceivers e velocidades continuam sujeitos à validação física existente. Uma escolha incompatível informa o motivo e não modifica a conexão. Não existe um ajuste artificial de perda que torne uma mídia inadequada utilizável.

Um cabo pode ser instalado em equipamento desligado ou em porta desabilitada. Instalar não liga os equipamentos nem habilita as interfaces. O enlace só fica operacional quando suas condições de energia, interfaces e mídia permitem; a instalação de um cabo inoperante é um evento de configuração, sem anunciar que o link já está ativo.

O tempo de entrega de um frame cabeado soma a latência base do cenário, propagação do cabo, serialização, processamento do equipamento e o jitter existente. A propagação usa a aproximação de 5 µs/km (distância em metros dividida por 200.000, em milissegundos). O guia [Cisco Virtualized Workload Mobility](https://www.cisco.com/c/en/us/td/docs/solutions/Enterprise/Data_Center/DCI/4-0/Netapp/dciNetapp.pdf) apresenta essa estimativa para fibra. O shLab usa a mesma aproximação didática para os cabos do catálogo; não simula o fator de velocidade de cada fabricante nem anuncia essa constante como especificação de todos os cabos. A latência base herdada continua separada desse tempo de propagação e não representa uma medida elétrica.

## Rádio e obstruções

O usuário escolhe banda, canal, potência e uma obstrução próxima ao rádio: nenhuma, drywall, tijolos ou concreto. O formulário e a CLI não oferecem números arbitrários de ruído, perda ou atenuação. A CLI usa `wireless obstruction none|drywall|brick|concrete`; a potência continua configurável por `wireless tx-power N`.

Rádios novos são apresentados sem SSID e desabilitados. Os comandos de potência, obstrução ou ativação exigem um rádio previamente configurado; não criam silenciosamente um SSID padrão.

O modelo usa atenuações aproximadas de 0, 3, 10 e 12 dB, respectivamente. Drywall, tijolos e concreto usam os valores típicos citados no [Cisco Wireless RF Reference Guide](https://www.cisco.com/c/en/us/td/docs/wireless/controller/9800/technical-reference/wireless-rf-reference-guide.html). Essas aproximações não incorporam espessura, estrutura metálica ou medições de cada parede.

Uma obstrução pertence ao entorno do rádio e afeta seus enlaces. Não representa uma parede geométrica desenhada no canvas. O modelo existente usa a maior atenuação entre os dois rádios, sem somá-las. A distância vem da posição dos equipamentos; a interferência deriva dos outros APs ativos próximos, da banda e da sobreposição de canais; sinal e ruído efetivos determinam SNR e perda. A obstrução reduz o sinal; não cria uma fonte de interferência.

Snapshots antigos preservam o ruído de fundo e a atenuação existentes. Atenuações que não correspondem a um material são exibidas como condição preservada do laboratório até que o usuário escolha uma obstrução. Não há migração que reescreva os experimentos salvos.

Os perfis WLAN do WLC seguem os mesmos controles: ruído somente leitura e obstrução selecionada por material no formulário guiado. O envio pelo editor JSON também mantém o ruído anterior (ou -95 dBm do modelo para um perfil novo) e permite somente uma obstrução conhecida ou uma atenuação legada preservada. Essa proteção pertence à interface de edição; os contratos do motor continuam aceitando snapshots e condições técnicas dos cenários. Renomear ou reordenar perfis não exige apagar suas condições existentes.

## Validação

Os testes de condições físicas conferem a alteração do instante real de entrega pelo comprimento do cabo, preservação das condições internas, persistência, redução de sinal por obstrução, interferência causada por um AP em canal sobreposto e rejeição dos antigos comandos de ruído/atenuação numéricos. Os testes existentes de rádio e perfis verificam autenticação, transporte, alcance e compatibilidade das mídias.

O teste de DHCP revelou diferença de arredondamento ao converter prazos absolutos de concessão em atrasos relativos e somá-los de volta ao relógio. Timers de cliente e expiração do servidor agora usam agendamento absoluto, preservando os instantes da concessão e a validação estrita existente.
