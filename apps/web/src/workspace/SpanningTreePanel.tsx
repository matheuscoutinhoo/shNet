import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { Save } from 'lucide-react';
import { bridgeId, bridgeLabel, portCost, multiStpConfig, type Device } from '@shlab/engine';
import type { LabController } from './useLab';

export function SpanningTreePanel({ lab, device }: { lab: LabController; device: Device }) {
  const [instance, setInstance] = useState(0);
  const [config, setConfig] = useState(() =>
    JSON.stringify(
      multiStpConfig(device) ?? { region: 'SHLAB', revision: 0, priorities: [], mappings: [] },
      null,
      2
    )
  );
  const tree = instance
    ? device.multiSpanningTree?.instances.find((i) => i.id === instance)?.tree
    : device.spanningTree;
  const stateFor = (p: Device['interfaces'][number]) =>
    instance ? p.spanningInstances?.find((i) => i.id === instance)?.state : p.spanningTree;
  return (
    <div className="stp-panel">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          lab.setError('');
          const mode = String(data.get('mode'));
          lab.change((engine) => {
            if (mode === 'pvst' || mode === 'mstp') {
              const c = JSON.parse(config);
              engine.configureMultiSpanningTree(device.id, {
                ...c,
                mode,
                priorities: [
                  ...(c.priorities ?? []).filter((p: { instance: number }) => p.instance !== 0),
                  { instance: 0, priority: Number(data.get('priority')) },
                ],
              });
            } else
              engine.configureSpanningTree(
                device.id,
                mode as 'off' | 'stp' | 'rstp',
                Number(data.get('priority'))
              );
          });
        }}
      >
        <div className="form-grid">
          <label>
            Modo STP
            <select
              name="mode"
              defaultValue={device.multiSpanningTree?.mode ?? device.spanningTree?.mode ?? 'off'}
              key={device.multiSpanningTree?.mode ?? device.spanningTree?.mode ?? 'off'}
            >
              <option value="off">Desabilitado</option>
              <option value="stp">STP</option>
              <option value="rstp">RSTP</option>
              <option value="pvst">PVST (rápido por VLAN)</option>
              <option value="mstp">MSTP (região e instâncias)</option>
            </select>
          </label>
          <label>
            Prioridade da bridge
            <select name="priority" defaultValue={tree?.priority ?? 32768} key={tree?.priority ?? 32768}>
              {Array.from({ length: 16 }, (_, index) => index * 4096).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <details>
          <summary>Instâncias PVST/MSTP</summary>
          <p className="muted">
            PVST cria uma árvore por VLAN configurada. MSTP agrupa VLANs pelo campo mappings; região, revisão
            e mapa devem coincidir entre switches. Prioridades usam instance e priority.
          </p>
          <ConfigEditor
            choices={configChoices(lab.engine, device)}
            label="Configuração de instâncias STP"
            schema={configurationSchemas.stp}
            className="config-json"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={9}
          />
        </details>
        <button className="button small primary">
          <Save size={14} /> Aplicar STP
        </button>
      </form>
      {device.multiSpanningTree && (
        <label>
          Instância STP
          <select value={instance} onChange={(e) => setInstance(Number(e.target.value))}>
            <option value="0">CST / CIST 0</option>
            {device.multiSpanningTree.instances.map((i) => (
              <option key={i.id} value={i.id}>
                {device.multiSpanningTree!.mode === 'pvst' ? 'VLAN' : 'MSTI'} {i.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {tree?.enabled ? (
        <>
          <dl className="key-values stp-summary">
            <div>
              <dt>Instância</dt>
              <dd>
                {device.multiSpanningTree?.mode.toUpperCase() ?? 'CST'} {instance} · {tree.mode.toUpperCase()}
              </dd>
            </div>
            <div>
              <dt>Bridge ID</dt>
              <dd>{bridgeLabel({ ...bridgeId(device), priority: tree.priority, instance })}</dd>
            </div>
            <div>
              <dt>Root ID</dt>
              <dd>{bridgeLabel(tree.root)}</dd>
            </div>
            <div>
              <dt>Custo à raiz</dt>
              <dd>{tree.cost}</dd>
            </div>
            <div>
              <dt>Root port</dt>
              <dd>
                {device.interfaces.find((port) => port.id === tree.rootPort)?.name ?? 'Esta bridge é a raiz'}
              </dd>
            </div>
            <div>
              <dt>Mudanças de topologia</dt>
              <dd>{tree.changes}</dd>
            </div>
          </dl>
          <section className="table-section stp-ports">
            <h4>Portas</h4>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Porta</th>
                    <th>Papel / estado</th>
                    <th>Custo</th>
                  </tr>
                </thead>
                <tbody>
                  {device.interfaces.map((port) => (
                    <tr
                      key={port.id}
                      data-port={port.id}
                      data-state={stateFor(port)?.state}
                      data-role={stateFor(port)?.role}
                    >
                      <td>
                        {port.name}
                        {port.mstBoundary && <small> · fronteira MST</small>}
                        {port.stpEdge && (
                          <small>
                            <br />
                            edge
                          </small>
                        )}
                      </td>
                      <td>
                        <strong>{stateFor(port)?.role}</strong>
                        <br />
                        <span>{stateFor(port)?.state}</span>
                      </td>
                      <td>{portCost(port)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <p className="muted">Spanning tree desabilitado.</p>
      )}
    </div>
  );
}
