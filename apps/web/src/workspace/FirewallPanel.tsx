import { InspectionPanel } from './InspectionPanel';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
import { FirewallForm } from './FirewallForm';

export function FirewallPanel({ lab, device }: { lab: LabController; device: Device }) {
  return (
    <section className="firewall-panel">
      <h4>Firewall de trânsito</h4>
      <p className="muted">
        Controla TCP, UDP e ping entre interfaces ou zonas, com retorno e erros ICMP relacionados às sessões.
        ACLs continuam sendo aplicadas. Alterar a política limpa as sessões.
      </p>
      <FirewallForm
        key={JSON.stringify([
          device.id,
          device.firewall?.enabled,
          device.firewall?.trustedPorts,
          device.firewall?.protocols,
          device.firewall?.zonePolicy,
        ])}
        lab={lab}
        device={device}
      />
      <InspectionPanel lab={lab} device={device} />
      <p className="muted">
        Descartes: {device.firewall?.dropped ?? 0} · Sessões: {device.firewall?.sessions.length ?? 0}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Cliente → servidor</th>
              {device.firewall?.zonePolicy && <th>Zonas</th>}
              <th>Protocolo</th>
              <th>Estado</th>
              <th>Expira</th>
            </tr>
          </thead>
          <tbody>
            {device.firewall?.sessions.map((session) => (
              <tr key={session.id}>
                <td>
                  {session.clientIp}
                  {session.protocol !== 'ICMP' && ':' + session.clientPort}
                  <br />
                  {session.serverIp}
                  {session.protocol !== 'ICMP' && ':' + session.serverPort}
                  {session.protocol === 'ICMP' && (
                    <>
                      <br />
                      ID: {session.probeId}
                    </>
                  )}
                </td>
                {device.firewall?.zonePolicy && (
                  <td>
                    {
                      device.firewall.zonePolicy.zones.find((zone) => zone.ports.includes(session.inside))
                        ?.name
                    }{' '}
                    →{' '}
                    {
                      device.firewall.zonePolicy.zones.find((zone) => zone.ports.includes(session.outside))
                        ?.name
                    }
                  </td>
                )}
                <td>{session.protocol}</td>
                <td>{session.state}</td>
                <td>{Math.ceil((session.expiresAt - lab.engine.state.clock) / 1000)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
