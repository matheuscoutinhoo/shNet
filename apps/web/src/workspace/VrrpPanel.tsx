import { Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { vrrpConfigGroups, vrrpMac, type Device, type VrrpGroupConfig } from '@shlab/engine';
import type { LabController } from './useLab';

export function VrrpPanel({ lab, device }: { lab: LabController; device: Device }) {
  const state = device.vrrp;
  const [editing, setEditing] = useState<VrrpGroupConfig | null>(null);
  const update = (groups: VrrpGroupConfig[], enabled = state?.enabled ?? true) =>
    lab.change(() => lab.engine.configureVrrp(device.id, { enabled, groups }));
  return (
    <div className="protocol-panel vrrp-panel">
      <div className="learning-card">
        <strong>Gateway com redundância</strong>
        <p>
          Roteadores na mesma LAN anunciam prioridade por VRRPv3. O ACTIVE responde pelo IP e MAC virtual; o
          BACKUP assume após três intervalos e o tempo de desempate. Avance a simulação após uma falha. O VIP
          serve como gateway; serviços locais só respondem no dono do endereço (prioridade 255). Sessões NAT e
          firewall não são sincronizadas.
        </p>
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          checked={state?.enabled ?? false}
          onChange={(event) => update(vrrpConfigGroups(device), event.target.checked)}
        />{' '}
        Ativar VRRP
      </label>
      <section className="table-section">
        <h4>Grupos VRRP</h4>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Grupo / VIP</th>
                <th>Estado</th>
                <th>Ativo / timer</th>
              </tr>
            </thead>
            <tbody>
              {state?.groups.map((group) => (
                <tr key={group.port + ':' + group.vrid} data-state={group.state}>
                  <td>
                    {device.interfaces.find((port) => port.id === group.port)?.name} · VRID {group.vrid}
                    <br />
                    {group.vip}
                    <br />
                    <small>
                      {vrrpMac(group.vrid)}
                      <br />
                      Prioridade {group.priority} / efetiva {group.effectivePriority ?? group.priority} ·{' '}
                      {group.advertMs} ms · preempt {group.preempt ? 'on' : 'off'}
                      <br />
                      TX/RX {group.sent}/{group.received}
                    </small>
                    <div className="vrrp-actions">
                      <button
                        className="button small"
                        onClick={() =>
                          setEditing(
                            vrrpConfigGroups(device).find(
                              (entry) => entry.port === group.port && entry.vrid === group.vrid
                            )!
                          )
                        }
                        aria-label={'Editar VRID ' + group.vrid}
                      >
                        Editar
                      </button>
                      <button
                        className="icon-button"
                        aria-label={'Remover VRID ' + group.vrid}
                        onClick={() =>
                          update(
                            vrrpConfigGroups(device).filter(
                              (entry) => entry.port !== group.port || entry.vrid !== group.vrid
                            )
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                  <td>{group.state}</td>
                  <td>
                    {group.state === 'ACTIVE' ? 'Local' : (group.activeIp ?? '—')}
                    <br />
                    <small>
                      {group.state === 'INIT'
                        ? 'Sem timer'
                        : Math.max(
                            0,
                            ((group.downAt ?? group.advertAt!) - lab.engine.state.clock) / 1000
                          ).toFixed(3) + ' s'}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!state?.groups.length && <p className="muted">Nenhum grupo configurado.</p>}
      </section>
      <form
        key={editing ? editing.port + ':' + editing.vrid : 'new'}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const group = {
            port: String(form.get('port')),
            vrid: Number(form.get('vrid')),
            vip: String(form.get('vip')),
            priority: Number(form.get('priority')),
            advertMs: Number(form.get('advertMs')),
            preempt: form.has('preempt'),
          };
          if (
            lab.change(() => {
              const track = String(form.get('track') ?? '')
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => {
                  const parts = line.trim().split(/\s+/);
                  if (parts.length !== 3 || !['interface', 'route'].includes(parts[0]))
                    throw new Error('Tracking: interface NOME DECREMENTO ou route IPv4 DECREMENTO.');
                  const port = device.interfaces.find((p) => p.name.toLowerCase() === parts[1].toLowerCase());
                  if (parts[0] === 'interface' && !port)
                    throw new Error('Interface de tracking inexistente.');
                  return {
                    ...(parts[0] === 'interface' ? { port: port!.id } : { route: parts[1] }),
                    decrement: Number(parts[2]),
                  };
                });
              lab.engine.configureVrrp(device.id, {
                enabled: state?.enabled ?? true,
                groups: [
                  ...vrrpConfigGroups(device).filter((entry) =>
                    editing
                      ? entry.port !== editing.port || entry.vrid !== editing.vrid
                      : entry.port !== group.port || entry.vrid !== group.vrid
                  ),
                  { ...group, ...(track.length ? { track } : {}) },
                ],
              });
              return true;
            })
          )
            setEditing(null);
        }}
      >
        <h4>{editing ? 'Editar grupo' : 'Adicionar grupo'}</h4>
        <label>
          Interface VRRP
          <select name="port" defaultValue={editing?.port}>
            {device.interfaces
              .filter((port) => port.mode === 'routed')
              .map((port) => (
                <option value={port.id} key={port.id}>
                  {port.name} · {port.ip ?? 'Sem IPv4'}
                </option>
              ))}
          </select>
        </label>
        <div className="form-grid">
          <label>
            VRID
            <input name="vrid" type="number" required min="1" max="255" defaultValue={editing?.vrid ?? 1} />
          </label>
          <label>
            Prioridade VRRP
            <input
              name="priority"
              type="number"
              required
              min="1"
              max="255"
              defaultValue={editing?.priority ?? 100}
            />
          </label>
        </div>
        <label>
          IP virtual
          <input name="vip" required placeholder="192.168.10.1" defaultValue={editing?.vip} />
        </label>
        <label>
          Intervalo VRRP (ms)
          <input
            name="advertMs"
            type="number"
            required
            min="100"
            max="10000"
            step="10"
            defaultValue={editing?.advertMs ?? 1000}
          />
        </label>
        <label className="check-label">
          <input name="preempt" type="checkbox" defaultChecked={editing?.preempt ?? true} /> Preempt (retomar
          com prioridade maior)
        </label>
        <label>
          Tracking VRRP
          <textarea
            name="track"
            placeholder="interface Gi0/2 80"
            defaultValue={(editing?.track ?? [])
              .map(
                (t) =>
                  `${t.port ? 'interface ' + device.interfaces.find((p) => p.id === t.port)!.name : 'route ' + t.route} ${t.decrement}`
              )
              .join('\n')}
          />
        </label>
        <p className="muted">
          Uma linha por objeto: interface NOME DECREMENTO ou route IPv4 DECREMENTO. A perda do carrier/rota
          reduz a prioridade; a recuperação permite preempt. Tracking de rota verifica a FIB e o próximo
          enlace.
        </p>
        <p className="muted">VIP na sub-rede da interface. Prioridade 255 apenas quando VIP = IPv4 físico.</p>
        <button className="button small primary">
          <Save size={14} /> Aplicar grupo VRRP
        </button>
        {editing && (
          <button type="button" className="button small" onClick={() => setEditing(null)}>
            Cancelar edição
          </button>
        )}
      </form>
    </div>
  );
}
