import { deviceCapabilities } from './deviceCapabilities';
import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { wirelessConfig, enterpriseDefaults, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
import { wlcPhysicalControls } from './physicalControls';
export function AdvancedNetworkPanel({ lab, device }: { lab: LabController; device: Device }) {
  const kinds = deviceCapabilities(device).advancedKinds;
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
      enabled: false,
      mode: device.profile === 'ips' ? 'ips' : 'ids',
      rules: [],
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
                : kinds[0]
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
      <h4>Recursos de rede do equipamento</h4>
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
          {kinds.map((value) => (
            <option key={value} value={value}>
              {
                {
                  eapServer: 'Servidor EAP TLS / PEAP',
                  eapAuthenticator: 'AP autenticador RADIUS',
                  eapSupplicant: 'Cliente EAP TLS / PEAP',
                  ids: 'IDS / IPS',
                  mesh: 'Mesh de APs',
                  wlc: 'Controller WLC',
                  wtp: 'AP gerenciado · WTP',
                }[value]
              }
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        {
          {
            eapServer:
              'Servidor RADIUS para EAP TLS/PEAP: autorize o AP pela chave compartilhada, configure usuários e a identidade de servidor. A autoridade do exemplo pertence ao laboratório.',
            eapAuthenticator:
              'O AP autentica o cliente com um servidor RADIUS alcançável pelo underlay IPv4. Use SSID WPA2-Enterprise; o cliente precisa confiar na autoridade do servidor.',
            eapSupplicant:
              'O cliente usa um certificado no EAP-TLS ou senha no PEAP. Configure o SSID WPA2-Enterprise e a autoridade confiável do servidor RADIUS.',
            wlc: 'O controlador gerencia APs por CAPWAP. Configure IPv4 no underlay, perfis WLAN e a chave compartilhada com os APs. O transporte usa UDP/5246 para controle e /5247 para dados.',
            wtp: 'Este AP gerenciado precisa de rota IPv4 até o controlador, perfil WLAN e chave correspondentes. O controlador entrega a configuração após discovery e join CAPWAP.',
            mesh: 'APs da mesma mesh usam identidade, chave e canal comuns. Marque como raiz o AP com saída cabeada. A prioridade escolhe a raiz e a métrica determina o caminho entre vizinhos.',
            ids: 'IDS observa assinaturas e taxas e gera alertas. IPS pode descartar o tráfego que corresponde às regras. Neste modelo, a inspeção atua no caminho de encaminhamento do equipamento.',
          }[kind]
        }
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
            else if (kind === 'wlc')
              e.configureWlc(device.id, wlcPhysicalControls(c, e.device(device.id).wlc));
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
