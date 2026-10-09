import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { remoteConfig, telemetryConfig, ntpConfig, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function RemotePanel({ lab, device }: { lab: LabController; device: Device }) {
  const [kind, setKind] = useState(device.type === 'pc' ? 'request' : 'server');
  const examples = {
    server: device.remoteManagement
      ? remoteConfig(device)
      : {
          enabled: true,
          netconf: true,
          restconf: true,
          key: 'remote-key',
          clients: [],
          users: [{ username: 'admin', password: 'rede-admin', privilege: 15 }],
        },
    request: {
      target: '192.168.10.1',
      protocol: 'netconf',
      username: 'admin',
      password: 'rede-admin',
      key: 'remote-key',
      operation: 'get-config',
    },
    automation: {
      name: 'configurar borda',
      username: 'admin',
      password: 'rede-admin',
      key: 'remote-key',
      steps: [
        {
          target: '192.168.10.1',
          protocol: 'netconf',
          operation: 'edit-config',
          datastore: 'candidate',
          patch: { hostname: 'R-AUTOMATED' },
        },
        { target: '192.168.10.1', protocol: 'netconf', operation: 'validate' },
        { target: '192.168.10.1', protocol: 'netconf', operation: 'commit' },
      ],
    },
    telemetry: device.telemetry
      ? telemetryConfig(device)
      : {
          enabled: true,
          collector: '192.168.20.10',
          key: 'telemetry-key',
          intervalMs: 1000,
          sensors: ['interfaces', 'routes', 'tcp', 'qos', 'aaa'],
        },
    collector: device.telemetryCollector
      ? { enabled: device.telemetryCollector.enabled, key: device.telemetryCollector.key }
      : { enabled: true, key: 'telemetry-key' },
    clock: device.networkClock ?? { offsetMs: 300, server: false, stratum: 1 },
    ntp: device.ntp ? ntpConfig(device) : { enabled: true, servers: ['192.168.20.10'], intervalMs: 5000 },
  };
  return (
    <section className="remote-panel tunnel-panel">
      <h4>Automação e monitoramento</h4>
      <p className="muted">
        NETCONF negocia capabilities e XML base 1.0/1.1 sobre TCP/830, com running/candidate/startup,
        validate, commit e lock. RESTCONF usa recursos HTTP, GET/PATCH/PUT/POST/DELETE e ETag em TCP/443.
        Ambos validam certificados e cifram o canal com o modelo TLS. Telemetria publica sensores em UDP; NTP
        mede offset com quatro timestamps.
      </p>
      <label>
        Operação de gerenciamento
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {device.type !== 'pc' && <option value="server">Servidor NETCONF / RESTCONF</option>}
          <option value="request">Enviar RPC remoto</option>
          <option value="automation">Executar sequência de automação</option>
          <option value="telemetry">Publicador de telemetria</option>
          {device.type !== 'pc' && <option value="collector">Coletor de telemetria</option>}
          <option value="clock">Relógio / servidor NTP</option>
          <option value="ntp">Cliente NTP</option>
        </select>
      </label>
      <form
        key={JSON.stringify([device.id, kind, examples[kind as keyof typeof examples]])}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          lab.change((engine) => {
            const c = JSON.parse(String(f.get('remote')));
            if (kind === 'server') engine.configureRemote(device.id, c);
            else if (kind === 'request') engine.requestRemote(device.id, c);
            else if (kind === 'automation') engine.runAutomation(device.id, c);
            else if (kind === 'telemetry') engine.configureTelemetry(device.id, c);
            else if (kind === 'collector') engine.configureCollector(device.id, c);
            else if (kind === 'clock') engine.configureClock(device.id, c);
            else engine.configureNtp(device.id, c);
          });
        }}
      >
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Gerenciamento de rede JSON"
          schema={configurationSchemas.remote[kind as keyof typeof configurationSchemas.remote]}
          name="remote"
          rows={12}
          required
          spellCheck={false}
          defaultValue={JSON.stringify(examples[kind as keyof typeof examples], null, 2)}
        />
        <button className="button small">Aplicar gerenciamento</button>
      </form>
      {device.remoteManagement && (
        <p>
          Running rev {device.remoteManagement.revision} · commits {device.remoteManagement.commits} ·
          candidate {device.remoteManagement.candidate ? 'pendente' : 'vazio'} · lock{' '}
          {device.remoteManagement.lock ? 'ativo' : 'livre'}
        </p>
      )}
      {device.ntp && (
        <p data-ntp-sync={device.ntp.synchronized}>
          NTP: {device.ntp.synchronized ? 'sincronizado' : 'aguardando peer'} · stratum {device.ntp.stratum} ·
          offset {device.networkClock?.offsetMs.toFixed(3)} ms · falhas {device.ntp.failures}
        </p>
      )}
      {device.telemetry && <p>Telemetria enviada: {device.telemetry.sent} datagramas.</p>}
      {device.telemetryCollector && (
        <>
          <p data-telemetry-records={device.telemetryCollector.received}>
            Coletor: {device.telemetryCollector.received} aceitos / {device.telemetryCollector.rejected}{' '}
            rejeitados.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Fonte / tempo</th>
                  <th>Sensor</th>
                  <th>Valor</th>
                </tr>
              </thead>
              <tbody>
                {device.telemetryCollector.records.slice(-4).flatMap((r, i) =>
                  r.message.metrics.map((m, n) => (
                    <tr key={i + '-' + n}>
                      <td>
                        {r.source}
                        <br />
                        {r.message.timestamp.toFixed(3)}
                      </td>
                      <td>{m.path}</td>
                      <td>{m.value}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>RPC</th>
              <th>Operação</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {device.remoteQueries?.map((q) => (
              <tr key={q.id} data-remote-status={q.status}>
                <td>
                  {q.protocol}
                  <br />
                  {q.target}
                </td>
                <td>{q.rpc.operation}</td>
                <td>
                  {q.status}
                  {q.response?.error && <p>{q.response.error}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {device.remoteQueries?.at(-1)?.response?.data && (
        <details>
          <summary>Dados recebidos</summary>
          <pre>{JSON.stringify(JSON.parse(device.remoteQueries.at(-1)!.response!.data!), null, 2)}</pre>
        </details>
      )}
      {device.automationJobs?.map((j) => (
        <p key={j.id} data-automation-status={j.status}>
          {j.name}: {j.index}/{j.steps.length} {j.status}
        </p>
      ))}
      <p className="muted">
        get/get-config usam páginas de 8 interfaces e 16 rotas (offset). Candidate detecta alterações
        concorrentes no running; lock tem lease de 30 s. Jobs param no primeiro erro. NTP não implementa
        autenticação nem disciplina de frequência; telemetria usa o formato próprio do modelo.
      </p>
    </section>
  );
}
