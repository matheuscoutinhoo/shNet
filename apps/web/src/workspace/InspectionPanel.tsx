import { configurationSchemas } from '@shlab/engine';
import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function InspectionPanel({ lab, device }: { lab: LabController; device: Device }) {
  const a = device.firewall?.application;
  if (!device.firewall) return null;
  const config = a
    ? { enabled: a.enabled, defaultAction: a.defaultAction, rules: a.rules.map(({ hits: _hits, ...r }) => r) }
    : {
        enabled: true,
        defaultAction: 'permit',
        rules: [
          { sequence: 10, application: 'http', action: 'deny', host: 'blocked.lab' },
          { sequence: 20, application: 'dns', action: 'deny', nameSuffix: 'blocked.lab' },
        ],
      };
  return (
    <section className="inspection-panel tunnel-panel">
      <h4>Inspeção de aplicação</h4>
      <p className="muted">
        Classifica o primeiro pedido HTTP em texto e consultas DNS reais. Regras ordenadas combinam Host,
        prefixo de caminho ou sufixo DNS. Não lê tráfego cifrado. Cabeçalhos parciais podem atravessar antes
        da classificação; o segmento que completa um pedido bloqueado é descartado.
      </p>
      <form
        key={JSON.stringify(config)}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          lab.change((engine) =>
            engine.configureInspection(device.id, JSON.parse(String(f.get('application'))))
          );
        }}
      >
        <ConfigEditor
          schema={configurationSchemas.inspection}
          choices={configChoices(lab.engine, device)}
          label="Inspeção HTTP/DNS JSON"
          name="application"
          rows={10}
          defaultValue={JSON.stringify(config, null, 2)}
          required
          spellCheck={false}
        />
        <button className="button small">Aplicar inspeção</button>
      </form>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Regra</th>
              <th>Aplicação / ação</th>
              <th>Hits</th>
            </tr>
          </thead>
          <tbody>
            {a?.rules.map((r) => (
              <tr key={r.sequence}>
                <td>{r.sequence}</td>
                <td>
                  {r.application} / {r.action}
                </td>
                <td>{r.hits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Destino</th>
              <th>Aplicação</th>
              <th>Decisão</th>
            </tr>
          </thead>
          <tbody>
            {a?.flows.map((f) => (
              <tr key={f.id} data-inspection-decision={f.decision}>
                <td>
                  {f.host ?? f.serverIp}
                  {f.path}
                </td>
                <td>{f.application}</td>
                <td>{f.decision}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
