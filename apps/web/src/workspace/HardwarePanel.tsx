import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function HardwarePanel({ lab, device }: { lab: LabController; device: Device }) {
  const [json, setJson] = useState(() =>
    JSON.stringify(
      {
        supply: device.poeSupply
          ? {
              enabled: device.poeSupply.enabled,
              budget: device.poeSupply.budget,
              ports: device.poeSupply.ports,
            }
          : {
              enabled: false,
              budget: 120,
              ports: device.interfaces
                .filter((p) => p.media === 'rj45')
                .map((p) => ({ port: p.id, enabled: true, standard: 'at', priority: 10 })),
            },
        load: device.poeDevice
          ? {
              required: device.poeDevice.required,
              class: device.poeDevice.class,
              watts: device.poeDevice.watts,
            }
          : { required: false, class: 3, watts: 10 },
      },
      null,
      2
    )
  );
  const [output, setOutput] = useState('');
  const consoleLinks = lab.engine.state.links.filter(
    (l) => l.cable === 'console' && [l.a, l.b].some((p) => p.device === device.id)
  );
  return (
    <section>
      <h4>Alimentação PoE e portas de gerenciamento</h4>
      <p className="muted">
        PSE reserva potência por classe e prioridade. Um PD dependente de PoE só funciona com cabo de cobre e
        orçamento suficiente. Use required: true para telefone, AP ou câmera alimentados pela rede.
      </p>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          lab.change((e) => {
            const c = JSON.parse(json);
            e.configurePoe(device.id, c.supply, c.load);
          });
        }}
      >
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="PSE / PD"
          schema={configurationSchemas.hardware}
          className="config-json"
          rows={10}
          value={json}
          onChange={(ev) => setJson(ev.target.value)}
        />
        <button className="button small primary">Aplicar PoE</button>
      </form>
      <p>
        PoE:{' '}
        {device.poeDevice?.required
          ? device.poeDevice.powered
            ? 'alimentado por ' + device.poeDevice.source
            : 'sem alimentação'
          : 'alimentação local'}
        . Reserva PSE: {device.poeSupply?.allocations.reduce((n, a) => n + a.watts, 0).toFixed(1) ?? 0}/
        {device.poeSupply?.budget ?? 0} W.
      </p>
      {device.poeSupply?.allocations.map((a) => (
        <p key={a.port}>
          {a.port} → {a.device} · {a.watts} W
        </p>
      ))}
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          const f = new FormData(ev.currentTarget);
          lab.change((e) => {
            const media = f.get('media') as 'serial' | 'console';
            e.addHardwarePort(
              device.id,
              media,
              media === 'serial'
                ? { role: f.get('role'), clockRate: Number(f.get('clock')), encapsulation: 'hdlc' }
                : { baud: String(f.get('baud')) }
            );
          });
        }}
      >
        <h4>Adicionar porta serial ou console</h4>
        <label>
          Socket
          <select name="media">
            <option value="serial">Serial WAN · HDLC</option>
            <option value="console">Console UART</option>
          </select>
        </label>
        <label>
          Função serial
          <select name="role">
            <option>DCE</option>
            <option>DTE</option>
          </select>
        </label>
        <label>
          Clock serial (bits/s)
          <input name="clock" type="number" min={9600} max={2000000} defaultValue={64000} />
        </label>
        <label>
          Baud console
          <select name="baud">
            {[9600, 19200, 38400, 57600, 115200].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <button className="button small">Adicionar socket</button>
      </form>
      <p className="muted">
        Conecte Serial a Serial com um DCE e um DTE, ou Console a Console. Console permite configurar o outro
        equipamento sem endereço IP; as duas portas precisam do mesmo baud.
      </p>
      {consoleLinks.length > 0 && (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            lab.change((e) => {
              const response = e.consoleCommand(device.id, String(f.get('link')), String(f.get('command')));
              setOutput((v) => (v + '\n' + response).slice(-12000));
            }, false);
          }}
        >
          <label>
            Cabo console
            <select name="link">
              {consoleLinks.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Comando UART
            <input name="command" maxLength={512} required />
          </label>
          <button className="button small">Enviar pela console</button>
          <pre className="terminal-output">{output}</pre>
        </form>
      )}
    </section>
  );
}
