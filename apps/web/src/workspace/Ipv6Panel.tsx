import { useState } from 'react';
import { ipv6Config, ipv6ConfigSchema, linkLocal6, type Device, type NetworkInterface } from '@shlab/engine';
import type { LabController } from './useLab';
import { Dhcp6Panel } from './Dhcp6Panel';

function aclText(p: NetworkInterface, direction: 'aclIn' | 'aclOut') {
  return (
    p.ipv6?.[direction]
      ?.map(
        (r) => `${r.action} ${r.kind} ${r.source}/${r.sourcePrefix} ${r.destination}/${r.destinationPrefix}`
      )
      .join('\n') ?? ''
  );
}
function parseAcl(text: string) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 4) throw new Error('ACL: permit|deny KIND ORIGEM/PREFIXO DESTINO/PREFIXO.');
      const [source, sp] = parts[2].split('/'),
        [destination, dp] = parts[3].split('/');
      if (sp === undefined || dp === undefined) throw new Error('Informe os prefixos da ACL.');
      return {
        action: parts[0],
        kind: parts[1],
        source,
        sourcePrefix: Number(sp),
        destination,
        destinationPrefix: Number(dp),
        hits: 0,
      };
    });
}
function Port6Form({ lab, device, port }: { lab: LabController; device: Device; port: NetworkInterface }) {
  const [addresses, setAddresses] = useState(
      ipv6Config(port)
        .addresses.map((a) => a.ip + '/' + a.prefix)
        .join('\n')
    ),
    [auto, setAuto] = useState(port.ipv6?.auto ?? false),
    [advertise, setAdvertise] = useState(!!port.ipv6?.ra),
    [prefixes, setPrefixes] = useState(
      port.ipv6?.ra?.prefixes.map((p) => p.network + '/' + p.prefix).join('\n') ?? ''
    ),
    [interval, setInterval] = useState(port.ipv6?.ra?.intervalMs ?? 3000),
    [lifetime, setLifetime] = useState(port.ipv6?.ra?.lifetimeMs ?? 9000),
    [incoming, setIncoming] = useState(aclText(port, 'aclIn')),
    [outgoing, setOutgoing] = useState(aclText(port, 'aclOut'));
  return (
    <form
      className="ipv6-form"
      onSubmit={(event) => {
        event.preventDefault();
        lab.change((e) => {
          const parse = (value: string) =>
            value
              .split('\n')
              .filter((l) => l.trim())
              .map((line) => {
                const [ip, prefix] = line.trim().split('/');
                if (prefix === undefined) throw new Error('Informe IPv6/PREFIXO.');
                return { ip, prefix: Number(prefix) };
              });
          const input = ipv6ConfigSchema.parse({
            auto,
            addresses: parse(addresses),
            ...(advertise
              ? {
                  ra: {
                    intervalMs: interval,
                    lifetimeMs: lifetime,
                    prefixes: parse(prefixes).map((p) => ({
                      network: p.ip,
                      prefix: p.prefix,
                      onLink: true,
                      autonomous: p.prefix === 64,
                      validMs: 60000,
                      preferredMs: 30000,
                    })),
                  },
                }
              : {}),
            aclIn: parseAcl(incoming),
            aclOut: parseAcl(outgoing),
          });
          e.configureIpv6(device.id, port.id, input);
          return true;
        });
      }}
    >
      <label>
        Endereços IPv6 estáticos
        <textarea
          aria-label="Endereços IPv6 estáticos"
          placeholder="2001:db8:1::1/64"
          rows={2}
          value={addresses}
          onChange={(e) => setAddresses(e.target.value)}
        />
      </label>
      <label className="ipv6-check">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        Obter endereço e gateway por SLAAC
      </label>
      {['router', 'switch'].includes(device.type) && (
        <>
          <label className="ipv6-check">
            <input type="checkbox" checked={advertise} onChange={(e) => setAdvertise(e.target.checked)} />
            Anunciar Router Advertisements
          </label>
          {advertise && (
            <>
              <label>
                Prefixos RA
                <textarea
                  aria-label="Prefixos RA"
                  rows={2}
                  placeholder="2001:db8:1::/64"
                  value={prefixes}
                  onChange={(e) => setPrefixes(e.target.value)}
                />
              </label>
              <div className="ipv6-grid">
                <label>
                  Intervalo RA (ms)
                  <input
                    type="number"
                    min={1000}
                    max={60000}
                    value={interval}
                    onChange={(e) => setInterval(Number(e.target.value))}
                  />
                </label>
                <label>
                  Vida do gateway (ms)
                  <input
                    type="number"
                    min={0}
                    max={180000}
                    value={lifetime}
                    onChange={(e) => setLifetime(Number(e.target.value))}
                  />
                </label>
              </div>
              <p className="muted">
                Prefixos /64: SLAAC com vida válida de 60 s e preferida de 30 s. Gateway com vida zero é
                retirado.
              </p>
            </>
          )}
        </>
      )}
      <details>
        <summary>ACL IPv6 por interface</summary>
        <p className="muted">
          Uma regra por linha: permit|deny any|echo-request|echo-reply|ndp|error ORIGEM/PREFIXO
          DESTINO/PREFIXO. Lista vazia permite; lista configurada tem deny implícito. NDP também passa pela
          ACL.
        </p>
        <label>
          ACL IPv6 entrada
          <textarea rows={3} value={incoming} onChange={(e) => setIncoming(e.target.value)} />
        </label>
        <label>
          ACL IPv6 saída
          <textarea rows={3} value={outgoing} onChange={(e) => setOutgoing(e.target.value)} />
        </label>
      </details>
      <div className="ipv6-actions">
        <button className="button primary" type="submit">
          Aplicar IPv6
        </button>
        {port.ipv6 && (
          <button type="button" onClick={() => lab.change((e) => e.configureIpv6(device.id, port.id))}>
            Desabilitar IPv6
          </button>
        )}
      </div>
    </form>
  );
}
export function Ipv6Panel({ lab, device }: { lab: LabController; device: Device }) {
  const ports = device.interfaces.filter(
      (p) => !p.channel && (device.type !== 'switch' || p.mode === 'routed')
    ),
    [portId, setPortId] = useState(ports[0]?.id ?? ''),
    [target, setTarget] = useState(''),
    [hop, setHop] = useState(64),
    [bytes, setBytes] = useState(104),
    [vrf, setVrf] = useState(''),
    [network, setNetwork] = useState('::/0'),
    [nextHop, setNextHop] = useState(''),
    [routePort, setRoutePort] = useState('');
  const port = ports.find((p) => p.id === portId) ?? ports[0],
    probes =
      lab.engine.state.probes6
        ?.filter((p) => p.device === device.id)
        .slice(-8)
        .reverse() ?? [];
  return (
    <div className="panel-body ipv6-panel">
      <p className="muted">
        IPv6 usa ICMPv6/NDP, DAD, multicast e SLAAC na rede simulada. Link-local exige interface; VRF e VLAN
        limitam o alcance. TCP/HTTP, UDP e DHCPv6 usam esse mesmo encaminhamento e a descoberta de vizinhos.
      </p>
      {['router', 'switch'].includes(device.type) && (
        <label className="ipv6-check">
          <input
            type="checkbox"
            checked={device.ipv6Routing ?? false}
            onChange={(event) =>
              lab.change((e) => {
                e.device(device.id).ipv6Routing = event.target.checked;
              })
            }
          />
          Encaminhamento IPv6
        </label>
      )}
      {!ports.length ? (
        <p>Crie uma SVI ou uma porta routed para habilitar a stack IPv6 do switch.</p>
      ) : (
        <>
          <label>
            Interface IPv6
            <select
              aria-label="Interface IPv6"
              value={port?.id ?? ''}
              onChange={(e) => setPortId(e.target.value)}
            >
              {ports.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.vrf ? ' · ' + p.vrf : ''}
                </option>
              ))}
            </select>
          </label>
          {port && <Port6Form key={port.id} lab={lab} device={device} port={port} />}
        </>
      )}
      <h3>Endereços e gateways</h3>
      <Dhcp6Panel key={port?.id} lab={lab} device={device} port={port} />
      <div className="ipv6-addresses">
        {ports
          .filter((p) => p.ipv6)
          .map((p) => (
            <article key={p.id}>
              <strong>
                {p.name} · {p.vrf ?? 'Tabela padrão'}
              </strong>
              {p.ipv6!.addresses.map((a) => (
                <p key={a.ip}>
                  <code>
                    {a.ip}/{a.prefix}
                  </code>
                  <span>
                    {a.origin} · {a.state}
                  </span>
                </p>
              ))}
              {p.ipv6!.routers.map((r) => (
                <p key={r.ip}>
                  Gateway RA <code>{r.ip}</code>
                  <span>
                    Expira em {Math.max(0, (r.expiresAt - lab.engine.state.clock) / 1000).toFixed(1)} s
                  </span>
                </p>
              ))}
            </article>
          ))}
      </div>
      <h3>Ping IPv6</h3>
      <form
        className="ipv6-form"
        onSubmit={(event) => {
          event.preventDefault();
          lab.change((e) =>
            e.ping6(
              device.id,
              target,
              hop,
              vrf || undefined,
              linkLocal6(target) ? port?.id : undefined,
              bytes
            )
          );
        }}
      >
        <label>
          Destino IPv6
          <input
            aria-label="Destino IPv6"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="2001:db8:2::10"
            required
          />
        </label>
        <div className="ipv6-grid">
          <label>
            Hop Limit
            <input
              aria-label="Hop Limit IPv6"
              type="number"
              min={1}
              max={255}
              value={hop}
              onChange={(e) => setHop(Number(e.target.value))}
            />
          </label>
          <label>
            Tamanho IPv6 (bytes)
            <input
              type="number"
              min={48}
              max={65535}
              value={bytes}
              onChange={(e) => setBytes(Number(e.target.value))}
            />
          </label>
        </div>
        {device.vrfs?.length ? (
          <label>
            Tabela do ping
            <select value={vrf} onChange={(e) => setVrf(e.target.value)}>
              <option value="">Padrão</option>
              {device.vrfs.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        ) : null}
        <button className="primary">Enviar ping IPv6</button>
      </form>
      <div className="ipv6-results" aria-live="polite">
        {probes.map((p) => (
          <p key={p.id}>
            <code>{p.target}</code>
            <strong>{p.status}</strong>
            <span>
              {p.rtt === undefined ? '' : p.rtt.toFixed(3) + ' ms'}
              {p.mtu ? ' · MTU ' + p.mtu : ''}
            </span>
          </p>
        ))}
      </div>
      <details>
        <summary>Rotas IPv6 estáticas</summary>
        <form
          className="ipv6-form"
          onSubmit={(event) => {
            event.preventDefault();
            lab.change((e) => {
              const [ip, prefix] = network.split('/'),
                p = device.interfaces.find((p) => p.id === routePort);
              if (prefix === undefined || !p) throw new Error('Informe rede/prefixo e interface.');
              e.configureRoute6(device.id, {
                network: ip,
                prefix: Number(prefix),
                port: p.id,
                nextHop,
                metric: 1,
                ...(p.vrf ? { vrf: p.vrf } : {}),
              });
            });
          }}
        >
          <label>
            Rede IPv6/prefixo
            <input value={network} onChange={(e) => setNetwork(e.target.value)} required />
          </label>
          <label>
            Saída da rota
            <select value={routePort} onChange={(e) => setRoutePort(e.target.value)} required>
              <option value="">Selecione</option>
              {ports
                .filter((p) => p.ipv6)
                .map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name} · {p.vrf ?? 'Padrão'}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Próximo salto IPv6
            <input
              value={nextHop}
              onChange={(e) => setNextHop(e.target.value)}
              placeholder="fe80::1 ou :: (diretamente conectado)"
              required
            />
          </label>
          <button>Adicionar rota IPv6</button>
        </form>
        {device.routes6?.map((r) => (
          <p key={r.network + r.prefix + r.port + r.vrf}>
            <code>
              {r.network}/{r.prefix}
            </code>{' '}
            via <code>{r.nextHop}</code> · {r.port}
            <button onClick={() => lab.change((e) => e.configureRoute6(device.id, r, true))}>Remover</button>
          </p>
        ))}
      </details>
      <details>
        <summary>Vizinhos NDP ({device.neighbors6?.length ?? 0})</summary>
        {device.neighbors6?.map((n) => (
          <p className="ipv6-neighbor" key={n.port + n.ip}>
            <code>{n.ip}</code>
            <span>
              {n.mac} · {device.interfaces.find((p) => p.id === n.port)?.name} · {n.state ?? 'REACHABLE'}
            </span>
          </p>
        ))}
        {device.resolutions6?.map((r) => (
          <p key={r.port + r.ip}>
            {r.ip} · INCOMPLETE · {r.attempts}/3
          </p>
        ))}
      </details>
    </div>
  );
}
