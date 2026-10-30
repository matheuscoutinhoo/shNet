import { deviceCapabilities, type Device } from '@shlab/engine';
import { useState } from 'react';
import type { LabController } from './useLab';
import { QuorumPanel } from './QuorumPanel';
export function DatabasePanel({ lab, device }: { lab: LabController; device: Device }) {
  return (
    <section className="database-panel">
      <QuorumPanel key={'quorum-' + device.id} lab={lab} device={device} />
      {device.quorum && (
        <section className="database-ha-panel" data-sql-role={device.quorum.node.role}>
          <h4>Replicação do banco SQL</h4>
          {device.databaseHa ? (
            <>
              <p aria-live="polite">
                {device.quorum.node.role} · aplicado {device.databaseHa.applied} ·{' '}
                {device.databaseHa.pending.length} consultas aguardando maioria
              </p>
              <p className="muted">
                Leituras e alterações só respondem após confirmação de maioria. Use o IP individual do líder;
                novas conexões podem usar descoberta por réplicas e cluster explícitos. Não há migração de TCP
                ou VIP automático neste servidor.
              </p>
              <p className="muted">
                Histórico compactado automaticamente, até 256 entradas retidas e 512 KiB de dados
                materializados. Timeout tem resultado indeterminado; consulte o líder antes de repetir uma
                alteração. Remover membro/grupo desabilita os bancos, preservando os dados locais.
              </p>
            </>
          ) : (
            <>
              <p className="muted">
                Ative bancos vazios com a mesma porta e chave em todos os membros. Aguarde sincronização do
                quorum antes de vincular o grupo.
              </p>
              <button
                className="button small"
                onClick={() => lab.change((e) => e.configureDatabaseHa(device.id))}
              >
                Vincular bancos ao quorum
              </button>
            </>
          )}
        </section>
      )}
      {deviceCapabilities(device).databaseServer && (
        <>
          <h4>Banco de dados por HTTP/TCP</h4>
          <p className="muted">
            Serviço do laboratório: CREATE TABLE, INSERT, SELECT, UPDATE e DELETE. Máximo de 16 tabelas, 16
            colunas e 256 linhas por tabela. Não usa o protocolo PostgreSQL.
          </p>
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const f = new FormData(ev.currentTarget);
              lab.change((e) =>
                e.configureDatabase(device.id, {
                  enabled: f.get('enabled') === 'on',
                  port: Number(f.get('port')),
                  key: String(f.get('key')),
                })
              );
            }}
          >
            <label>
              <input name="enabled" type="checkbox" defaultChecked={device.database?.enabled ?? false} />
              Habilitar banco
            </label>
            <label>
              Porta HTTP
              <input
                name="port"
                type="number"
                min={1}
                max={65535}
                readOnly={!!device.databaseHa}
                defaultValue={device.database?.port ?? 8080}
              />
            </label>
            <label>
              Chave do banco
              <input
                name="key"
                type="password"
                minLength={8}
                maxLength={128}
                required
                readOnly={!!device.databaseHa}
                defaultValue={device.database?.key ?? 'database-key'}
              />
            </label>
            <button className="button small primary">Aplicar banco</button>
          </form>
        </>
      )}
      <DatabaseQueryForm key={'query-' + device.id} lab={lab} device={device} />
      <details>
        <summary>Exemplos de SQL</summary>
        <pre>
          {
            'CREATE TABLE sensores (id, valor)\nINSERT INTO sensores (id, valor) VALUES (1, 23.5)\nSELECT * FROM sensores WHERE id = 1 LIMIT 10\nUPDATE sensores SET valor = 24 WHERE id = 1\nDELETE FROM sensores WHERE id = 1'
          }
        </pre>
      </details>
      {device.database && (
        <>
          <p>
            {device.database.queries} consultas aceitas · {device.database.rejected} rejeitadas
          </p>
          {device.database.tables.map((t) => (
            <p key={t.name}>
              {t.name}: {t.rows.length} linhas · {t.columns.join(', ')}
            </p>
          ))}
        </>
      )}
      {device.databaseClient && (
        <section className="database-client-results" aria-live="polite">
          <h4>Consultas com descoberta</h4>
          {device.databaseClient.requests
            .slice(-5)
            .reverse()
            .map((r) => (
              <details key={r.id} open>
                <summary>
                  {
                    {
                      discovering: 'Descobrindo líder',
                      querying: 'Aguardando consulta',
                      complete: 'Concluída',
                      failed: 'Recusada',
                      unknown: 'Resultado indeterminado',
                    }[r.phase]
                  }{' '}
                  · {r.config.targets[r.cursor]}:{r.config.port}
                </summary>
                {r.error && <p>{r.error}</p>}
                {r.term && (
                  <p>
                    Autoridade observada: termo {r.term}, índice {r.index}.
                  </p>
                )}
                {r.response && <pre>{r.response}</pre>}
              </details>
            ))}
        </section>
      )}
      {device.tcpConnections
        ?.filter((c) => c.role === 'client' && c.received.startsWith('HTTP/'))
        .slice(-5)
        .map((c) => (
          <details key={c.id}>
            <summary>
              {c.remoteIp}:{c.remotePort} · {c.state}
            </summary>
            <pre>{c.received}</pre>
          </details>
        ))}
    </section>
  );
}

function DatabaseQueryForm({ lab, device }: { lab: LabController; device: Device }) {
  const [automatic, setAutomatic] = useState(false);
  const profile = device.databaseClient?.config;
  return (
    <form
      className="database-query"
      onSubmit={(ev) => {
        ev.preventDefault();
        const f = new FormData(ev.currentTarget);
        lab.change(
          (e) =>
            automatic
              ? e.queryDatabaseCluster(device.id, String(f.get('query')), {
                  cluster: String(f.get('cluster')),
                  targets: String(f.get('targets'))
                    .split(/[\s,;]+/)
                    .filter(Boolean),
                  port: Number(f.get('port')),
                  key: String(f.get('key')),
                })
              : e.queryDatabase(
                  device.id,
                  String(f.get('target')),
                  String(f.get('query')),
                  String(f.get('key')),
                  Number(f.get('port'))
                ),
          false
        );
      }}
    >
      <h4>Consulta pela rede</h4>
      <label>
        <input type="checkbox" checked={automatic} onChange={(ev) => setAutomatic(ev.target.checked)} />
        Descobrir líder automaticamente
      </label>
      {automatic && (
        <>
          <label>
            Réplicas IPv4/IPv6
            <input
              name="targets"
              required
              defaultValue={profile?.targets.join(', ')}
              placeholder="10.90.0.11, 10.90.0.12, 10.90.0.13"
            />
          </label>
          <label>
            Cluster esperado
            <input name="cluster" required maxLength={64} defaultValue={profile?.cluster} />
          </label>
          <p className="muted">
            Cada réplica é consultada pela rede. A consulta SQL é enviada uma vez ao líder confirmado. Perda
            da resposta exige verificar o resultado antes de repetir uma alteração.
          </p>
        </>
      )}
      <label>
        Servidor IPv4/IPv6
        <input name="target" required={!automatic} disabled={automatic} />
      </label>
      <label>
        Porta do servidor
        <input name="port" type="number" min={1} max={65535} defaultValue={profile?.port ?? 8080} />
      </label>
      <label>
        Chave de acesso
        <input
          name="key"
          type="password"
          minLength={8}
          maxLength={128}
          defaultValue={profile?.key ?? 'database-key'}
          required
        />
      </label>
      <label>
        Consulta SQL
        <textarea
          name="query"
          rows={3}
          maxLength={2048}
          defaultValue="SELECT * FROM sensores LIMIT 10"
          required
        />
      </label>
      <button className="button small">Enviar consulta SQL</button>
    </form>
  );
}
