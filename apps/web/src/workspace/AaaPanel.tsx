import { deviceCapabilities } from './deviceCapabilities';
import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { aaaServerConfig, dot1xConfig, supplicantConfig, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function AaaPanel({ lab, device }: { lab: LabController; device: Device }) {
  const kinds = deviceCapabilities(device).aaaKinds;
  const [kind, setKind] = useState<string>(
    device.aaaServer ? 'server' : device.type === 'switch' && kinds.includes('dot1x') ? 'dot1x' : kinds[0]
  );
  const [port, setPort] = useState(device.interfaces[0].id);
  const p = device.interfaces.find((p) => p.id === port) ?? device.interfaces[0];
  const examples = {
    server: device.aaaServer
      ? aaaServerConfig(device)
      : {
          enabled: true,
          radius: true,
          tacacs: true,
          key: 'rede-demo',
          clients: [],
          users: [{ username: 'aluno', password: 'rede123', privilege: 15, sessionMs: 60000, vlan: 20 }],
        },
    client: device.aaaClient ?? {
      server: '192.0.2.2',
      key: 'rede-demo',
      method: 'tacacs',
      enforceCli: false,
    },
    dot1x: p.dot1x
      ? dot1xConfig(p)
      : { enabled: true, server: '192.0.2.2', key: 'rede-demo', underlay: 'p1', reauthMs: 60000 },
    supplicant: p.supplicant
      ? supplicantConfig(p)
      : { enabled: true, username: 'aluno', password: 'rede123' },
  };
  return (
    <section className="aaa-panel tunnel-panel">
      <p className="muted">
        802.1X bloqueia dados na porta cabeada até EAPOL e RADIUS/UDP1812 autorizarem o MAC. TACACS+ usa
        TCP/49 para CHAP, autorização de comandos e accounting de sessão. Configure commands no usuário; ["*"]
        permite todos os comandos conforme o privilégio. Para Wi-Fi empresarial PEAP/TLS, use a configuração
        EAP na aba de recursos empresariais. Credenciais pertencem ao laboratório.
      </p>
      <label>
        Configurar
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {
                {
                  server: 'Servidor RADIUS / TACACS+',
                  client: 'Cliente AAA / terminal',
                  dot1x: 'Porta controlada 802.1X',
                  supplicant: 'Supplicant 802.1X',
                }[value]
              }
            </option>
          ))}
        </select>
      </label>
      {(kind === 'dot1x' || kind === 'supplicant') && (
        <label>
          Interface
          <select value={port} onChange={(e) => setPort(e.target.value)}>
            {device.interfaces
              .filter(
                (p) =>
                  p.media !== 'wifi' &&
                  !p.logical &&
                  !p.aggregate &&
                  !p.bond &&
                  !p.channel &&
                  !p.tunnel &&
                  !p.vxlan
              )
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <form
        key={JSON.stringify([device.id, kind, port, examples[kind as keyof typeof examples]])}
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          lab.change((engine) => {
            const input = JSON.parse(String(data.get('config')));
            if (kind === 'server') engine.configureAaaServer(device.id, input);
            else if (kind === 'client') engine.configureAaaClient(device.id, input);
            else if (kind === 'dot1x') engine.configureDot1x(device.id, p.id, input);
            else engine.configureSupplicant(device.id, p.id, input);
          });
        }}
      >
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Configuração AAA JSON"
          schema={configurationSchemas.aaa[kind as keyof typeof configurationSchemas.aaa]}
          name="config"
          rows={12}
          defaultValue={JSON.stringify(examples[kind as keyof typeof examples], null, 2)}
          required
          spellCheck={false}
        />
        <button className="button small">Aplicar AAA</button>
      </form>
      <p className="muted">
        A porta cabeada usa challenge/response CHAP e RADIUS em octetos. PEAP/TLS empresarial fica na
        configuração EAP; TACACS+ usa autorização separada e obfuscação do corpo. VLAN devolvida pelo RADIUS
        deve existir no switch. A opção enforceCli exige privilégio 15 para configuração pelo terminal.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Porta</th>
              <th>Estado</th>
              <th>MAC / VLAN</th>
            </tr>
          </thead>
          <tbody>
            {device.interfaces
              .filter((p) => p.dot1x || p.supplicant)
              .map((p) => (
                <tr key={p.id} data-dot1x-state={p.dot1x?.phase ?? p.supplicant?.phase}>
                  <td>{p.name}</td>
                  <td>{p.dot1x?.phase ?? p.supplicant?.phase}</td>
                  <td>
                    {p.dot1x?.mac ?? '—'} / {p.accessVlan}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {device.aaaClient && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            lab.change(
              (engine) =>
                engine.loginNetwork(device.id, String(f.get('username')), String(f.get('password'))),
              false
            );
          }}
        >
          <label>
            Usuário de rede
            <input name="username" required maxLength={64} />
          </label>
          <label>
            Senha de rede
            <input name="password" type="password" required maxLength={64} />
          </label>
          <button className="button small">Autenticar na rede</button>
        </form>
      )}
      <p>
        Login:{' '}
        {device.networkAuth
          ? device.networkAuth.username + ' / privilégio ' + device.networkAuth.privilege
          : 'sem autorização'}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Consulta</th>
              <th>Protocolo / usuário</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {device.aaaQueries?.map((q) => (
              <tr key={q.id} data-aaa-status={q.status}>
                <td>{q.id}</td>
                <td>
                  {q.method} / {q.username}
                </td>
                <td>{q.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {device.aaaServer && (
        <p>
          Servidor: {device.aaaServer.accepted} aceitos / {device.aaaServer.rejected} rejeitados;{' '}
          {device.aaaServer.accounting.length} registros AAA.
        </p>
      )}
    </section>
  );
}
