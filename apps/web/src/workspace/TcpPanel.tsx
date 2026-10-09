import { useState } from 'react';
import { Play, Save } from 'lucide-react';
import { tcpFinished, type Device } from '@shlab/engine';
import type { LabController } from './useLab';

export function TcpPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [operation, setOperation] = useState('http');
  const [selected, setSelected] = useState('');
  const connections = device.tcpConnections ?? [];
  const active = connections.find((entry) => entry.id === selected) ?? connections.at(-1);
  const canSend = active && ['ESTABLISHED', 'CLOSE-WAIT'].includes(active.state) && !active.closeRequested;
  return (
    <div className="tcp-panel">
      <p className="muted">
        Conecte, envie dados e acompanhe SYN, ACK e FIN na timeline. Use Próximo evento ou Reproduzir para
        avançar.
      </p>
      <section>
        <h4>Opções para novas conexões</h4>
        <form
          key={device.id}
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            lab.change((e) =>
              e.configureTcpSettings(device.id, {
                sack: values.has('sack'),
                ecn: values.has('ecn'),
                timestamps: values.has('timestamps'),
                pmtud: values.has('pmtud'),
                mss: Number(values.get('mss')),
              })
            );
          }}
        >
          {(['sack', 'ecn', 'timestamps', 'pmtud'] as const).map((key) => (
            <label className="checkbox-label" key={key}>
              <input name={key} type="checkbox" defaultChecked={device.tcpSettings?.[key] ?? true} />
              {
                {
                  sack: 'SACK · confirmação seletiva',
                  ecn: 'ECN · congestionamento sem perda',
                  timestamps: 'Timestamps · RTT e PAWS',
                  pmtud: 'PMTUD · descoberta da MTU',
                }[key]
              }
            </label>
          ))}
          <label>
            MSS anunciado (bytes)
            <input
              name="mss"
              type="number"
              min={64}
              max={8960}
              defaultValue={device.tcpSettings?.mss ?? 1460}
              required
            />
          </label>
          <button className="button small">Aplicar opções TCP</button>
        </form>
      </section>
      {
        <section>
          <h4>Serviços TCP</h4>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              lab.change((engine) =>
                engine.configureTcpService(device.id, {
                  kind: data.get('kind'),
                  port: Number(data.get('port')),
                  enabled: true,
                  body: String(data.get('body')),
                })
              );
            }}
          >
            <div className="form-grid">
              <label>
                Serviço
                <select name="kind">
                  {device.type !== 'pc' && <option value="http">HTTP</option>}
                  <option value="echo">Echo</option>
                </select>
              </label>
              <label>
                Porta do serviço
                <input
                  name="port"
                  type="number"
                  min={1}
                  max={65535}
                  defaultValue={device.type === 'pc' ? 7 : 80}
                  required
                />
              </label>
            </div>
            <label>
              Resposta HTTP
              <textarea name="body" maxLength={4096} defaultValue="Olá da rede simulada!" />
            </label>
            <button className="button small">
              <Save size={14} /> Salvar serviço
            </button>
          </form>
          {device.tcpServices?.map((service) => (
            <label className="checkbox-label" key={service.port}>
              <input
                type="checkbox"
                checked={service.enabled}
                onChange={(event) =>
                  lab.change((engine) =>
                    engine.configureTcpService(device.id, { ...service, enabled: event.target.checked })
                  )
                }
              />
              {service.kind.toUpperCase()} TCP/{service.port} · {service.enabled ? 'LISTEN' : 'desativado'}
            </label>
          ))}
        </section>
      }
      <section>
        <h4>Gerar tráfego</h4>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const id = lab.change(
              (engine) =>
                operation === 'http'
                  ? engine.httpGet(
                      device.id,
                      String(data.get('target')),
                      Number(data.get('port')),
                      String(data.get('path')),
                      String(data.get('vrf') ?? '') || undefined,
                      String(data.get('host') ?? '') || undefined,
                      String(data.get('scope') ?? '') || undefined
                    )
                  : engine.openTcp(
                      device.id,
                      String(data.get('target')),
                      Number(data.get('port')),
                      operation === 'echo' ? String(data.get('data')) : '',
                      operation === 'echo',
                      String(data.get('vrf') ?? '') || undefined,
                      String(data.get('scope') ?? '') || undefined
                    ),
              false
            );
            if (id) setSelected(id);
          }}
        >
          {!!device.vrfs?.length && (
            <label>
              VRF do tráfego TCP
              <select name="vrf">
                <option value="">Padrão</option>
                {device.vrfs.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Operação TCP
            <select value={operation} onChange={(event) => setOperation(event.target.value)}>
              <option value="http">HTTP GET</option>
              <option value="echo">Echo TCP</option>
              <option value="connect">Abrir conexão</option>
            </select>
          </label>
          <div className="form-grid">
            <label>
              Destino TCP IPv4/IPv6
              <input name="target" defaultValue="192.168.20.10" required />
            </label>
            <label>
              Porta de destino TCP
              <input
                key={operation}
                name="port"
                type="number"
                min={1}
                max={65535}
                defaultValue={operation === 'http' ? 80 : 7}
                required
              />
            </label>
          </div>
          {device.interfaces.some((p) => p.ipv6) && (
            <label>
              Interface TCP IPv6 link-local
              <select name="scope">
                <option value="">Automática (endereço global)</option>
                {device.interfaces
                  .filter((p) => p.ipv6)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {operation === 'http' && (
            <label>
              Host HTTP (opcional)
              <input name="host" maxLength={253} placeholder="Nome virtual; padrão é o IP de destino" />
            </label>
          )}
          {operation === 'http' && (
            <label>
              Caminho HTTP
              <input name="path" defaultValue="/" maxLength={256} required />
            </label>
          )}
          {operation === 'echo' && (
            <label>
              Mensagem echo
              <textarea name="data" defaultValue="Olá, rede!" maxLength={16384} required />
            </label>
          )}
          <button className="button small primary" disabled={!device.power}>
            <Play size={14} /> Iniciar tráfego TCP
          </button>
        </form>
      </section>
      <section>
        <h4>
          Conexões <span>{connections.length}</span>
        </h4>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Destino / porta</th>
                <th>Estado</th>
                <th>TX / RX</th>
              </tr>
            </thead>
            <tbody>
              {[...connections].reverse().map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <button className="tcp-connection-button" onClick={() => setSelected(entry.id)}>
                      {entry.remoteIp}:{entry.remotePort}
                      <small>
                        {entry.id} · {entry.vrf ?? 'padrão'}
                      </small>
                    </button>
                  </td>
                  <td>{entry.state}</td>
                  <td>
                    {entry.bytesSent} / {entry.bytesReceived} B
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {active ? (
          <div className="tcp-result" data-state={active.state} aria-live="polite">
            <strong>
              {active.id} · {active.state}
            </strong>
            <p className="muted">
              {active.localIp}:{active.localPort} → {active.remoteIp}:{active.remotePort}
            </p>
            <p className="muted">
              SEQ {active.sendNext} · ACK {active.receiveNext} · Janela remota {active.peerWindow} B ·
              Retransmissões {active.retransmissions}
            </p>
            {active.flow && (
              <p className="muted">
                Em voo {(active.sendNext - active.sendUna) >>> 0} B · CWND {Math.floor(active.flow.cwnd)} B ·
                SSTHRESH {Math.floor(active.flow.ssthresh)} B · RTO {active.flow.rto} ms · RTT{' '}
                {active.flow.srtt?.toFixed(2) ?? 'sem amostra'} ms · Fora de ordem{' '}
                {active.flow.receiveQueue.length}
              </p>
            )}
            {active.extensions && (
              <p className="muted">
                MSS {active.flow?.mss} B · MTU {active.extensions.pathMtu ?? 'sem descoberta'} · SACK{' '}
                {active.extensions.sack ? 'negociado' : 'desativado'} · ECN{' '}
                {active.extensions.ecn ? 'negociado' : 'desativado'} · Timestamps{' '}
                {active.extensions.timestamps ? 'negociados' : 'desativados'}
              </p>
            )}
            <pre className="tcp-payload">{active.received || 'Aguardando dados da aplicação.'}</pre>
            {canSend && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  lab.change(
                    (engine) => engine.writeTcp(device.id, active.id, String(data.get('data'))),
                    false
                  );
                }}
              >
                <label>
                  Dados da conexão
                  <input name="data" required maxLength={16384} />
                </label>
                <button className="button small">Enviar dados TCP</button>
              </form>
            )}
            {!tcpFinished(active) && active.state !== 'TIME-WAIT' && (
              <div className="dns-actions">
                <button
                  className="button small"
                  onClick={() => lab.change((engine) => engine.closeTcp(device.id, active.id), false)}
                >
                  Encerrar com FIN
                </button>
                <button
                  className="button small"
                  onClick={() => lab.change((engine) => engine.closeTcp(device.id, active.id, true), false)}
                >
                  Reset TCP
                </button>
              </div>
            )}
          </div>
        ) : (
          <p className="table-empty">Nenhuma conexão TCP.</p>
        )}
      </section>
    </div>
  );
}
