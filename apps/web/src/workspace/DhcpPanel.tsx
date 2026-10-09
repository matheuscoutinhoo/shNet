import { useState, type FormEvent } from 'react';
import { Plus, Pencil, RefreshCw, Trash2, Unplug } from 'lucide-react';
import {
  defaultDhcpPool,
  dhcpPoolSchema,
  dhcpPoolStats,
  type Device,
  type DhcpClient,
  type DhcpPool,
} from '@shlab/engine';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';
import { DhcpRelayPanel } from './DhcpRelayPanel';
import { DhcpProtectionPanel } from './DhcpProtectionPanel';

const clientStates: Record<DhcpClient['status'] | 'static', string> = {
  static: 'Estático',
  selecting: 'Buscando servidor',
  requesting: 'Solicitando endereço',
  probing: 'Verificando conflitos por ARP',
  bound: 'Concessão ativa',
  renewing: 'Renovando (T1)',
  rebinding: 'Rebinding (T2)',
  released: 'Liberado',
  expired: 'Expirado',
  failed: 'Sem concessão',
};

export function DhcpPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [editing, setEditing] = useState<DhcpPool | null>(null);
  const server = device.dhcpServer;
  const serverCapable = device.type === 'server' || device.type === 'router';
  const eligible = device.interfaces.filter(
    (port) =>
      port.ip &&
      port.prefix !== undefined &&
      port.prefix >= 1 &&
      port.prefix <= 30 &&
      port.ipv4Mode !== 'dhcp' &&
      !port.dhcpRelay?.length
  );
  const clock = lab.engine.state.clock;
  return (
    <div className="dhcp-panel">
      <DhcpProtectionPanel key={device.id} lab={lab} device={device} />
      {device.type === 'router' && <DhcpRelayPanel lab={lab} device={device} />}
      {serverCapable && (
        <>
          <div className="mode-switch">
            <span>Serviço DHCP</span>
            <button
              type="button"
              role="switch"
              aria-label="Serviço DHCP"
              aria-checked={server?.enabled ?? false}
              className={'switch ' + (server?.enabled ? 'on' : '')}
              onClick={() => lab.change((engine) => engine.setDhcpEnabled(device.id, !server?.enabled))}
            >
              <i />
            </button>
          </div>
          <div className="dhcp-heading">
            <h4>Pools IPv4</h4>
            <button
              className="button small"
              disabled={!eligible.length}
              title={eligible.length ? 'Criar pool DHCP' : 'Configure uma interface IPv4 estática'}
              onClick={() => {
                const names = new Set(server?.pools.map((pool) => pool.name));
                let index = 1;
                while (names.has('POOL-' + index)) index++;
                setEditing(defaultDhcpPool(device, 'POOL-' + index, eligible[0].id));
              }}
            >
              <Plus size={14} /> Novo pool
            </button>
          </div>
          {!server?.pools.length && <p className="muted">Nenhum pool configurado.</p>}
          {server?.pools.map((pool) => {
            const stats = dhcpPoolStats(device, pool, clock);
            return (
              <section className="dhcp-pool" key={pool.name}>
                <div className="dhcp-heading">
                  <strong>{pool.name}</strong>
                  <div className="button-row">
                    <button
                      className="icon-button"
                      aria-label={'Editar pool ' + pool.name}
                      title="Editar pool"
                      onClick={() => setEditing(structuredClone(pool))}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={'Excluir pool ' + pool.name}
                      title="Excluir pool"
                      onClick={() => lab.change((engine) => engine.removeDhcpPool(device.id, pool.name))}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                <dl className="key-values">
                  <div>
                    <dt>Rede / interface</dt>
                    <dd>
                      {pool.network}/{pool.prefix} ·{' '}
                      {device.interfaces.find((port) => port.id === pool.port)?.name}
                      {pool.relayAddress && (
                        <>
                          <br />
                          <small>Remoto · giaddr {pool.relayAddress}</small>
                        </>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Intervalo</dt>
                    <dd>
                      {pool.start}
                      <br />
                      {pool.end}
                    </dd>
                  </div>
                  <div>
                    <dt>Lease</dt>
                    <dd>{pool.leaseMs / 1000} s</dd>
                  </div>
                  <div>
                    <dt>Livres para outros / capacidade</dt>
                    <dd>
                      {stats.available} / {stats.capacity}
                    </dd>
                  </div>
                  <div>
                    <dt>Reservas por MAC</dt>
                    <dd>{stats.reserved}</dd>
                  </div>
                  <div>
                    <dt>Ofertas / concessões</dt>
                    <dd>
                      {stats.offered} / {stats.bound}
                    </dd>
                  </div>
                </dl>
                {!!pool.reservations?.length && (
                  <div className="table-scroll">
                    <table aria-label={'Reservas ' + pool.name}>
                      <thead>
                        <tr>
                          <th>MAC do cliente</th>
                          <th>IPv4 reservado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pool.reservations.map((reservation) => (
                          <tr key={reservation.clientMac}>
                            <td>{reservation.clientMac}</td>
                            <td>{reservation.address}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
          <section className="table-section dhcp-bindings">
            <h4>
              Concessões <span>{server?.bindings.length ?? 0}</span>
            </h4>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>IPv4 / cliente</th>
                    <th>Estado</th>
                    <th>Restante</th>
                  </tr>
                </thead>
                <tbody>
                  {server?.bindings.map((binding) => (
                    <tr key={binding.id}>
                      <td>
                        {binding.address}
                        <br />
                        <small>{binding.clientMac}</small>
                      </td>
                      <td>{binding.status === 'bound' ? 'Ativa' : 'Oferta'}</td>
                      <td>{Math.max(0, (binding.expiresAt - clock) / 1000).toFixed(1)} s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!server?.bindings.length && <p className="table-empty">Nenhuma concessão.</p>}
          </section>
        </>
      )}
      {device.interfaces
        .filter((port) => !port.dhcpRelay?.length && !server?.pools.some((pool) => pool.port === port.id))
        .map((port) => {
          const client = port.dhcp;
          const lease = client?.lease;
          return (
            <section
              className="dhcp-client"
              key={port.id}
              aria-label={'DHCP ' + port.name}
              data-state={client?.status ?? 'static'}
            >
              <div className="dhcp-heading">
                <h4>{port.name}</h4>
                <span role="status">{clientStates[client?.status ?? 'static']}</span>
              </div>
              <dl className="key-values">
                <div>
                  <dt>IPv4</dt>
                  <dd>{port.ip ? port.ip + '/' + port.prefix : 'Não atribuído'}</dd>
                </div>
                <div>
                  <dt>Servidor</dt>
                  <dd>{lease?.server ?? '-'}</dd>
                </div>
                <div>
                  <dt>Gateway</dt>
                  <dd>{port.gateway ?? '-'}</dd>
                </div>
                <div>
                  <dt>DNS</dt>
                  <dd>{port.dns?.join(', ') || '-'}</dd>
                </div>
                {lease && (
                  <>
                    <div>
                      <dt>T1 / T2</dt>
                      <dd>
                        {Math.max(0, (lease.renewAt - clock) / 1000).toFixed(1)} s /{' '}
                        {Math.max(0, (lease.rebindAt - clock) / 1000).toFixed(1)} s
                      </dd>
                    </div>
                    <div>
                      <dt>Expira em</dt>
                      <dd>{Math.max(0, (lease.expiresAt - clock) / 1000).toFixed(1)} s virtuais</dd>
                    </div>
                  </>
                )}
              </dl>
              <div className="button-row">
                <button
                  className="button small"
                  aria-label={'Renovar DHCP ' + port.name}
                  disabled={!device.power || !port.adminUp}
                  onClick={() => lab.change((engine) => engine.renewDhcp(device.id, port.id))}
                >
                  <RefreshCw size={14} /> {lease ? 'Renovar' : 'Solicitar endereço'}
                </button>
                <button
                  className="button small"
                  aria-label={'Liberar DHCP ' + port.name}
                  disabled={!client || client.status === 'released'}
                  onClick={() => lab.change((engine) => engine.releaseDhcp(device.id, port.id))}
                >
                  <Unplug size={14} /> Liberar
                </button>
              </div>
            </section>
          );
        })}
      {editing && <PoolEditor lab={lab} device={device} initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PoolEditor({
  lab,
  device,
  initial,
  onClose,
}: {
  lab: LabController;
  device: Device;
  initial: DhcpPool;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [remote, setRemote] = useState(!!initial.relayAddress);
  const [error, setError] = useState('');
  const existing = device.dhcpServer?.pools.some((pool) => pool.name === initial.name);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    lab.setError('');
    const data = new FormData(event.currentTarget);
    try {
      const pool = dhcpPoolSchema.parse({
        ...draft,
        relayAddress: remote ? String(data.get('relayAddress') ?? '').trim() : undefined,
        reservations: String(data.get('reservations') ?? '')
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => {
            const parts = line.trim().split(/[\s,]+/);
            if (parts.length !== 2) throw new Error('Use uma reserva por linha: MAC IPv4.');
            return { clientMac: parts[0], address: parts[1] };
          }),
        gateway: String(data.get('gateway') ?? '').trim() || undefined,
        dns: String(data.get('dns') ?? '')
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean),
        excluded: String(data.get('excluded') ?? '')
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean),
      });
      const saved = lab.change((engine) => {
        engine.configureDhcpPool(device.id, pool);
        return true;
      });
      if (saved) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pool inválido.');
    }
  }
  return (
    <Modal title={existing ? 'Editar pool DHCP' : 'Novo pool DHCP'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>
            Nome do pool
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              readOnly={existing}
              maxLength={32}
              required
            />
          </label>
          <label>
            Interface do pool
            <select
              value={draft.port}
              onChange={(event) =>
                setDraft(
                  remote
                    ? { ...draft, port: event.target.value }
                    : defaultDhcpPool(device, draft.name, event.target.value)
                )
              }
            >
              {device.interfaces
                .filter(
                  (port) =>
                    port.ip &&
                    port.prefix !== undefined &&
                    port.prefix >= 1 &&
                    port.prefix <= 30 &&
                    port.ipv4Mode !== 'dhcp'
                )
                .map((port) => (
                  <option key={port.id} value={port.id}>
                    {port.name} · {port.ip}/{port.prefix}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label>
          Tipo de pool
          <select
            value={remote ? 'remote' : 'local'}
            onChange={(event) => setRemote(event.target.value === 'remote')}
          >
            <option value="local">Local · rede da interface</option>
            <option value="remote">Remoto · rede atendida por relay</option>
          </select>
        </label>
        {remote && (
          <label>
            IPv4 do relay (giaddr)
            <input
              name="relayAddress"
              defaultValue={draft.relayAddress ?? ''}
              placeholder="192.168.10.1"
              required
            />
          </label>
        )}
        <div className="form-grid">
          <label>
            Rede do pool
            <input
              value={draft.network}
              onChange={(event) => setDraft({ ...draft, network: event.target.value })}
              required
            />
          </label>
          <label>
            Prefixo do pool
            <input
              type="number"
              min="1"
              max="30"
              value={draft.prefix}
              onChange={(event) => setDraft({ ...draft, prefix: Number(event.target.value) })}
              required
            />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Início do intervalo
            <input
              value={draft.start}
              onChange={(event) => setDraft({ ...draft, start: event.target.value })}
              required
            />
          </label>
          <label>
            Fim do intervalo
            <input
              value={draft.end}
              onChange={(event) => setDraft({ ...draft, end: event.target.value })}
              required
            />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Gateway do pool
            <input
              name="gateway"
              defaultValue={draft.gateway ?? ''}
              key={'gateway-' + draft.port}
              placeholder="Opcional"
            />
          </label>
          <label>
            Lease (segundos)
            <input
              type="number"
              min="8"
              max="604800"
              value={draft.leaseMs / 1000}
              onChange={(event) => setDraft({ ...draft, leaseMs: Number(event.target.value) * 1000 })}
              required
            />
          </label>
        </div>
        <label>
          Servidores DNS
          <input
            name="dns"
            defaultValue={draft.dns.join(', ')}
            key={'dns-' + draft.port}
            placeholder="Opcional"
          />
        </label>
        <label>
          Endereços excluídos
          <input
            name="excluded"
            defaultValue={draft.excluded.join(', ')}
            key={'excluded-' + draft.port}
            placeholder="192.168.50.11, 192.168.50.12"
          />
        </label>
        <label>
          Reservas por MAC
          <textarea
            name="reservations"
            aria-label="Reservas por MAC"
            rows={4}
            maxLength={7000}
            defaultValue={
              draft.reservations?.map((entry) => entry.clientMac + ' ' + entry.address).join('\n') ?? ''
            }
            placeholder="02:00:00:01:00:00 192.168.10.60"
          />
        </label>
        <p className="muted">
          Uma reserva por linha: MAC IPv4. O endereço deve estar no intervalo e fica disponível apenas para
          esse MAC. Reservas também possuem lease e expiram.
        </p>
        {(error || lab.error) && (
          <div className="alert error" role="alert">
            {error || lab.error}
          </div>
        )}
        <button className="button primary">Salvar pool</button>
      </form>
    </Modal>
  );
}
