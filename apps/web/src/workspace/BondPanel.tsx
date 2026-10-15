import { useState } from 'react';
import { bondActive, interfaceOperational, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function BondPanel({
  lab,
  device,
  onConfigure,
}: {
  lab: LabController;
  device: Device;
  onConfigure: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string>();
  const current = device.interfaces.find((p) => p.id === editing);
  const candidates = device.interfaces.filter(
    (p) =>
      !p.logical &&
      !p.aggregate &&
      !p.bond &&
      !p.loopback &&
      !p.tunnel &&
      !p.vxlan &&
      ['rj45', 'sfp', 'qsfp'].includes(p.media) &&
      (!p.channel || p.channel === editing)
  );
  let number = 1;
  while (device.interfaces.some((p) => p.bond?.number === number)) number++;
  return (
    <section className="protocol-panel bond-panel">
      <p className="muted">
        Bond ativo/backup mantém um endereço e uma NIC ativa entre caminhos por switches diferentes. O monitor
        ARP detecta falha de uplink até o alvo local escolhido. Sem monitor, a seleção verifica apenas o
        carrier da NIC.
      </p>
      <button className="button small" onClick={() => lab.change((e) => e.installNic(device.id))}>
        Instalar NIC Ethernet
      </button>
      {device.interfaces
        .filter((p) => p.installedNic)
        .map((p) => (
          <p key={p.id}>
            {p.name} · NIC adicional{' '}
            <button className="button small" onClick={() => lab.change((e) => e.removeNic(device.id, p.id))}>
              Remover {p.name}
            </button>
          </p>
        ))}
      {device.interfaces
        .filter((p) => p.bond)
        .map((p) => {
          const b = p.bond!,
            active = bondActive(lab.engine.state, device, p);
          return (
            <section className="table-section" key={p.id} data-bond={p.name} data-active={active ?? ''}>
              <h4>
                {p.name} · {active ? 'ativo' : 'sem caminho'}
              </h4>
              <p>{p.ip ? p.ip + '/' + p.prefix : 'Configure IPv4/DHCP em Portas e IPv6 na aba IPv6.'}</p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>NIC</th>
                      <th>Estado</th>
                      <th>Última resposta ARP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.members.map((id) => (
                      <tr key={id}>
                        <td>
                          {device.interfaces.find((m) => m.id === id)?.name}
                          {id === b.primary ? ' · primária' : ''}
                        </td>
                        <td>
                          {!interfaceOperational(
                            lab.engine.state,
                            device,
                            device.interfaces.find((m) => m.id === id)!
                          )
                            ? 'sem link'
                            : b.monitor &&
                                lab.engine.state.clock >=
                                  (b.health.find((h) => h.port === id)?.lastResponseAt ?? b.startedAt) +
                                    b.monitor.timeoutMs
                              ? 'alvo ARP indisponível'
                              : id === active
                                ? 'ativa'
                                : 'reserva'}
                        </td>
                        <td>{b.health.find((h) => h.port === id)?.lastResponseAt?.toFixed(1) ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="lacp-actions">
                <button className="button small" onClick={() => onConfigure(p.id)}>
                  Configurar IPv4
                </button>
                <button className="button small" onClick={() => setEditing(p.id)}>
                  Editar {p.name}
                </button>
                <button
                  className="button small"
                  onClick={() => lab.change((e) => e.removeBond(device.id, p.id))}
                >
                  Dissolver {p.name}
                </button>
              </div>
            </section>
          );
        })}
      <form
        key={editing ?? 'new'}
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget),
            target = String(f.get('target') ?? '').trim();
          const result = lab.change((e) =>
            e.configureBond(
              device.id,
              Number(f.get('number')),
              f.getAll('members').map(String),
              String(f.get('primary')),
              target
                ? { target, intervalMs: Number(f.get('interval')), timeoutMs: Number(f.get('timeout')) }
                : undefined
            )
          );
          if (result) setEditing(undefined);
        }}
      >
        <h4>{editing ? 'Editar bond' : 'Criar bond'}</h4>
        <div className="form-grid">
          <label>
            Número do bond
            <input
              name="number"
              type="number"
              min={1}
              max={64}
              defaultValue={current?.bond?.number ?? number}
              required
            />
          </label>
          <label>
            NIC primária
            <select name="primary" defaultValue={current?.bond?.primary ?? candidates[0]?.id}>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset>
          <legend>NICs participantes</legend>
          {candidates.map((p) => (
            <label className="check-label" key={p.id}>
              <input
                type="checkbox"
                name="members"
                value={p.id}
                defaultChecked={current?.bond?.members.includes(p.id) ?? false}
              />
              {p.name} · {p.speed} Mbps
            </label>
          ))}
        </fieldset>
        <label>
          Alvo ARP no domínio local (opcional)
          <input
            name="target"
            placeholder="192.168.10.1"
            defaultValue={current?.bond?.monitor?.target ?? device.gateway ?? ''}
          />
        </label>
        <div className="form-grid">
          <label>
            Intervalo ARP (ms)
            <input
              type="number"
              name="interval"
              min={100}
              max={10000}
              defaultValue={current?.bond?.monitor?.intervalMs ?? 1000}
            />
          </label>
          <label>
            Timeout ARP (ms)
            <input
              type="number"
              name="timeout"
              min={300}
              max={30000}
              defaultValue={current?.bond?.monitor?.timeoutMs ?? 3000}
            />
          </label>
        </div>
        <p className="muted">
          Selecione de duas a oito NICs. O IPv4 estático da primária é movido para o bond. Configure DHCP e
          IPv6 na interface do bond; as NICs participantes ficam sem endereços próprios. O timeout deve cobrir
          pelo menos três sondagens.
        </p>
        <button className="button small primary" disabled={candidates.length < 2}>
          Aplicar bond
        </button>
        {editing && (
          <button type="button" className="button small" onClick={() => setEditing(undefined)}>
            Cancelar edição
          </button>
        )}
      </form>
    </section>
  );
}
