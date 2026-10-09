import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { Save } from 'lucide-react';
import { type Device } from '@shlab/engine';
import type { LabController } from './useLab';

export function OspfPanel({ lab, device }: { lab: LabController; device: Device }) {
  const state = device.ospf;
  return (
    <div className="protocol-panel ospf-panel">
      <div className="learning-card">
        <strong>Rotas aprendidas pela rede</strong>
        <p>
          Hellos descobrem vizinhos. Os roteadores trocam LSAs e calculam o menor custo usando sua própria
          base. Avance a simulação para observar a convergência.
        </p>
      </div>
      <details>
        <summary>Áreas stub/NSSA, redistribuição e autenticação</summary>
        <form
          key={state?.token ?? device.id}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            lab.change((engine) => engine.configureOspf(device.id, JSON.parse(String(form.get('advanced')))));
          }}
        >
          <ConfigEditor
            choices={configChoices(lab.engine, device)}
            label="Configuração avançada OSPF JSON"
            schema={configurationSchemas.ospf}
            name="advanced"
            rows={14}
            defaultValue={JSON.stringify(
              {
                enabled: state?.enabled ?? true,
                routerId: state?.routerId ?? '1.1.1.1',
                areas: state?.areas ?? [],
                externalRoutes: state?.externalRoutes ?? [],
                interfaces: state?.interfaces ?? [],
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
            lab.engine.configureOspf(device.id, {
              enabled: form.has('enabled'),
              routerId: String(form.get('routerId')),
              areas: state?.areas ?? [],
              externalRoutes: state?.externalRoutes ?? [],
              interfaces: device.interfaces
                .filter((port) => form.has(port.id + '-enabled'))
                .map((port) => ({
                  ...state?.interfaces.find((config) => config.port === port.id),
                  port: port.id,
                  area: Number(form.get(port.id + '-area')),
                  cost: Number(form.get(port.id + '-cost')),
                  passive: form.has(port.id + '-passive'),
                  networkType: String(form.get(port.id + '-network')),
                  priority: Number(form.get(port.id + '-priority')),
                  helloMs: Number(form.get(port.id + '-hello')) * 1000,
                  deadMs: Number(form.get(port.id + '-dead')) * 1000,
                })),
            })
          );
        }}
      >
        <label>
          Router ID
          <input
            name="routerId"
            required
            defaultValue={state?.routerId ?? device.interfaces.find((port) => port.ip)?.ip ?? '1.1.1.1'}
          />
        </label>
        <label className="check-label">
          <input type="checkbox" name="enabled" defaultChecked={state?.enabled ?? true} /> Ativar OSPF
        </label>
        {device.interfaces
          .filter((port) => port.mode === 'routed')
          .map((port) => {
            const config = state?.interfaces.find((entry) => entry.port === port.id);
            return (
              <details key={port.id} open={!!config} className="ospf-interface">
                <summary>
                  {port.name} · {port.ip ? `${port.ip}/${port.prefix}` : 'Sem IPv4'}
                </summary>
                <label className="check-label">
                  <input type="checkbox" name={port.id + '-enabled'} defaultChecked={!!config} /> Participar
                  do OSPF em {port.name}
                </label>
                <div className="form-row">
                  <label>
                    Área
                    <input
                      type="number"
                      name={port.id + '-area'}
                      min="0"
                      max="4294967295"
                      defaultValue={config?.area ?? 0}
                      required
                    />
                  </label>
                  <label>
                    Custo
                    <input
                      type="number"
                      name={port.id + '-cost'}
                      min="1"
                      max="65535"
                      defaultValue={config?.cost ?? 1}
                      required
                    />
                  </label>
                </div>
                <label>
                  Tipo de rede
                  <select name={port.id + '-network'} defaultValue={config?.networkType ?? 'point-to-point'}>
                    <option value="point-to-point">Ponto a ponto</option>
                    <option value="broadcast">Broadcast (DR / BDR)</option>
                  </select>
                </label>
                <label>
                  Prioridade DR
                  <input
                    type="number"
                    name={port.id + '-priority'}
                    min="0"
                    max="255"
                    defaultValue={config?.priority ?? 1}
                    required
                  />
                </label>
                <div className="form-row">
                  <label>
                    Hello (s)
                    <input
                      type="number"
                      name={port.id + '-hello'}
                      min="1"
                      max="60"
                      defaultValue={(config?.helloMs ?? 10000) / 1000}
                      required
                    />
                  </label>
                  <label>
                    Dead (s)
                    <input
                      type="number"
                      name={port.id + '-dead'}
                      min="2"
                      max="240"
                      defaultValue={(config?.deadMs ?? 40000) / 1000}
                      required
                    />
                  </label>
                </div>
                <label className="check-label">
                  <input type="checkbox" name={port.id + '-passive'} defaultChecked={config?.passive} />{' '}
                  Passiva (anunciar rede sem Hello)
                </label>
              </details>
            );
          })}
        <p className="muted">
          Aplicar reinicia as adjacências deste roteador. Dead deve ser pelo menos duas vezes Hello.
        </p>
        <button className="button small primary">
          <Save size={14} /> Aplicar OSPF
        </button>
      </form>
      <details className="table-section">
        <summary>Áreas stub/NSSA, rotas externas e autenticação</summary>
        <p className="muted">
          Edite a configuração completa para escolher tipos de área, métricas E1/E2, tags e chaves por
          interface. As alterações do formulário acima preservam estes campos.
        </p>
        <form
          key={'advanced-' + (state?.token ?? device.id)}
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get('config'));
            lab.change(() => lab.engine.configureOspf(device.id, JSON.parse(value)));
          }}
        >
          <ConfigEditor
            choices={configChoices(lab.engine, device)}
            label="Configuração OSPF (JSON)"
            schema={configurationSchemas.ospf}
            name="config"
            rows={14}
            spellCheck={false}
            defaultValue={JSON.stringify(
              {
                enabled: state?.enabled ?? true,
                routerId: state?.routerId ?? '1.1.1.1',
                interfaces: state?.interfaces ?? [],
                areas: state?.areas ?? [],
                externalRoutes: state?.externalRoutes ?? [],
              },
              null,
              2
            )}
          />
          <button className="button small primary">
            <Save size={14} /> Aplicar OSPF avançado
          </button>
        </form>
      </details>
      <section className="table-section">
        <h4>Vizinhos OSPF</h4>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Router ID / porta</th>
                <th>Estado</th>
                <th>Dead</th>
              </tr>
            </thead>
            <tbody>
              {state?.neighbors.map((neighbor) => (
                <tr key={neighbor.port + neighbor.routerId} data-state={neighbor.state}>
                  <td>
                    {neighbor.routerId}
                    <br />
                    <small>
                      {device.interfaces.find((port) => port.id === neighbor.port)?.name} · {neighbor.ip}
                    </small>
                  </td>
                  <td>{neighbor.state}</td>
                  <td>{Math.max(0, (neighbor.deadAt - lab.engine.state.clock) / 1000).toFixed(1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!state?.neighbors.length && <p className="muted">Nenhum vizinho descoberto.</p>}
      </section>
      {state?.interfaces
        .filter((config) => config.networkType === 'broadcast')
        .map((config) => {
          const port = state.ports.find((entry) => entry.port === config.port)!;
          return (
            <p key={config.port}>
              {device.interfaces.find((entry) => entry.id === config.port)?.name}: DR {port.dr} · BDR{' '}
              {port.bdr}
            </p>
          );
        })}
      <section className="table-section">
        <h4>Rotas OSPF</h4>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Rede</th>
                <th>Próximo salto</th>
                <th>Custo</th>
              </tr>
            </thead>
            <tbody>
              {state?.routes.map((route) => (
                <tr key={route.network + '/' + route.prefix}>
                  <td>
                    {route.pathType === 'inter'
                      ? 'O IA'
                      : route.pathType && ['E1', 'E2', 'N1', 'N2'].includes(route.pathType)
                        ? 'O ' + route.pathType
                        : 'O'}{' '}
                    {route.network}/{route.prefix}
                  </td>
                  <td>{route.nextHop}</td>
                  <td>{route.metric}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!state?.routes.length && <p className="muted">Nenhuma rota aprendida.</p>}
      </section>
      <section className="table-section">
        <h4>LSDB local · {state?.lsdb.length ?? 0} LSAs</h4>
        {state?.lsdb.map((lsa) => (
          <details key={`${lsa.area}:${lsa.type}:${lsa.id}:${lsa.advertisingRouter}`}>
            <summary>
              Área {lsa.area} · {lsa.type} · {lsa.id}
              {lsa.withdrawn ? ' · retirada' : ''}
            </summary>
            <p>
              Origem {lsa.advertisingRouter} · sequência {lsa.sequence} · idade{' '}
              {((lab.engine.state.clock - lsa.originatedAt) / 1000).toFixed(1)} s
            </p>
            <pre>{JSON.stringify(lsa, null, 2)}</pre>
          </details>
        ))}
      </section>
    </div>
  );
}
