import { useState } from 'react';
import { dhcpHaStatus, type Device } from '@shlab/engine';
import type { LabController } from './useLab';

const statuses = {
  disabled: 'Desativado',
  'configuration-mismatch': 'Configuração ou cabo incompatível',
  'fenced-active': 'Ativo após fencing; sem segunda cópia confirmada',
  unavailable: 'Canal indisponível; respostas suspensas',
  synchronized: 'Réplica confirmada',
  synchronizing: 'Sincronizando',
};
export function DhcpHaPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [selected, setSelected] = useState('');
  const c = device.dhcpHa,
    s = lab.engine.state;
  const peer = s.devices.find((d) => d.id === (c?.peer ?? selected));
  const candidates = s.devices.filter((d) => d.id !== device.id && d.dhcpServer?.pools.length && !d.dhcpHa);
  const direct =
    peer &&
    s.links.find((l) => {
      const local = [l.a, l.b].find((p) => p.device === device.id);
      const remote = [l.a, l.b].find((p) => p.device === peer.id);
      return (
        local &&
        remote &&
        [
          device.interfaces.find((p) => p.id === local.port),
          peer.interfaces.find((p) => p.id === remote.port),
        ].every((p) => p && !p.ip && !p.ipv6 && !p.bond && !p.aggregate && p.media === 'rj45')
      );
    });
  return (
    <section className="protocol-panel dhcp-ha-panel" data-dhcp-ha-role={c?.role ?? 'disabled'}>
      <h4>Disponibilidade DHCP</h4>
      <p className="muted">
        O ativo confirma ofertas e concessões na reserva pelo cabo dedicado. A troca é administrativa e
        desliga o antigo ativo. Não há eleição automática.
      </p>
      {c ? (
        <>
          <p aria-live="polite">
            <strong>{c.role === 'active' ? 'Ativo' : 'Reserva'}</strong> · {statuses[dhcpHaStatus(s, device)]}
          </p>
          <p>
            Par: {peer?.hostname} · revisão local {c.revision} · recebida {c.applied} · confirmada{' '}
            {c.confirmed}
          </p>
          {c.role === 'standby' && (
            <button
              className="button small"
              disabled={!device.power || !device.dhcpServer?.enabled || c.applied !== peer?.dhcpHa?.revision}
              onClick={() => lab.change((e) => e.promoteDhcpHa(device.id))}
            >
              Promover reserva e desligar {peer?.hostname}
            </button>
          )}
          <button className="button small" onClick={() => lab.change((e) => e.disableDhcpHa(device.id))}>
            Remover par DHCP e desativar a reserva
          </button>
        </>
      ) : (
        <>
          <label>
            Servidor reserva
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Selecione um servidor</option>
              {candidates.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            Configure pools com nomes e políticas iguais, deixe a reserva sem concessões e conecte duas NICs
            dedicadas sem IP por cabo direto.
          </p>
          <button
            className="button small"
            disabled={!direct || !peer || !device.dhcpServer?.pools.length}
            onClick={() => {
              if (!direct || !peer) return;
              lab.change((e) =>
                e.configureDhcpHaPair(device.id, peer.id, {
                  portA: [direct.a, direct.b].find((p) => p.device === device.id)!.port,
                  portB: [direct.a, direct.b].find((p) => p.device === peer.id)!.port,
                })
              );
            }}
          >
            Criar par DHCP com este servidor ativo
          </button>
        </>
      )}
      <p className="muted">
        A réplica preserva leases e quarentenas; após a troca, a renovação com o novo servidor ocorre em T2. O
        canal de réplica não é exportado em PCAP.
      </p>
    </section>
  );
}
