import { useState } from 'react';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function LacpPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [editing, setEditing] = useState<string>();
  const selected = device.interfaces.find((p) => p.id === editing);
  return (
    <div className="lacp-panel protocol-panel">
      <p className="muted">
        LACP negocia membros por frames de controle. Active inicia; passive responde. Pelo menos um lado deve
        ser active. O hash por fluxo escolhe um membro; a falha redistribui os fluxos entre os restantes.
      </p>
      <section className="table-section">
        <h4>EtherChannels</h4>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Grupo</th>
                <th>Membros / estado</th>
                <th>Parceiro</th>
              </tr>
            </thead>
            <tbody>
              {device.interfaces
                .filter((p) => p.aggregate)
                .map((p) => (
                  <tr key={p.id} data-members={p.aggregate!.selected.length}>
                    <td>
                      {p.name}
                      <br />
                      {p.aggregate!.mode} · mínimo {p.aggregate!.minLinks}
                    </td>
                    <td>
                      {p.aggregate!.members.map((id) => (
                        <div key={id}>
                          {device.interfaces.find((m) => m.id === id)?.name} ·{' '}
                          {p.aggregate!.selected.includes(id) ? 'collecting/distributing' : 'suspended'}
                        </div>
                      ))}
                    </td>
                    <td>
                      {[...new Set(p.aggregate!.received.map((r) => r.pdu.actor.system))].join(', ') ||
                        'Sem LACP recebido'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {device.interfaces
          .filter((p) => p.aggregate)
          .map((p) => (
            <div className="lacp-actions" key={p.id}>
              <button className="button small" onClick={() => setEditing(p.id)}>
                Editar {p.name}
              </button>
              <button
                className="button small"
                onClick={() => lab.change((e) => e.removeLacp(device.id, p.id))}
              >
                Remover {p.name}
              </button>
            </div>
          ))}
      </section>
      <form
        key={editing ?? 'new'}
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          const result = lab.change((e) =>
            e.configureLacp(
              device.id,
              Number(f.get('number')),
              String(f.get('mode')) as 'active' | 'passive',
              f.getAll('members').map(String),
              Number(f.get('minLinks'))
            )
          );
          if (result) setEditing(undefined);
        }}
      >
        <h4>{editing ? 'Editar grupo' : 'Criar grupo'}</h4>
        <div className="form-grid">
          <label>
            Número EtherChannel
            <input
              name="number"
              type="number"
              min={1}
              max={64}
              defaultValue={selected?.aggregate?.number ?? 1}
              required
            />
          </label>
          <label>
            Modo LACP
            <select name="mode" defaultValue={selected?.aggregate?.mode ?? 'active'}>
              <option>active</option>
              <option>passive</option>
            </select>
          </label>
        </div>
        <label>
          Mínimo de membros
          <input
            name="minLinks"
            type="number"
            min={1}
            max={8}
            defaultValue={selected?.aggregate?.minLinks ?? 1}
            required
          />
        </label>
        <fieldset>
          <legend>Interfaces físicas do grupo</legend>
          {device.interfaces
            .filter(
              (p) =>
                !p.logical && !p.aggregate && !p.tunnel && !p.vxlan && (!p.channel || p.channel === editing)
            )
            .map((p) => (
              <label className="check-label" key={p.id}>
                <input
                  name="members"
                  type="checkbox"
                  value={p.id}
                  defaultChecked={selected?.aggregate?.members.includes(p.id) ?? false}
                />
                {p.name} · {p.speed} Mbps
              </label>
            ))}
        </fieldset>
        <p className="muted">
          Membros precisam de mesma velocidade, full duplex e stack IP/políticas desocupadas. Configure
          VLAN/trunk ou IPv4 na interface Port-channel pela aba Portas. Para diagnóstico de falha, desligue um
          membro físico e avance.
        </p>
        <button className="button small primary">Aplicar EtherChannel</button>
        {editing && (
          <button className="button small" type="button" onClick={() => setEditing(undefined)}>
            Cancelar edição
          </button>
        )}
      </form>
    </div>
  );
}
