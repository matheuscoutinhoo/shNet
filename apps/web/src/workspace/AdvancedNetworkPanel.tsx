import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { wirelessConfig, enterpriseDefaults, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function AdvancedNetworkPanel({ lab, device }: { lab: LabController; device: Device }) {
  const demo = enterpriseDefaults();
  const defaults = {
    eapServer: demo.server,
    eapSupplicant: demo.supplicant,
    eapAuthenticator: {
      enabled: true,
      server: '192.0.2.2',
      underlay: device.interfaces.find((p) => p.mode === 'routed' && p.ip)?.id ?? device.interfaces[0].id,
      key: 'radius-network-key',
      reauthMs: 60000,
    },
    mesh: {
      enabled: true,
      meshId: 'campus-mesh',
      key: 'mesh-network-key',
      root: false,
      priority: 100,
      maxDistance: 100,
    },
    wlc: {
      enabled: true,
      underlay: device.interfaces.find((p) => p.mode === 'routed' && p.ip)?.id ?? device.interfaces[0].id,
      key: 'controller-network-key',
      allowedWtps: [],
      profiles: [
        {
          name: 'campus',
          vlan: 10,
          wireless: { ...wirelessConfig(device), role: 'ap', ssid: 'Campus', enabled: true },
        },
      ],
    },
    wtp: {
      enabled: true,
      underlay: device.interfaces.find((p) => p.mode === 'routed' && p.ip)?.id ?? device.interfaces[0].id,
      controller: '192.0.2.1',
      key: 'controller-network-key',
      profile: 'campus',
    },
    ids: {
      enabled: true,
      mode: 'ids',
      rules: [
        {
          id: 'http-path',
          name: 'Travessia de caminho HTTP',
          protocol: 'TCP',
          destinationPort: 80,
          pattern: '../',
          action: 'alert',
        },
      ],
    },
  };
  const [kind, setKind] = useState<keyof typeof defaults>(
    device.wtp
      ? 'wtp'
      : device.wlc
        ? 'wlc'
        : device.mesh
          ? 'mesh'
          : device.eapServer
            ? 'eapServer'
            : device.eapAuthenticator
              ? 'eapAuthenticator'
              : device.eapSupplicant
                ? 'eapSupplicant'
                : 'ids'
  );
  function configuration(type: keyof typeof defaults) {
    const value = device[type];
    if (!value) return defaults[type];
    return Object.fromEntries(
      [...Object.keys(defaults[type]), ...(type === 'eapSupplicant' ? ['password'] : [])].map((k) => [
        k,
        (value as unknown as Record<string, unknown>)[k],
      ])
    );
  }
  const [json, setJson] = useState(() => JSON.stringify(configuration(kind), null, 2));
  return (
    <section>
      <h4>WLC/CAPWAP, mesh, EAP empresarial e IDS/IPS</h4>
      <label>
        Recurso de rede
        <select
          aria-label="Recurso de rede"
          value={kind}
          onChange={(ev) => {
            const next = ev.target.value as typeof kind;
            setKind(next);
            setJson(JSON.stringify(configuration(next), null, 2));
          }}
        >
          <option value="eapServer">Servidor EAP TLS / PEAP</option>
          <option value="eapAuthenticator">AP autenticador RADIUS</option>
          <option value="eapSupplicant">Cliente EAP TLS / PEAP</option>
          <option value="ids">IDS / IPS</option>
          <option value="mesh">Mesh de APs</option>
          <option value="wlc">Controller WLC</option>
          <option value="wtp">AP gerenciado · WTP</option>
        </select>
      </label>
      <p className="muted">
        WLC e AP gerenciado exigem uma interface underlay routed/SVI com IPv4 e rota entre eles. O mesmo
        perfil e a mesma chave habilitam UDP/5246 e /5247. Mesh exige APs no mesmo canal; root define uma
        saída cabeada e priority escolhe a raiz. IDS alerta; IPS pode descartar. EAP exige SSID
        WPA2-Enterprise, AP com rota ao servidor e certificado confiável no cliente. Os valores iniciais
        incluem uma autoridade local para exercícios; PEAP usa senha dentro do canal TLS.
      </p>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          lab.change((e) => {
            const c = JSON.parse(json);
            if (kind === 'eapServer') e.configureEapServer(device.id, c);
            else if (kind === 'eapAuthenticator') e.configureEapAuthenticator(device.id, c);
            else if (kind === 'eapSupplicant') e.configureEapSupplicant(device.id, c);
            else if (kind === 'mesh') e.configureMesh(device.id, c);
            else if (kind === 'wlc') e.configureWlc(device.id, c);
            else if (kind === 'wtp') e.configureWtp(device.id, c);
            else e.configureIds(device.id, c);
          });
        }}
      >
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Configuração de rede avançada"
          schema={configurationSchemas.advancedNetwork[kind]}
          className="config-json"
          rows={14}
          value={json}
          onChange={(ev) => setJson(ev.target.value)}
        />
        <button className="button small primary">Aplicar recurso de rede</button>
      </form>
      {device.eapSupplicant && (
        <p>
          EAP {device.eapSupplicant.method.toUpperCase()} · {device.eapSupplicant.phase} · TLS{' '}
          {device.eapSupplicant.tlsState?.phase ?? 'aguardando'}
        </p>
      )}
      {device.eapServer && (
        <p>
          EAP autorizado {device.eapServer.accepted} · rejeitado {device.eapServer.rejected} · sessões{' '}
          {device.eapServer.sessions.length}
        </p>
      )}
      {device.wtp && (
        <p>
          CAPWAP {device.wtp.phase} · controller {device.wtp.controller} · perfil {device.wtp.profile}
        </p>
      )}
      {device.wlc?.sessions.map((s) => (
        <p key={s.session}>
          WTP {s.wtp} · {s.address} · {s.phase} · {s.profile ?? 'configurando'} · registros recebidos{' '}
          {s.receivedSequences.length}
        </p>
      ))}
      {device.mesh && (
        <p>
          Mesh {device.mesh.meshId} · raiz {device.mesh.route?.root ?? 'sem caminho'} · pai{' '}
          {device.mesh.parent ?? '—'} · caminho {device.mesh.route?.path.join(' → ') ?? '—'}
        </p>
      )}
      {device.ids && (
        <>
          <h4>Alertas IDS / IPS</h4>
          <p>
            Modo {device.ids.mode.toUpperCase()} · descartes {device.ids.dropped}
          </p>
          {device.ids.alerts.slice(-20).map((a, i) => (
            <p key={i}>
              {(a.at / 1000).toFixed(1)} s · {a.source} → {a.destination} ·{' '}
              {a.blocked ? 'bloqueado' : 'alerta'} · {a.reason}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
