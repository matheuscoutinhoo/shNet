import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function ApplicationsPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [kind, setKind] = useState<'phone' | 'proxy' | 'printer' | 'broker'>(
    device.phone ? 'phone' : device.printer ? 'printer' : device.proxy ? 'proxy' : 'broker'
  );
  const defaults = {
    phone: { enabled: true, number: '100', sipPort: 5060, rtpPort: 20000, autoAnswer: true },
    proxy: {
      enabled: true,
      kind: 'proxy',
      port: 3128,
      algorithm: 'round-robin',
      backends: [],
      allowedNetworks: [],
      healthIntervalMs: 5000,
    },
    printer: { enabled: true, port: 631, pagesPerMinute: 30, paper: 100 },
    broker: { enabled: true, port: 1883 },
  };
  const config = (type: typeof kind) => {
    const c = device[type];
    if (!c) return defaults[type];
    const base = defaults[type];
    return Object.fromEntries(
      Object.keys(base).map((k) => [k, (c as unknown as Record<string, unknown>)[k]])
    );
  };
  const [json, setJson] = useState(() => JSON.stringify(config(kind), null, 2));
  return (
    <div className="applications-panel">
      <h4>Telefone, proxy, balanceador, impressora e IoT</h4>
      <label>
        Serviço
        <select
          value={kind}
          onChange={(ev) => {
            const type = ev.target.value as typeof kind;
            setKind(type);
            setJson(JSON.stringify(config(type), null, 2));
          }}
        >
          {['phone', 'proxy', 'printer', 'broker'].map((v) => (
            <option key={v} value={v}>
              {
                (
                  {
                    phone: 'Telefone SIP/RTP',
                    proxy: 'Proxy / balanceador HTTP',
                    printer: 'Impressora IPP',
                    broker: 'Broker MQTT',
                  } as Record<string, string>
                )[v]
              }
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          lab.change((e) => {
            const c = JSON.parse(json);
            if (kind === 'phone') e.configurePhone(device.id, c);
            else if (kind === 'proxy') e.configureProxy(device.id, c);
            else if (kind === 'printer') e.configurePrinter(device.id, c);
            else e.configureBroker(device.id, c);
          });
        }}
      >
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Configuração do serviço"
          schema={configurationSchemas.applications[kind]}
          className="config-json"
          rows={10}
          value={json}
          onChange={(ev) => setJson(ev.target.value)}
        />
        <button className="button small primary">Aplicar serviço</button>
      </form>
      {device.proxy && (
        <section>
          <h4>Backends HTTP</h4>
          {device.proxy.health.map((h) => (
            <p key={h.address + ':' + h.port}>
              {h.address}:{h.port} · {h.state} · verificado em {Math.round(h.checkedAt / 1000)} s
            </p>
          ))}
          <p>
            Requisições: {device.proxy.requests.filter((r) => !r.health && r.state === 'complete').length}{' '}
            concluídas.
          </p>
          <p className="muted">
            Para balanceador use kind: load-balancer, port: 80 e backends. Para proxy, allowedNetworks contém
            os IPs de destino permitidos.
          </p>
        </section>
      )}
      {device.phone && (
        <section>
          <h4>Chamadas SIP</h4>
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const f = new FormData(ev.currentTarget);
              lab.change((e) => e.callPhone(device.id, String(f.get('target'))), false);
            }}
          >
            <label>
              Telefone remoto IPv4
              <input name="target" required />
            </label>
            <button className="button small">Chamar telefone</button>
          </form>
          {device.phone.calls.map((c) => (
            <p key={c.id}>
              {c.remote} · {c.state} · RTP {c.sent} enviados / {c.received} recebidos{' '}
              <button
                className="button small"
                disabled={['CLOSED', 'FAILED'].includes(c.state)}
                onClick={() => lab.change((e) => e.hangupPhone(device.id, c.id), false)}
              >
                Encerrar
              </button>
            </p>
          ))}
        </section>
      )}
      <section>
        <h4>Impressão pela rede</h4>
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            lab.change(
              (e) =>
                e.submitPrint(
                  device.id,
                  String(f.get('target')),
                  String(f.get('name')),
                  Number(f.get('pages'))
                ),
              false
            );
          }}
        >
          <label>
            Impressora IPv4/IPv6
            <input name="target" required />
          </label>
          <label>
            Nome do documento
            <input name="name" defaultValue="Documento" maxLength={100} />
          </label>
          <label>
            Páginas
            <input name="pages" type="number" min={1} max={50} defaultValue={1} />
          </label>
          <button className="button small">Enviar impressão IPP</button>
        </form>
        {device.printer && (
          <>
            <p>Papel disponível: {device.printer.paper}</p>
            {device.printer.jobs.map((j) => (
              <p key={j.id}>
                #{j.id} {j.name} · {j.state} · {j.printed}/{j.pages} páginas
              </p>
            ))}
          </>
        )}
      </section>
      <section>
        <h4>Cliente IoT · MQTT 3.1.1</h4>
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            lab.change(
              (e) => e.connectIot(device.id, String(f.get('broker')), String(f.get('client'))),
              false
            );
          }}
        >
          <label>
            Broker IPv4/IPv6
            <input name="broker" required />
          </label>
          <label>
            ID MQTT
            <input name="client" defaultValue={device.hostname} maxLength={64} />
          </label>
          <button className="button small">Conectar IoT</button>
        </form>
        <p>MQTT: {device.iot?.state ?? 'desconectado'}</p>
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            lab.change((e) => e.subscribeIot(device.id, String(f.get('topic'))), false);
          }}
        >
          <label>
            Filtro de assinatura MQTT
            <input name="topic" placeholder="sala/+/temperatura" required />
          </label>
          <button className="button small" disabled={device.iot?.state !== 'CONNECTED'}>
            Assinar tópico
          </button>
        </form>
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            lab.change(
              (e) =>
                e.publishIot(
                  device.id,
                  String(f.get('topic')),
                  String(f.get('payload')),
                  f.get('retain') === 'on'
                ),
              false
            );
          }}
        >
          <label>
            Tópico MQTT
            <input name="topic" required />
          </label>
          <label>
            Valor do sensor
            <input name="payload" required />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" name="retain" /> Reter último valor
          </label>
          <button className="button small" disabled={device.iot?.state !== 'CONNECTED'}>
            Publicar leitura
          </button>
        </form>
        {device.iot?.readings.slice(-10).map((r, i) => (
          <p key={i}>
            {r.topic}: {r.payload}
          </p>
        ))}
      </section>
    </div>
  );
}
