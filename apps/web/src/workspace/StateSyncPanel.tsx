import { useState } from 'react';
import { stateSyncStatus, stateSyncPending, type Device } from '@shlab/engine';
import type { LabController } from './useLab';

export function StateSyncPanel({ lab, device }: { lab: LabController; device: Device }) {
  const peers = lab.engine.state.devices.filter((d) => d.type === 'router' && d.id !== device.id);
  const [peerId, setPeerId] = useState(device.stateSync?.peer ?? peers[0]?.id ?? '');
  const peer = peers.find((d) => d.id === peerId);
  const physical = (d: Device) =>
    d.interfaces.filter(
      (p) =>
        p.mode === 'routed' &&
        !p.logical &&
        !p.loopback &&
        !p.channel &&
        !p.aggregate &&
        !p.vxlan &&
        !p.tunnel &&
        ['rj45', 'sfp', 'qsfp'].includes(p.media)
    );
  const status = stateSyncStatus(lab.engine.state, device);
  const labels = {
    disabled: 'Desativada',
    unavailable: 'Enlace indisponível',
    'policy-mismatch': 'Políticas divergentes',
    ready: 'Enlace disponível',
  };
  return (
    <section className="state-sync-panel">
      <h4>Sincronização HA de firewall/NAT</h4>
      <p className="muted">
        Use um cabo direto entre portas dedicadas. Ambos os roteadores precisam de políticas equivalentes. O
        enlace replica sessões TCP/UDP/ICMP e NAT/PAT; o VRRP continua elegendo o gateway.
      </p>
      <p role="status">
        {labels[status]} · Atualizações pendentes: {stateSyncPending(lab.engine.state, device)}
      </p>
      {device.stateSync && (
        <p className="muted">
          Enviadas: {device.stateSync.sent} · Recebidas: {device.stateSync.received} · Recusadas:{' '}
          {device.stateSync.rejected}
          {device.stateSync.lastReceivedAt !== undefined && (
            <> · Última recepção: {(device.stateSync.lastReceivedAt / 1000).toFixed(2)} s</>
          )}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          lab.change((e) => {
            const mappings = String(data.get('mappings') ?? '')
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((line) => {
                const parts = line.split(/\s+/);
                if (parts.length !== 2)
                  throw new Error('Mapeamento HA: use ID local e ID remoto, um par por linha.');
                return { a: parts[0], b: parts[1] };
              });
            e.configureStateSyncPair(device.id, peerId, {
              portA: data.get('portA'),
              portB: data.get('portB'),
              mappings,
            });
          });
        }}
      >
        <label>
          Peer HA
          <select aria-label="Peer HA" name="peer" value={peerId} onChange={(e) => setPeerId(e.target.value)}>
            {peers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </select>
        </label>
        <label>
          Porta dedicada local
          <select
            aria-label="Porta dedicada local"
            name="portA"
            defaultValue={device.stateSync?.port ?? 'p2'}
          >
            {physical(device).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
        </label>
        <label>
          Porta dedicada do peer
          <select
            aria-label="Porta dedicada do peer"
            key={peerId}
            name="portB"
            defaultValue={peer?.stateSync?.port ?? 'p2'}
          >
            {peer &&
              physical(peer).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
          </select>
        </label>
        <label>
          Mapeamento de interfaces (ID local ID remoto)
          <textarea
            aria-label="Mapeamento de interfaces (ID local ID remoto)"
            name="mappings"
            rows={6}
            key={peerId}
            defaultValue={
              device.stateSync?.peer === peerId
                ? device.stateSync.portMap.map((p) => p.local + ' ' + p.remote).join('\n')
                : device.interfaces
                    .filter(
                      (p) =>
                        p.mode === 'routed' &&
                        !p.loopback &&
                        p.id !== 'p2' &&
                        peer?.interfaces.some((q) => q.id === p.id)
                    )
                    .map((p) => p.id + ' ' + p.id)
                    .join('\n')
            }
          />
        </label>
        <button type="submit" disabled={!peer}>
          Aplicar par HA
        </button>
        {device.stateSync && (
          <button type="button" onClick={() => lab.change((e) => e.disableStateSync(device.id))}>
            Desativar par HA
          </button>
        )}
      </form>
      <p className="muted">
        Enlace disponível não garante que todos os updates chegaram. Perda, atraso ou partição podem
        interromper sessões. O canal é um modelo de estado, sem codec proprietário ou PCAP. Não replica
        inspeção de aplicação, SIP ALG ou hairpin.
      </p>
    </section>
  );
}
