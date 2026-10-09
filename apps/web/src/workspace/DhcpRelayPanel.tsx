import { useState, type FormEvent } from 'react';
import type { Device, NetworkInterface } from '@shlab/engine';
import type { LabController } from './useLab';

export function DhcpRelayPanel({ lab, device }: { lab: LabController; device: Device }) {
  const ports = device.interfaces.filter(
    (port) =>
      port.ip &&
      port.prefix !== undefined &&
      port.prefix >= 1 &&
      port.prefix <= 30 &&
      port.mode === 'routed' &&
      port.ipv4Mode !== 'dhcp'
  );
  const [portId, setPortId] = useState(ports[0]?.id ?? '');
  const selected = ports.find((port) => port.id === portId) ?? ports[0];
  return (
    <section className="dhcp-relay-panel">
      <h4>Relay DHCP</h4>
      <p className="muted">
        Encaminha Discover e Request em broadcast para até oito servidores. O IPv4 da interface identifica a
        rede do cliente (giaddr).
      </p>
      {!selected ? (
        <p className="table-empty">Configure uma interface IPv4 estática no roteador.</p>
      ) : (
        <>
          <label>
            Interface do relay
            <select value={selected.id} onChange={(event) => setPortId(event.target.value)}>
              {ports.map((port) => (
                <option key={port.id} value={port.id}>
                  {port.name} · {port.ip}/{port.prefix}
                </option>
              ))}
            </select>
          </label>
          <RelayForm
            key={selected.id + ':' + selected.dhcpRelay?.join(',')}
            lab={lab}
            device={device}
            port={selected}
          />
        </>
      )}
    </section>
  );
}

function RelayForm({ lab, device, port }: { lab: LabController; device: Device; port: NetworkInterface }) {
  const [error, setError] = useState('');
  const localPool = device.dhcpServer?.pools.some((pool) => pool.port === port.id && !pool.relayAddress);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    lab.setError('');
    const servers = String(new FormData(event.currentTarget).get('servers') ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    const saved = lab.change((engine) => {
      engine.configureDhcpRelay(device.id, port.id, servers);
      return true;
    });
    if (!saved) setError('Confira os endereços e a configuração da interface.');
  }
  return (
    <form onSubmit={submit}>
      <label>
        Servidores do relay
        <input
          name="servers"
          defaultValue={port.dhcpRelay?.join(', ') ?? ''}
          placeholder="192.168.20.10"
          maxLength={160}
        />
      </label>
      <p className="muted">
        Deixe vazio para desativar.{' '}
        {localPool
          ? 'Remova o pool local desta interface para usar relay.'
          : 'As respostas retornam por roteamento e pelas ACLs configuradas.'}
      </p>
      {(error || lab.error) && (
        <p className="alert error" role="alert">
          {lab.error || error}
        </p>
      )}
      <button className="button small" disabled={localPool}>
        Aplicar relay
      </button>
    </form>
  );
}
