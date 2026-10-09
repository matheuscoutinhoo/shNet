import { useState } from 'react';
import { Network, Route, Server, Cable, AlertTriangle, Layers, Play } from 'lucide-react';
import {
  packetPath,
  networkAnalysis,
  analysisViews,
  deviceProfile,
  traceNetworkPath,
  resolveDefaultRoutes,
  subnet,
  interfaceOperational,
  ripRoutes,
} from '@shlab/engine';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';

export function NetworkInspector({
  lab,
  onClose,
  onInspect,
}: {
  lab: LabController;
  onClose: () => void;
  onInspect: (id: string) => void;
}) {
  const [tab, setTab] = useState('devices');
  const [probeId, setProbeId] = useState<string>();
  const state = lab.engine.state;
  const hosts = state.devices.filter(
    (device) => (device.type !== 'switch' || device.ipRouting) && device.interfaces.some((port) => port.ip)
  );
  let headers: string[] = [];
  const rows: Array<{ device: string; values: string[] }> = [];
  if (tab === 'devices') {
    headers = ['Equipamento', 'Tipo', 'Energia', 'Interfaces', 'RX / TX'];
    for (const device of state.devices)
      rows.push({
        device: device.id,
        values: [
          device.hostname,
          deviceProfile(device)?.name ?? device.type,
          device.power ? 'On' : 'Off',
          String(device.interfaces.length),
          device.interfaces.reduce((total, port) => total + port.rx, 0) +
            ' / ' +
            device.interfaces.reduce((total, port) => total + port.tx, 0),
        ],
      });
  } else if (tab === 'interfaces') {
    headers = ['Equipamento', 'Porta', 'IPv4', 'Link', 'Modo', 'MTU'];
    for (const device of state.devices)
      for (const port of device.interfaces) {
        rows.push({
          device: device.id,
          values: [
            device.hostname,
            port.name,
            port.ip ? port.ip + '/' + port.prefix : '-',
            !port.adminUp ? 'shutdown' : interfaceOperational(state, device, port) ? 'up' : 'down',
            port.mode,
            String(port.mtu),
          ],
        });
      }
  } else if (tab === 'vlans') {
    headers = ['Switch', 'VLAN', 'Nome', 'Access', 'Trunks'];
    for (const device of state.devices.filter((entry) => entry.type === 'switch'))
      for (const vlan of device.vlans)
        rows.push({
          device: device.id,
          values: [
            device.hostname,
            String(vlan.id),
            vlan.name,
            device.interfaces
              .filter((port) => port.mode === 'access' && port.accessVlan === vlan.id)
              .map((port) => port.name)
              .join(', '),
            device.interfaces
              .filter((port) => port.mode === 'trunk' && port.allowedVlans.includes(vlan.id))
              .map((port) => port.name)
              .join(', '),
          ],
        });
  } else if (tab === 'routes') {
    headers = ['Equipamento', 'Origem', 'Rede', 'Próximo salto'];
    for (const device of state.devices) {
      for (const port of device.interfaces.filter((entry) => entry.ip && entry.adminUp))
        rows.push({
          device: device.id,
          values: [
            device.hostname,
            'Connected',
            subnet(port.ip!, port.prefix!).network + '/' + port.prefix,
            port.name + (port.vrf ? ' · VRF ' + port.vrf : ''),
          ],
        });
      for (const route of device.routes)
        rows.push({
          device: device.id,
          values: [
            device.hostname,
            'Static',
            route.network + '/' + route.prefix,
            route.nextHop + (route.vrf ? ' · VRF ' + route.vrf : ''),
          ],
        });
      for (const route of device.ospf?.routes ?? [])
        rows.push({
          device: device.id,
          values: [
            device.hostname,
            route.pathType === 'inter' ? 'OSPF IA' : 'OSPF',
            `${route.network}/${route.prefix}`,
            `${route.nextHop} [110/${route.metric}]`,
          ],
        });
      for (const route of ripRoutes(device))
        rows.push({
          device: device.id,
          values: [
            device.hostname,
            'RIP',
            `${route.network}/${route.prefix}`,
            `${route.nextHop} [120/${route.metric}]`,
          ],
        });
      for (const route of device.bgp?.routes ?? [])
        rows.push({
          device: device.id,
          values: [
            device.hostname,
            'BGP',
            `${route.network}/${route.prefix}`,
            `${route.nextHop} [${route.distance}/${route.metric}]`,
          ],
        });
      for (const route of resolveDefaultRoutes(device))
        rows.push({
          device: device.id,
          values: [
            device.hostname,
            route.port.ipv4Mode === 'dhcp' ? 'DHCP' : 'Default',
            '0.0.0.0/0',
            route.nextHop,
          ],
        });
    }
  } else if (tab === 'errors') {
    headers = ['Equipamento', 'Evento', 'Motivo'];
    for (const event of state.events
      .filter((entry) => /DROPPED|TIMEOUT|FAILED|EXHAUSTED|ACL_DENY/.test(entry.type))
      .slice(-100)
      .reverse())
      rows.push({
        device: event.device,
        values: [
          state.devices.find((device) => device.id === event.device)?.hostname ?? event.device,
          event.type,
          event.reason,
        ],
      });
  }
  if (analysisViews.some((v) => v.id === tab)) {
    headers = ['Equipamento', 'Recurso', 'Estado', 'Detalhes'];
    rows.push(...networkAnalysis(state, tab));
  }
  const probe = state.probes.find((entry) => entry.id === probeId);
  const path = probeId ? packetPath(state, probeId) : [];
  return (
    <Modal title="Inspetor da rede" wide onClose={onClose}>
      {tab === 'dependencies' && (
        <p className="muted">
          Referências da configuração a IPs do cenário. Presença e energia não comprovam rota, ACL ou serviço;
          valide com tráfego.
        </p>
      )}
      <div className="account-tabs" role="tablist" aria-label="Visões da rede">
        {[
          ...analysisViews.map((v) => ({ ...v, icon: Layers })),
          { id: 'devices', label: 'Equipamentos', icon: Server },
          { id: 'interfaces', label: 'Interfaces', icon: Cable },
          { id: 'vlans', label: 'VLANs', icon: Layers },
          { id: 'routes', label: 'Rotas', icon: Route },
          { id: 'errors', label: 'Erros', icon: AlertTriangle },
          { id: 'path', label: 'Caminho', icon: Network },
        ].map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'path' ? (
        <>
          <form
            className="path-form"
            onSubmit={(event) => {
              event.preventDefault();
              lab.setError('');
              lab.setPlaying(false);
              const data = new FormData(event.currentTarget);
              const id = lab.change((engine) =>
                traceNetworkPath(engine, String(data.get('source')), String(data.get('target')))
              );
              if (id) setProbeId(id);
            }}
          >
            <label>
              Origem do caminho
              <select name="source">
                {hosts.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.hostname}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Destino do caminho
              <select name="target" defaultValue={hosts.at(-1)?.id}>
                {hosts.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.hostname}
                  </option>
                ))}
              </select>
            </label>
            <button className="button primary" disabled={hosts.length < 2}>
              <Play size={16} /> Traçar caminho
            </button>
          </form>
          {probe && (
            <div className="path-result" role="status">
              {probe.status} · RTT {probe.rtt?.toFixed(3) ?? '-'} ms · {path.length} transmissões
            </div>
          )}
          <div className="table-scroll network-table">
            <table>
              <thead>
                <tr>
                  <th>Tempo</th>
                  <th>De / interface</th>
                  <th>Para</th>
                  <th>IPv4</th>
                  <th>MAC destino</th>
                  <th>Tag VLAN / TTL</th>
                </tr>
              </thead>
              <tbody>
                {path.map((hop) => (
                  <tr className="path-hop" key={hop.id}>
                    <td>{hop.time.toFixed(3)}</td>
                    <td>
                      {hop.hostname}
                      <br />
                      {hop.port}
                    </td>
                    <td>
                      {hop.peer}
                      <br />
                      <small>{hop.kind}</small>
                    </td>
                    <td>
                      {hop.src}
                      <br />
                      {hop.dst}
                    </td>
                    <td>{hop.destinationMac}</td>
                    <td>
                      {hop.vlan ?? 'untagged'} / {hop.ttl}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="table-scroll network-table">
          <table>
            <thead>
              <tr>
                {headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.values.map((value, column) => (
                    <td key={column}>{value || '-'}</td>
                  ))}
                  <td>
                    <button
                      className="icon-button"
                      aria-label={'Inspecionar ' + row.values[0]}
                      title="Inspecionar equipamento"
                      onClick={() => {
                        onInspect(row.device);
                        onClose();
                      }}
                    >
                      <Network size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lab.error && (
        <div className="alert error" role="alert">
          {lab.error}
        </div>
      )}
    </Modal>
  );
}
