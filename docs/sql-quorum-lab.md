# Laboratório: banco SQL, quorum e partições

Abra **Banco SQL com consenso e falhas**. Os servidores SQL-1/2/3 têm endereços `10.90.0.11`, `.12` e `.13`; SQL-CLIENT usa `10.90.0.1`. Avance dois segundos e veja qual servidor está `leader` em **Banco de dados → Replicação do banco SQL**.

No SQL-CLIENT, abra **Banco de dados → Consulta pela rede**. Use o IP individual do líder, porta `8080` e chave `database-key`. Envie uma consulta por vez e execute a simulação até a resposta:

```sql
CREATE TABLE sensores (id, valor)
INSERT INTO sensores (id, valor) VALUES (1, 23.5)
SELECT * FROM sensores WHERE id = 1 LIMIT 10
UPDATE sensores SET valor = 24 WHERE id = 1
```

As tabelas só mudam após confirmação de maioria. A resposta aparece no painel do cliente; as tabelas e o índice aplicado aparecem em cada servidor. O papel de líder sozinho não comprova disponibilidade.

| Ensaio                   | Ação                                                                  | Resultado esperado                                                                                                         |
| ------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Queda do líder           | Desligue o servidor líder e avance dois segundos                      | Uma das outras réplicas torna-se líder. Uma nova consulta ao IP desse servidor lê os dados confirmados.                    |
| Partição do consenso     | Desative apenas os dois cabos dedicados do líder, preservando sua LAN | O antigo líder não confirma consultas novas. A maioria elege outro líder e continua operando.                              |
| Leitura durante partição | Envie `SELECT` ao antigo líder ainda ligado                           | A leitura aguarda nova confirmação e termina sem sucesso; a cópia antiga não é servida como leitura atual.                 |
| Retorno do líder antigo  | Reative os cabos e avance a simulação                                 | O histórico não confirmado é reconciliado com o da maioria; tabelas confirmadas convergem.                                 |
| Snapshot em trânsito     | Pause com consulta aguardando maioria, salve e reabra                 | A consulta e as mensagens continuam a partir do estado salvo, sem executar a operação duas vezes por causa da restauração. |
| Ausência de maioria      | Desligue duas réplicas                                                | Sem confirmação de novas leituras ou gravações; os dados históricos permanecem.                                            |

O timeout de três segundos virtuais informa **resultado indeterminado**. Uma gravação pode ser confirmada depois; consulte o estado antes de enviar novamente um `INSERT`. O cliente não troca o IP do destino automaticamente. Não há migração da conexão TCP nem VIP controlado pelo quorum.

O histórico confirmado é compactado automaticamente: os índices continuam absolutos, enquanto cada réplica conserva até 256 entradas recentes. O painel mostra o checkpoint e permite **Compactar histórico confirmado**. Repita mais de 256 consultas alterando as mesmas linhas e confira que novas operações continuam funcionando e que as três cópias convergem. Há limite de 128 entradas sem confirmação; sem maioria, a aplicação recusa propostas adicionais e preserva os dados confirmados.

Para estudar recuperação após compactação, desligue uma réplica, continue alterando as linhas na maioria e compacte o líder. Religue a réplica: o painel mostra os bytes recebidos do checkpoint. As tabelas antigas permanecem até a validação e instalação completas; depois são aplicadas as operações recentes. Pause durante essa transferência, salve e reabra para observar a continuação. Perdas e duplicações provocam retransmissão. Uma nova compactação no emissor reinicia a transferência; não há SLA universal para recuperação sob carga contínua.

O estado materializado compartilhado de chaves e tabelas tem orçamento de 512 KiB por checkpoint, incluindo a serialização UTF-8. Operações que aumentariam esse estado além do limite são recusadas antes da proposta. Excluir dados permite liberar espaço; a compactação reduz o histórico, não o tamanho das tabelas vivas. Saves antigos acima desse orçamento conservam seus dados, mas podem exigir redução antes da compactação. Permanecem os limites existentes da gramática SQL, tabelas, linhas, conexões e consultas pendentes. O checkpoint preserva o estado resultante; não é um arquivo de auditoria de todas as consultas anteriores.

Remover membro/grupo desabilita os bancos e preserva suas cópias locais; clonar o grupo completo cria outro grupo vazio. O [ADR-060](adr/060-quorum-backed-sql-service.md) registra a integração SQL e o [ADR-061](adr/061-quorum-compaction.md) registra a compactação. R08 permanece aberto para autoridade de endereço/descoberta do líder e os demais adaptadores de serviços.
