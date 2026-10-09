import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { Save } from 'lucide-react';
import { type Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function RipPanel({ lab, device }: { lab: LabController; device: Device }) {
  const state = device.rip;
  return (
    <div className="protocol-panel rip-panel">
      <div className="learning-card">
        <strong>Vetor de distância</strong>
        <p>
          RIPv2 anuncia redes aos vizinhos por UDP/520. Neste modelo, redes diretamente conectadas têm custo
          1; cada receptor soma 1. Métrica 16 significa inalcançável. Avance os eventos para acompanhar as
          mudanças.
        </p>
      </div>
      <details>
        <summary>Filtros, métricas, redistribuição e key chain</summary>
        <form
          key={state?.token ?? device.id}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            lab.change((engine) => engine.configureRip(device.id, JSON.parse(String(form.get('advanced')))));
          }}
        >
          <ConfigEditor
            choices={configChoices(lab.engine, device)}
            label="Configuração avançada RIP JSON"
            schema={configurationSchemas.rip}
            name="advanced"
            rows={14}
            defaultValue={JSON.stringify(
              {
                enabled: state?.enabled ?? true,
                interfaces: state?.interfaces ?? [],
                holdDownMs: state?.holdDownMs ?? 0,
                redistributeStatic: state?.redistributeStatic ?? false,
                staticMetric: state?.staticMetric ?? 1,
                staticTag: state?.staticTag ?? 0,
              },
              null,
              2
            )}
          />
          <button className="button small">Aplicar configuração avançada</button>
        </form>
      </details>
      <form
        key={state?.token ?? device.id}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          lab.change(() =>
            lab.engine.configureRip(device.id, {
              enabled: form.has('enabled'),
              holdDownMs: state?.holdDownMs ?? 0,
              redistributeStatic: state?.redistributeStatic ?? false,
              staticMetric: state?.staticMetric ?? 1,
              staticTag: state?.staticTag ?? 0,
              interfaces: device.interfaces
                .filter((port) => form.has(port.id + '-enabled'))
                .map((port) => ({
                  ...state?.interfaces.find((config) => config.port === port.id),
                  port: port.id,
                  passive: form.has(port.id + '-passive'),
                  poisonReverse: form.has(port.id + '-poison'),
                })),
            })
          );
        }}
      >
        <label className="check-label">
          <input type="checkbox" name="enabled" defaultChecked={state?.enabled ?? true} /> Ativar RIPv2
        </label>
        {device.interfaces
          .filter((port) => port.mode === 'routed')
          .map((port) => {
            const config = state?.interfaces.find((entry) => entry.port === port.id);
            return (
              <fieldset key={port.id}>
                <legend>
                  {port.name} · {port.ip ?? 'Sem IPv4'}
                </legend>
                <label className="check-label">
                  <input type="checkbox" name={port.id + '-enabled'} defaultChecked={!!config} /> Participar
                  do RIP em {port.name}
                </label>
                <label className="check-label">
                  <input type="checkbox" name={port.id + '-passive'} defaultChecked={config?.passive} />{' '}
                  Passiva (anunciar rede sem enviar atualizações)
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    name={port.id + '-poison'}
                    defaultChecked={config?.poisonReverse ?? true}
                  />{' '}
                  Poison reverse
                </label>
              </fieldset>
            );
          })}
        <p className="muted">
          Aplicar reinicia a tabela RIP. Sem poison reverse, o split horizon omite rotas aprendidas pela
          interface de saída.
        </p>
        <button className="button small primary">
          <Save size={14} /> Aplicar RIP
        </button>
      </form>
      <details className="table-section">
        <summary>Hold-down, redistribuição, filtros e chaves</summary>
        <p className="muted">
          Configure custos, prefixos permitidos por direção e períodos de validade das chaves. O formulário
          acima preserva os ajustes avançados.
        </p>
        <form
          key={'advanced-' + (state?.token ?? device.id)}
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get('config'));
            lab.change(() => lab.engine.configureRip(device.id, JSON.parse(value)));
          }}
        >
          <ConfigEditor
            choices={configChoices(lab.engine, device)}
            label="Configuração RIP (JSON)"
            schema={configurationSchemas.rip}
            name="config"
            rows={14}
            spellCheck={false}
            defaultValue={JSON.stringify(
              {
                enabled: state?.enabled ?? true,
                holdDownMs: state?.holdDownMs ?? 0,
                redistributeStatic: state?.redistributeStatic ?? false,
                staticMetric: state?.staticMetric ?? 1,
                staticTag: state?.staticTag ?? 0,
                interfaces: state?.interfaces ?? [],
              },
              null,
              2
            )}
          />
          <button className="button small primary">
            <Save size={14} /> Aplicar RIP avançado
          </button>
        </form>
      </details>
      <section className="table-section">
        <h4>Tabela RIP</h4>
        <p className="muted">Update 30 s ±5 s · timeout 180 s · coleta 120 s</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Rede / origem</th>
                <th>Métrica</th>
                <th>Validade</th>
              </tr>
            </thead>
            <tbody>
              {state?.table.map((route) => (
                <tr key={route.network + '/' + route.prefix} data-metric={route.metric}>
                  <td>
                    {route.network}/{route.prefix}
                    <br />
                    <small>
                      {route.learnedFrom ?? 'Conectada'} · tag {route.tag} ·{' '}
                      {device.interfaces.find((port) => port.id === route.port)?.name}
                    </small>
                  </td>
                  <td>{route.metric === 16 ? '16 · retirada' : route.metric}</td>
                  <td>
                    {route.garbageAt !== undefined ? 'Coleta ' : ''}
                    {route.expiresAt === undefined && route.garbageAt === undefined
                      ? '—'
                      : Math.max(
                          0,
                          ((route.garbageAt ?? route.expiresAt!) - lab.engine.state.clock) / 1000
                        ).toFixed(1) + ' s'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!state?.table.length && <p className="muted">Nenhuma rota na tabela RIP.</p>}
      </section>
    </div>
  );
}
