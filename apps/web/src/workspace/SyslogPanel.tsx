import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
const severityNames = [
  '0 · Emergency',
  '1 · Alert',
  '2 · Critical',
  '3 · Error',
  '4 · Warning',
  '5 · Notice',
  '6 · Info',
  '7 · Debug',
];
export function SyslogPanel({ lab, device }: { lab: LabController; device: Device }) {
  return (
    <section className="syslog-panel">
      <h4>Syslog · registros pela rede</h4>
      <p className="muted">
        Mensagens por UDP/514, sem confirmação de entrega. O limite de severidade inclui valores iguais ou
        menores.
      </p>
      <form
        key={JSON.stringify(device.syslogClient)}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          lab.change((engine) =>
            engine.configureSyslog(device.id, {
              enabled: data.has('enabled'),
              server: data.get('server'),
              severity: Number(data.get('severity')),
              facility: Number(data.get('facility')),
              automatic: data.has('automatic'),
            })
          );
        }}
      >
        <label className="checkbox-label">
          <input name="enabled" type="checkbox" defaultChecked={device.syslogClient?.enabled} />
          Enviar syslog
        </label>
        <label>
          Destino syslog
          <input name="server" required defaultValue={device.syslogClient?.server ?? '192.168.20.10'} />
        </label>
        <div className="form-grid">
          <label>
            Limite de severidade
            <select name="severity" defaultValue={device.syslogClient?.severity ?? 6}>
              {severityNames.map((name, index) => (
                <option key={index} value={index}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Facility
            <input
              name="facility"
              type="number"
              min={0}
              max={23}
              required
              defaultValue={device.syslogClient?.facility ?? 23}
            />
          </label>
        </div>
        <label className="checkbox-label">
          <input name="automatic" type="checkbox" defaultChecked={device.syslogClient?.automatic ?? true} />
          Eventos automáticos
        </label>
        <p className="muted">
          Configuração, link up/down, vizinhança OSPF e alterações de STP. Mensagens recebidas e falhas de
          entrega não geram novos envios.
        </p>
        <button className="button small">Aplicar envio syslog</button>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          lab.change(
            (engine) => engine.sendSyslog(device.id, String(data.get('text')), Number(data.get('severity'))),
            false
          );
        }}
      >
        <label>
          Mensagem syslog
          <textarea
            aria-label="Mensagem syslog"
            name="text"
            required
            maxLength={300}
            defaultValue="Verificação do laboratório"
          />
        </label>
        <label>
          Severidade da mensagem
          <select name="severity" defaultValue={6}>
            {severityNames.map((name, index) => (
              <option key={index} value={index}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button className="button small primary" disabled={!device.power || !device.syslogClient?.enabled}>
          Enviar mensagem syslog
        </button>
      </form>
      {(device.type === 'server' || device.type === 'router') && (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={device.syslogServer?.enabled ?? false}
              onChange={(event) =>
                lab.change((engine) => engine.setSyslogEnabled(device.id, event.target.checked))
              }
            />
            Coletor syslog ativo
          </label>
          <div className="dns-heading">
            <h4>Registros recebidos · {device.syslogServer?.entries.length ?? 0}</h4>
            <button
              className="button small"
              disabled={!device.syslogServer?.entries.length}
              onClick={() =>
                lab.change((engine) => {
                  engine.device(device.id).syslogServer!.entries = [];
                })
              }
            >
              Limpar syslog
            </button>
          </div>
          <div className="table-scroll syslog-records">
            <table>
              <thead>
                <tr>
                  <th>Tempo / origem</th>
                  <th>PRI</th>
                  <th>Mensagem</th>
                </tr>
              </thead>
              <tbody>
                {device.syslogServer?.entries.map((entry, index) => (
                  <tr key={entry.message.id + ':' + index}>
                    <td>
                      {entry.receivedAt.toFixed(3)} ms
                      <br />
                      {entry.message.hostname}
                      <br />
                      {entry.source}
                    </td>
                    <td>{entry.message.facility * 8 + entry.message.severity}</td>
                    <td>{entry.message.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="muted">
        Até 500 registros. Tempo virtual compartilhado; sem relay, TLS ou formato binário interoperável.
        Syslog UDP pode perder ou duplicar mensagens.
      </p>
    </section>
  );
}
