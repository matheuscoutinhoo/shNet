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

O laboratório admite até 256 entradas por réplica, contando leituras, alterações e barreiras de eleição, sem compactação. Ao atingir o limite, novas consultas são recusadas. Remover membro/grupo desabilita os bancos e preserva suas cópias locais; clonar o grupo completo cria outro grupo vazio. O [ADR-060](adr/060-quorum-backed-sql-service.md) registra as decisões e o restante de R08.
