import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function Layer3Panel({ lab, device }: { lab: LabController; device: Device }) {
  return (
    <div className="layer3-panel">
      <p className="muted">
        Subinterfaces transportam VLANs por 802.1Q. SVIs conectam a stack IP à VLAN do switch. VRFs isolam
        rotas e tráfego, inclusive com endereços sobrepostos.
      </p>
      {device.type === 'switch' && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={device.ipRouting ?? false}
            onChange={(event) =>
              lab.change(() => {
                device.ipRouting = event.target.checked;
              })
            }
          />
          Roteamento entre VLANs (ip routing)
        </label>
      )}
      <section>
        <h4>Criar interface {device.type === 'switch' ? 'VLAN (SVI)' : '802.1Q'}</h4>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget);
            lab.change((e) =>
              device.type === 'switch'
                ? e.addSvi(device.id, Number(f.get('vlan')))
                : e.addSubinterface(device.id, String(f.get('parent')), Number(f.get('vlan')))
            );
          }}
        >
          {device.type === 'router' && (
            <label>
              Porta física
              <select name="parent">
                {device.interfaces
                  .filter((p) => !p.logical && !p.tunnel && !p.channel && p.mode === 'routed')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            VLAN da interface
            <input name="vlan" type="number" min={1} max={4094} defaultValue={10} required />
          </label>
          <button className="button small">Criar interface lógica</button>
        </form>
        <p className="muted">
          Na aba Portas, configure o IPv4 e o estado da interface criada. O trunk deve permitir a VLAN
          correspondente.
        </p>
        {device.interfaces
          .filter((p) => p.logical)
          .map((p) => (
            <p key={p.id}>
              {p.name} · VLAN {p.logical!.vlan}{' '}
              <button
                className="button small"
                onClick={() => lab.change((e) => e.removeLogicalInterface(device.id, p.id))}
              >
                Remover {p.name}
              </button>
            </p>
          ))}
      </section>
      <section>
        <h4>Tabelas VRF</h4>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget);
            lab.change((e) => e.configureVrf(device.id, String(f.get('name'))));
          }}
        >
          <label>
            Nome da VRF
            <input name="name" pattern="[a-zA-Z0-9_-]{1,32}" maxLength={32} required placeholder="BLUE" />
          </label>
          <button className="button small">Criar VRF</button>
        </form>
        {(device.vrfs ?? []).map((vrf) => (
          <p key={vrf}>
            {vrf}{' '}
            <button
              className="button small"
              onClick={() => lab.change((e) => e.configureVrf(device.id, vrf, true))}
            >
              Remover VRF {vrf}
            </button>
          </p>
        ))}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Interface</th>
                <th>VLAN / IPv4</th>
                <th>Tabela</th>
              </tr>
            </thead>
            <tbody>
              {device.interfaces
                .filter((p) => p.mode === 'routed')
                .map((port) => (
                  <tr key={port.id}>
                    <td>{port.name}</td>
                    <td>
                      {port.logical?.vlan ?? 'Sem tag'}
                      <br />
                      {port.ip ? `${port.ip}/${port.prefix}` : 'Sem IPv4'}
                    </td>
                    <td>
                      <select
                        aria-label={'VRF de ' + port.name}
                        value={port.vrf ?? ''}
                        onChange={(event) =>
                          lab.change((e) =>
                            e.setInterfaceVrf(device.id, port.id, event.target.value || undefined)
                          )
                        }
                      >
                        <option value="">Padrão</option>
                        {(device.vrfs ?? []).map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          Rotas estáticas por VRF: <code>ip route vrf BLUE CIDR NEXT_HOP</code>. Teste com{' '}
          <code>ping vrf BLUE IPv4</code> ou selecione a VRF no painel TCP. Os protocolos dinâmicos, DHCP e
          NAT ainda usam a tabela padrão.
        </p>
      </section>
    </div>
  );
}
