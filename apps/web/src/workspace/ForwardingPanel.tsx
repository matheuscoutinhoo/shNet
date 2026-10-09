import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { qosConfig, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function ForwardingPanel({ lab, device }: { lab: LabController; device: Device }) {
  const ports = device.interfaces.filter(
      (p) => !p.logical && !p.aggregate && !p.tunnel && !p.vxlan && p.media !== 'wifi'
    ),
    [id, setId] = useState(ports[0]?.id ?? ''),
    p = ports.find((p) => p.id === id);
  return (
    <div className="forwarding-panel">
      <p className="muted">
        QoS classifica e marca DSCP, aplica policer e coloca frames em uma fila com capacidade e taxa de
        saída. Prioridade estrita e WRR alteram a ordem de transmissão e a espera.
      </p>
      <label>
        Porta QoS
        <select aria-label="Porta QoS" value={id} onChange={(e) => setId(e.target.value)}>
          {ports.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {p && (
        <form
          key={id + ':' + (p.qos?.token ?? 'new')}
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            lab.change((e) => e.configureQos(device.id, id, JSON.parse(String(f.get('qos')))));
          }}
        >
          <ConfigEditor
            choices={configChoices(lab.engine, device)}
            label="Configuração QoS JSON"
            schema={configurationSchemas.qos}
            aria-label="Configuração QoS JSON"
            name="qos"
            rows={14}
            defaultValue={JSON.stringify(
              p.qos
                ? qosConfig(p)
                : {
                    ...qosConfig(p),
                    rateMbps: 1,
                    classes: [
                      {
                        name: 'WEB',
                        protocol: 'tcp',
                        destinationPort: 80,
                        priority: 7,
                        weight: 3,
                        mark: 46,
                      },
                    ],
                  },
              null,
              2
            )}
          />
          <button className="button small" type="submit">
            Aplicar QoS
          </button>
        </form>
      )}
      {p?.qos && (
        <>
          <p data-qos-depth={p.qos.queues.length}>
            Fila: {p.qos.queues.length}/{p.qos.queueLimit} · {p.qos.rateMbps} Mbps · {p.qos.scheduler}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Classe</th>
                  <th>Entrada/Saída</th>
                  <th>Descartes</th>
                  <th>Bytes</th>
                </tr>
              </thead>
              <tbody>
                {p.qos.stats.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>
                      {s.enqueued}/{s.dequeued}
                    </td>
                    <td>{s.dropped}</td>
                    <td>{s.bytes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {device.type === 'router' && (
        <>
          <h4>MPLS conceitual</h4>
          <p className="muted">
            FEC de entrada escolhe o caminho e aplica labels. A LFIB determina swap/pop nos roteadores
            seguintes; TTL e MTU continuam efetivos. Configure os próximos saltos IPv4 e as rotas de retorno.
            Não há LDP/RSVP ou serviço MPLS contratado.
          </p>
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const f = new FormData(ev.currentTarget);
              lab.change((e) => e.configureMpls(device.id, JSON.parse(String(f.get('mpls')))));
            }}
          >
            <ConfigEditor
              choices={configChoices(lab.engine, device)}
              label="FEC e LFIB JSON"
              schema={configurationSchemas.mpls}
              aria-label="FEC e LFIB JSON"
              name="mpls"
              rows={14}
              defaultValue={JSON.stringify(
                device.mpls ?? {
                  enabled: true,
                  ingress: [
                    { network: '10.2.0.0', prefix: 24, port: 'p1', nextHop: '192.0.2.2', labels: [100] },
                  ],
                  lfib: [],
                },
                null,
                2
              )}
            />
            <button className="button small" type="submit">
              Aplicar MPLS
            </button>
          </form>
          <p>
            FECs: {device.mpls?.ingress.length ?? 0} · labels LFIB: {device.mpls?.lfib.length ?? 0}
          </p>
        </>
      )}
    </div>
  );
}
