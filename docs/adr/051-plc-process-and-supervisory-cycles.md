# ADR-051 — processo PLC e ciclos de supervisão por Modbus

Data: 15/10/2026. Contrato em qualificação: `2026.10.15.3`.

## Modelo de processo

Um PLC/servidor Modbus pode executar um tanque simplificado com nível de 0 a 1000, entrada por bomba e saída contínua. O estado interno usa ponto fixo; a integração e a lógica são avaliadas em ciclos de 100 a 10000 ms. O controle automático aplica histerese ao setpoint de um holding register e publica sensor, bomba e alarme nos bancos input registers, coils e discrete inputs. O modo manual aceita a coil comandada por Modbus. Um setpoint automático acima de 1000 é inválido e desliga a bomba.

Alarmes baixo/alto usam histerese e permanecem retidos após a condição limpar até reconhecimento. Reconhecer uma condição ainda ativa não a apaga. A perda de energia interrompe scans e bombeamento, enquanto a drenagem continua nas fronteiras de integração. Desativar o processo pausa o modelo; parar apenas o serviço TCP não interrompe a lógica PLC. Aplicar sua configuração reinicia o nível informado.

Esse é um modelo didático de processo e rede. Não executa ladder ou firmware, nem certifica física, segurança funcional, disponibilidade industrial ou precisão temporal de hardware.

## HMI, SCADA e MES

Hosts PC/servidor podem executar leituras periódicas Modbus TCP IPv4, funções 03/04, com intervalo, deadline, faixa de endereços e limiar de leituras perdidas. Cada tentativa usa MBAP/PDU binários e passa pelo TCP e pelos enlaces. Valores e latência vêm da resposta recebida; nenhuma amostra é copiada diretamente do PLC para a HMI.

Falhas consecutivas geram alarme de comunicação. A última amostra permanece visível com timestamp, idade/qualidade e erro; uma resposta válida limpa o alarme. Limiares opcionais aplicam alarme ao valor lido. O deadline usa o timestamp real da resposta; o painel e a coleta do ciclo têm resolução de 100 ms. Os formulários ficam em **Validar rede e cenários → PLC / HMI**. Reconhecer um alarme preserva a execução que estava ativa, reiniciando o Worker com a geração atualizada.

No modelo nativo **Processo PLC, HMI, SCADA e MES**, dez equipamentos têm acesso e alimentação A/B. O PLC usa scan de 100 ms; HMI e SCADA leem a cada 1 s, MES a cada 2 s, deadline de 800 ms. As cargas representam leitura de supervisão e comando de setpoint pelo MES, sem simular todo o software de gestão industrial. Vídeo continua fora do requisito confirmado.

## Persistência e diagnóstico

Timers, processo, alarmes e leituras em trânsito são serializados e validados. Remover bancos Modbus referenciados pelo processo é recusado antes de modificar a configuração. A retenção TCP conserva a conexão de uma leitura pendente até o ciclo registrar sua resposta ou falha. Clonar uma célula reinicia timers/contadores e remapeia o destino da HMI; duplicar só uma HMI mantém seu ciclo desabilitado para revisão.

O diff de configuração considera parâmetros do processo e da HMI, preservando setpoint e bancos não gerenciados. Exclui nível, amostras, alarmes e saídas gerenciadas da dinâmica do processo, além de saúde/timers do bond. Eventos de scans, amostras e alarmes têm explicações e filtro próprio; assertions verificam alarme PLC e alarmes HMI de processo/comunicação.

Os cinco presets cobrem baseline, perda/retorno do PLC, parada apenas do serviço Modbus, perda de acesso e alteração de setpoint pela rede. Falhas previstas são medidas por fluxo e geram assertions de alarme e recuperação. A qualificação deve incluir regressão completa, PostgreSQL, Workers compilados, navegação nos dois temas e restauração determinística.
