import { Save } from 'lucide-react';
import { bgpNeighborSchema, bgpFilterSchema, type BgpNeighbor, type Device } from '@shlab/engine';
import type { LabController } from './useLab';

function cidr(text: string) {
  const match = /^([\d.]+)\/(\d+)$/.exec(text);
  if (!match) throw new Error('Rede BGP deve usar NETWORK/PREFIX.');
  return { network: match[1], prefix: Number(match[2]) };
}
function neighbors(text: string): BgpNeighbor[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [ip, asn, ...flags] = line.trim().split(/\s+/);
      const value = bgpNeighborSchema.parse({ ip, remoteAs: Number(asn) });
      for (const flag of flags) {
        if (flag === 'passive') value.passive = true;
        else if (flag === 'next-hop-self') value.nextHopSelf = true;
        else if (flag === 'rr-client') value.reflectorClient = true;
        else {
          const match = /^(local-pref|med|prepend)=(\d+)$/.exec(flag);
          if (!match) throw new Error('Opção de vizinho BGP inválida: ' + flag);
          const field = { 'local-pref': 'localPref', med: 'med', prepend: 'prepend' } as const;
          value[field[match[1] as keyof typeof field]] = Number(match[2]);
        }
      }
      return value;
    });
}
function filters(peers: BgpNeighbor[], text: string) {
  for (const line of text.split('\n').filter((line) => line.trim())) {
    const match = /^([\d.]+) (in|out) (\d+) (permit|deny) ([\d./]+)(?: ge (\d+))?(?: le (\d+))?$/.exec(
      line.trim()
    );
    if (!match) throw new Error('Filtro: IP in|out SEQ permit|deny CIDR [ge N] [le N].');
    const peer = peers.find((peer) => peer.ip === match[1]);
    if (!peer) throw new Error('Filtro exige vizinho configurado.');
    peer[match[2] === 'in' ? 'importFilter' : 'exportFilter'].push(
      bgpFilterSchema.parse({
        ...cidr(match[5]),
        sequence: Number(match[3]),
        action: match[4],
        ...(match[6] ? { minPrefix: Number(match[6]) } : {}),
        ...(match[7] ? { maxPrefix: Number(match[7]) } : {}),
      })
    );
  }
}
export function BgpPanel({ lab, device }: { lab: LabController; device: Device }) {
  const state = device.bgp;
  return (
    <div className="protocol-panel bgp-panel">
      <div className="learning-card">
        <strong>Rotas entre sistemas autônomos</strong>
        <p>
          BGP troca OPEN, KEEPALIVE e UPDATE sobre TCP/179. AS_PATH impede loops; LOCAL_PREF e filtros definem
          a política. NEXT_HOP precisa de rota no underlay. Avance os eventos para negociar e observar
          retiradas. Aplicar reinicia as sessões.
        </p>
      </div>
      <form
        key={state?.token ?? device.id}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          lab.change(() => {
            const peers = neighbors(String(form.get('neighbors')));
            filters(peers, String(form.get('filters')));
            lab.engine.configureBgp(device.id, {
              enabled: form.has('enabled'),
              asn: Number(form.get('asn')),
              routerId: String(form.get('routerId')),
              holdMs: Number(form.get('hold')) * 1000,
              neighbors: peers,
              networks: String(form.get('networks')).split(/\s+/).filter(Boolean).map(cidr),
            });
          });
        }}
      >
        <label className="check-label">
          <input type="checkbox" name="enabled" defaultChecked={state?.enabled ?? true} /> Ativar BGP
        </label>
        <div className="form-grid">
          <label>
            AS local
            <input
              type="number"
              name="asn"
              required
              min="1"
              max="4294967294"
              defaultValue={state?.asn ?? 65001}
            />
          </label>
          <label>
            Router ID BGP
            <input
              name="routerId"
              required
              defaultValue={state?.routerId ?? device.interfaces.find((port) => port.ip)?.ip}
            />
          </label>
        </div>
        <label>
          Hold time BGP (s)
          <input
            type="number"
            name="hold"
            required
            min="3"
            max="180"
            defaultValue={(state?.holdMs ?? 90000) / 1000}
          />
        </label>
        <label>
          Redes anunciadas BGP
          <textarea
            name="networks"
            rows={3}
            placeholder="192.168.10.0/24"
            defaultValue={state?.networks.map((route) => route.network + '/' + route.prefix).join('\n')}
          />
        </label>
        <p className="muted">O prefixo deve existir na tabela conectada, estática ou IGP do roteador.</p>
        <label>
          Vizinhos BGP
          <textarea
            name="neighbors"
            rows={4}
            placeholder="10.0.0.2 65002 next-hop-self"
            defaultValue={state?.neighbors
              .map(
                (peer) =>
                  `${peer.ip} ${peer.remoteAs}${peer.passive ? ' passive' : ''}${peer.nextHopSelf ? ' next-hop-self' : ''}${peer.reflectorClient ? ' rr-client' : ''} local-pref=${peer.localPref} med=${peer.med} prepend=${peer.prepend}`
              )
              .join('\n')}
          />
        </label>
        <p className="muted">
          Uma linha: IP AS remoto. Opções: passive, next-hop-self, rr-client, local-pref=N, med=N, prepend=N.
        </p>
        <label>
          Filtros de prefixos BGP
          <textarea
            name="filters"
            rows={3}
            placeholder="10.0.0.2 in 10 permit 192.168.0.0/16 ge 24 le 24"
            defaultValue={state?.neighbors
              .flatMap((peer) =>
                (['importFilter', 'exportFilter'] as const).flatMap((direction) =>
                  peer[direction].map(
                    (rule) =>
                      `${peer.ip} ${direction === 'importFilter' ? 'in' : 'out'} ${rule.sequence} ${rule.action} ${rule.network}/${rule.prefix}${rule.minPrefix !== undefined ? ' ge ' + rule.minPrefix : ''}${rule.maxPrefix !== undefined ? ' le ' + rule.maxPrefix : ''}`
                  )
                )
              )
              .join('\n')}
          />
        </label>
        <p className="muted">
          Primeira regra por sequência. Um filtro configurado tem deny implícito; sem regras, permite prefixos
          válidos.
        </p>
        <button className="button small primary">
          <Save size={14} /> Aplicar BGP
        </button>
      </form>
      <section className="table-section">
        <h4>Sessões BGP</h4>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Vizinho / AS</th>
                <th>Estado</th>
                <th>Hold / TX/RX</th>
              </tr>
            </thead>
            <tbody>
              {state?.peers.map((peer) => (
                <tr key={peer.ip} data-state={peer.state}>
                  <td>
                    {peer.ip}
                    <br />
                    AS {state.neighbors.find((config) => config.ip === peer.ip)!.remoteAs}
                  </td>
                  <td>{peer.state}</td>
                  <td>
                    {peer.holdAt === undefined
                      ? '—'
                      : Math.max(0, (peer.holdAt - lab.engine.state.clock) / 1000).toFixed(1) + ' s'}
                    <br />
                    {peer.sent}/{peer.received}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="table-section">
        <h4>Caminhos BGP</h4>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Prefixo</th>
                <th>NEXT_HOP / origem</th>
                <th>AS_PATH</th>
                <th>LOCAL_PREF / MED</th>
              </tr>
            </thead>
            <tbody>
              {state?.rib.map((path) => {
                const best = state.routes.some(
                  (route) =>
                    route.network === path.network && route.prefix === path.prefix && route.peer === path.peer
                );
                return (
                  <tr key={path.peer + ':' + path.network + '/' + path.prefix} data-best={best}>
                    <td>
                      {best ? '> ' : ''}
                      {path.network}/{path.prefix}
                    </td>
                    <td>
                      {path.nextHop}
                      <br />
                      <small>
                        {path.peer} · {path.origin}
                      </small>
                    </td>
                    <td>{path.asPath.join(' ') || 'AS local'}</td>
                    <td>
                      {path.localPref} / {path.med}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted">
          &gt; indica caminho instalado. iBGP usa distância 200; eBGP, 20. Refletores usam
          ORIGINATOR_ID/CLUSTER_LIST para evitar loops.
        </p>
      </section>
    </div>
  );
}
