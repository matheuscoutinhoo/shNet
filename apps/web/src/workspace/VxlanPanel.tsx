import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { vxlanConfig, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function VxlanPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [selected, setSelected] = useState(device.interfaces.find((p) => p.vxlan)?.id ?? ''),
    p = device.interfaces.find((p) => p.id === selected && p.vxlan);
  return (
    <div className="vxlan-panel">
      <p className="muted">
        VXLAN encapsula Ethernet por UDP/4789. VLANs locais mapeiam um VNI comum; ARP, IPv4 e IPv6 percorrem o
        underlay configurado. EVPN anuncia MAC/IP pelo BGP simulado e importa somente o route target
        correspondente.
      </p>
      <p className="muted">
        Configure a WAN como routed com IPv4 e rotas de retorno. Para EVPN, habilite roteamento no switch e
        configure vizinhos na aba BGP. A replicação de broadcast usa a lista de peers.
      </p>
      {device.interfaces
        .filter((p) => p.vxlan)
        .map((p) => (
          <section className="subnet-card" key={p.id}>
            <strong>
              {p.name} · VLAN {p.vxlan!.vlan}
            </strong>
            <p>
              VNI {p.vxlan!.vni} · RT {p.vxlan!.routeTarget} ·{' '}
              {p.vxlan!.enabled ? 'habilitado' : 'desabilitado'}
            </p>
            <p>
              TX/RX {p.vxlan!.sent}/{p.vxlan!.received} · MACs de controle {p.vxlan!.routes.length}
            </p>
            <button className="button small" onClick={() => setSelected(p.id)}>
              Editar {p.name}
            </button>
            <button
              className="button small"
              onClick={() => lab.change((e) => e.removeLogicalInterface(device.id, p.id))}
            >
              Excluir {p.name}
            </button>
          </section>
        ))}
      <button className="button small" onClick={() => setSelected('')}>
        Novo VNI
      </button>
      <form
        key={selected + ':' + (p?.vxlan?.routeTarget ?? 'new')}
        onSubmit={(ev) => {
          ev.preventDefault();
          const f = new FormData(ev.currentTarget);
          lab.change((e) => {
            const port = e.configureVxlan(device.id, JSON.parse(String(f.get('config'))));
            setSelected(port.id);
          });
        }}
      >
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Configuração VNI JSON"
          schema={configurationSchemas.vxlan}
          aria-label="Configuração VNI JSON"
          name="config"
          rows={15}
          defaultValue={JSON.stringify(
            p
              ? vxlanConfig(p)
              : {
                  vni: 10010,
                  vlan: 10,
                  enabled: true,
                  underlay: 'p1',
                  peers: ['198.51.100.2'],
                  evpn: true,
                  routeTarget: '65000:10010',
                  mtu: 1450,
                },
            null,
            2
          )}
        />
        <button className="button small" type="submit">
          Aplicar VNI
        </button>
      </form>
      <h4>MAC/IP recebidos por EVPN</h4>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>VNI / MAC</th>
              <th>IP / VTEP</th>
              <th>Peer / Seq</th>
            </tr>
          </thead>
          <tbody>
            {device.interfaces.flatMap(
              (p) =>
                p.vxlan?.routes.map((r) => (
                  <tr key={p.id + ':' + r.peer + ':' + r.mac} data-evpn-mac={r.mac}>
                    <td>
                      {r.vni}
                      <br />
                      {r.mac}
                    </td>
                    <td>
                      {r.ip ?? '—'}
                      <br />
                      {r.nextHop}
                    </td>
                    <td>
                      {r.peer}
                      <br />
                      {r.sequence}
                    </td>
                  </tr>
                )) ?? []
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Modelo limitado a anúncios locais MAC/IP, importação por RT e mobilidade por sequência. Não há
        multihoming/ESI, eleição DF, IMET dinâmico, rotas Type 5, proxy ARP ou codec MP-BGP binário.
      </p>
    </div>
  );
}
