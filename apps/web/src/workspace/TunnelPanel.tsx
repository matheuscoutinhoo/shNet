import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { tunnelConfig, tunnelMetrics, sdwanConfig, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
const samplePolicy = [
  {
    name: 'WEB',
    match: { destination: { network: '10.2.0.0', prefix: 24 }, protocol: 'tcp', destinationPort: 80 },
    prefer: ['internet', 'mpls', 'lte'],
    maxRtt: 100,
    maxLoss: 20,
    fallback: true,
  },
];
export function TunnelPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [number, setNumber] = useState(1),
    p = device.interfaces.find((p) => p.tunnel?.number === number),
    c = p ? tunnelConfig(p) : undefined,
    s = sdwanConfig(device);
  return (
    <div className="tunnel-panel">
      <p className="muted">
        Túneis L3 sobre UDP/4500 negociam INIT/AUTH, DH X25519 e SAs com AES-GCM, SPI, anti-replay e renovação
        de chaves. O tráfego percorre o underlay e sofre suas ACLs, perda, latência e MTU. SD-WAN seleciona
        túneis por SLA medido.
      </p>
      {device.interfaces
        .filter((p) => p.tunnel)
        .map((p) => {
          const m = tunnelMetrics(p);
          return (
            <section key={p.id} className="subnet-card" data-tunnel-state={p.tunnel!.status}>
              <strong>
                {p.name} · {p.tunnel!.status}
              </strong>
              <p>
                {p.tunnel!.transport} → {p.tunnel!.remote}
              </p>
              <p>
                RTT {Number.isFinite(m.rtt) ? m.rtt.toFixed(2) : '—'} ms · perda {m.loss.toFixed(1)}% · dados{' '}
                {p.tunnel!.sent}/{p.tunnel!.received}
              </p>
              <p>
                SA: {p.tunnel!.ike?.phase ?? 'INIT'} · SPI {p.tunnel!.ike?.localChildSpi ?? '-'}
              </p>
              <p>
                Rotas:{' '}
                {p.tunnel!.remotePrefixes.map((r) => r.network + '/' + r.prefix).join(', ') ||
                  'aguardando peer'}
              </p>
              <button className="button small" onClick={() => setNumber(p.tunnel!.number)}>
                Editar {p.name}
              </button>
              <button
                className="button small"
                onClick={() => lab.change((e) => e.removeLogicalInterface(device.id, p.id))}
              >
                Excluir {p.name}
              </button>
            </section>
          );
        })}
      <form
        key={number + ':' + (c?.key ?? 'new')}
        onSubmit={(ev) => {
          ev.preventDefault();
          const f = new FormData(ev.currentTarget);
          lab.change((e) =>
            e.configureTunnel(device.id, {
              number,
              enabled: f.get('enabled') === 'on',
              mode: f.get('mode'),
              channel: Number(f.get('channel')),
              underlay: f.get('underlay'),
              remote: f.get('remote'),
              key: f.get('key'),
              ip: f.get('ip'),
              prefix: Number(f.get('prefix')),
              peerIp: f.get('peerIp'),
              transport: f.get('transport'),
              mtu: Number(f.get('mtu')),
              lifetimeMs: Number(f.get('lifetime')) * 1000,
              advertise: String(f.get('advertise'))
                .split(/[\s,]+/)
                .filter(Boolean)
                .map((v) => {
                  const [network, prefix] = v.split('/');
                  return { network, prefix: Number(prefix) };
                }),
            })
          );
        }}
      >
        <label>
          Número do túnel
          <input
            aria-label="Número do túnel"
            type="number"
            min="1"
            max="64"
            value={number}
            onChange={(ev) => setNumber(Number(ev.target.value))}
          />
        </label>
        <label className="wireless-check">
          <input type="checkbox" name="enabled" defaultChecked={c?.enabled ?? true} />
          Túnel habilitado
        </label>
        <label>
          Modo do túnel
          <select name="mode" defaultValue={c?.mode ?? 'ipsec'}>
            <option value="ipsec">VPN (conceitual)</option>
            <option value="sdwan">SD-WAN</option>
          </select>
        </label>
        <label>
          Underlay WAN
          <select aria-label="Underlay WAN" name="underlay" defaultValue={c?.underlay ?? 'p1'}>
            {device.interfaces
              .filter((p) => !p.tunnel && !p.channel && p.mode === 'routed' && !p.vrf)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.ip ?? 'sem IPv4'}
                </option>
              ))}
          </select>
        </label>
        <label>
          Peer WAN
          <input aria-label="Peer WAN" name="remote" defaultValue={c?.remote ?? '192.0.2.2'} required />
        </label>
        <label>
          Canal compartilhado
          <input
            aria-label="Canal do túnel"
            name="channel"
            type="number"
            min="1"
            max="65535"
            defaultValue={c?.channel ?? 10}
          />
        </label>
        <label>
          Chave do túnel
          <input
            aria-label="Chave do túnel"
            name="key"
            type="password"
            minLength={8}
            maxLength={64}
            defaultValue={c?.key ?? ''}
            required
          />
        </label>
        <label>
          IPv4 do overlay
          <input aria-label="IPv4 do overlay" name="ip" defaultValue={c?.ip ?? '172.16.0.1'} required />
        </label>
        <label>
          Prefixo do overlay
          <input
            aria-label="Prefixo do overlay"
            name="prefix"
            type="number"
            min="1"
            max="32"
            defaultValue={c?.prefix ?? 30}
          />
        </label>
        <label>
          Peer no overlay
          <input
            aria-label="Peer no overlay"
            name="peerIp"
            defaultValue={c?.peerIp ?? '172.16.0.2'}
            required
          />
        </label>
        <label>
          Transporte
          <select name="transport" defaultValue={c?.transport ?? 'internet'}>
            <option value="internet">Internet</option>
            <option value="mpls">MPLS (classe de transporte)</option>
            <option value="lte">LTE (classe de transporte)</option>
          </select>
        </label>
        <label>
          Validade das chaves (segundos)
          <input
            name="lifetime"
            type="number"
            min={10}
            max={3600}
            defaultValue={(c?.lifetimeMs ?? 60000) / 1000}
          />
        </label>
        <label>
          MTU do túnel
          <input
            aria-label="MTU do túnel"
            name="mtu"
            type="number"
            min="576"
            max="1400"
            defaultValue={c?.mtu ?? 1400}
          />
        </label>
        <label>
          Prefixos anunciados
          <input
            aria-label="Prefixos anunciados"
            name="advertise"
            defaultValue={c?.advertise.map((r) => r.network + '/' + r.prefix).join(' ') ?? '10.1.0.0/24'}
          />
        </label>
        <button className="button small" type="submit">
          Aplicar túnel
        </button>
      </form>
      <h4>Políticas SD-WAN</h4>
      <p className="muted">
        Políticas são avaliadas na ordem do JSON. O primeiro destino/protocolo/porta correspondente escolhe o
        transporte preferido dentro do SLA; fallback permite um caminho fora do SLA.
      </p>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          const f = new FormData(ev.currentTarget);
          lab.change((e) =>
            e.configureSdwan(device.id, {
              enabled: f.get('enabled') === 'on',
              site: f.get('site'),
              controller: String(f.get('controller')).trim() || undefined,
              underlay: String(f.get('underlay')).trim() || undefined,
              key: String(f.get('key')).trim() || undefined,
              policies: JSON.parse(String(f.get('policies'))),
            })
          );
        }}
      >
        <label className="wireless-check">
          <input type="checkbox" name="enabled" defaultChecked={device.sdwan?.enabled ?? false} />
          SD-WAN habilitado
        </label>
        <label>
          Site
          <input aria-label="Site SD-WAN" name="site" defaultValue={s.site} />
        </label>
        <label>
          Controller IPv4 (opcional)
          <input aria-label="Controller SD-WAN" name="controller" defaultValue={s.controller ?? ''} />
        </label>
        <label>
          Interface do controller
          <input
            aria-label="Interface do controller"
            name="underlay"
            defaultValue={s.underlay ?? ''}
            placeholder="p1"
          />
        </label>
        <label>
          Chave do controller
          <input aria-label="Chave do controller" type="password" name="key" defaultValue={s.key ?? ''} />
        </label>
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Políticas JSON"
          schema={configurationSchemas.sdwanPolicies}
          aria-label="Políticas SD-WAN JSON"
          name="policies"
          rows={12}
          defaultValue={JSON.stringify(device.sdwan ? s.policies : samplePolicy, null, 2)}
        />
        <button className="button small" type="submit">
          Aplicar SD-WAN
        </button>
      </form>
      <p>
        Controller:{' '}
        {device.sdwan?.lastController !== undefined
          ? 'políticas recebidas em ' + device.sdwan.lastController.toFixed(1) + ' ms'
          : 'sem resposta recebida'}
      </p>
      {device.sdwan?.selected.map((p) => (
        <p key={p.policy} data-selected-path={p.port}>
          {p.policy} → {device.interfaces.find((i) => i.id === p.port)?.name}
        </p>
      ))}
      {!!device.sdwan?.receivedPolicies.length && (
        <pre>{JSON.stringify(device.sdwan.receivedPolicies, null, 2)}</pre>
      )}
    </div>
  );
}
export function SdwanControllerPanel({ lab, device }: { lab: LabController; device: Device }) {
  return (
    <section className="tunnel-panel">
      <h4>Controller SD-WAN</h4>
      <p className="muted">
        Distribui políticas por UDP/5000 a edges com site e chave válidos. Os arquivos abaixo descrevem
        configuração de rede simulada.
      </p>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          const f = new FormData(ev.currentTarget);
          lab.change((e) =>
            e.configureSdwanController(device.id, {
              enabled: f.get('enabled') === 'on',
              key: f.get('key'),
              sites: JSON.parse(String(f.get('sites'))),
            })
          );
        }}
      >
        <label className="wireless-check">
          <input type="checkbox" name="enabled" defaultChecked={device.sdwanController?.enabled ?? false} />
          Controller habilitado
        </label>
        <label>
          Chave de distribuição
          <input
            aria-label="Chave de distribuição"
            type="password"
            name="key"
            minLength={8}
            defaultValue={device.sdwanController?.key ?? ''}
            required
          />
        </label>
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Sites e políticas JSON"
          schema={configurationSchemas.sdwanPolicies}
          aria-label="Sites SD-WAN JSON"
          name="sites"
          rows={12}
          defaultValue={JSON.stringify(
            device.sdwanController?.sites ?? [{ site: 'Site-1', policies: samplePolicy }],
            null,
            2
          )}
        />
        <button className="button small" type="submit">
          Aplicar controller
        </button>
      </form>
    </section>
  );
}
