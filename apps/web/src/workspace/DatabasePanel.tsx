import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function DatabasePanel({ lab, device }: { lab: LabController; device: Device }) {
  return (
    <section>
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
          <input name="port" type="number" min={1} max={65535} defaultValue={device.database?.port ?? 8080} />
        </label>
        <label>
          Chave do banco
          <input
            name="key"
            type="password"
            minLength={8}
            maxLength={128}
            required
            defaultValue={device.database?.key ?? 'database-key'}
          />
        </label>
        <button className="button small primary">Aplicar banco</button>
      </form>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          const f = new FormData(ev.currentTarget);
          lab.change(
            (e) =>
              e.queryDatabase(
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
          Servidor IPv4/IPv6
          <input name="target" required />
        </label>
        <label>
          Porta do servidor
          <input name="port" type="number" min={1} max={65535} defaultValue={8080} />
        </label>
        <label>
          Chave de acesso
          <input
            name="key"
            type="password"
            minLength={8}
            maxLength={128}
            defaultValue="database-key"
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
