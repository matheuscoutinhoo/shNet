import { useState, type FormEvent } from 'react';
import { formatSnmpQuery, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function SnmpPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [oids, setOids] = useState('1.3.6.1.2.1.1.5.0');
  const latest = device.snmpQueries?.at(-1);
  function query(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    lab.change(
      (engine) =>
        engine.querySnmp(
          device.id,
          String(data.get('server')),
          String(data.get('community')),
          oids.trim().split(/\s+/),
          data.get('operation') as 'get' | 'get-next'
        ),
      false
    );
  }
  return (
    <section className="snmp-panel">
      <h4>SNMP v2c · leitura de objetos</h4>
      <p className="muted">
        GET e GETNEXT por UDP/161. O agente responde com seu estado atual; uma community incorreta não recebe
        resposta.
      </p>
      <form
        key={JSON.stringify(device.snmpAgent)}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          lab.change((engine) =>
            engine.configureSnmpAgent(device.id, {
              enabled: data.has('enabled'),
              community: data.get('community'),
            })
          );
        }}
      >
        <label className="checkbox-label">
          <input name="enabled" type="checkbox" defaultChecked={device.snmpAgent?.enabled} />
          Agente SNMP ativo
        </label>
        <label>
          Community do agente
          <input
            name="community"
            required
            maxLength={32}
            pattern="[a-zA-Z0-9_-]+"
            defaultValue={device.snmpAgent?.community ?? 'public'}
          />
        </label>
        <button className="button small">Aplicar agente SNMP</button>
      </form>
      <form onSubmit={query}>
        <label>
          Agente consultado
          <input name="server" required defaultValue="192.168.20.10" />
        </label>
        <div className="form-grid">
          <label>
            Operação SNMP
            <select name="operation">
              <option value="get">GET</option>
              <option value="get-next">GETNEXT</option>
            </select>
          </label>
          <label>
            Community da consulta
            <input name="community" required maxLength={32} defaultValue="public" />
          </label>
        </div>
        <label>
          OIDs consultados
          <textarea
            aria-label="OIDs consultados"
            value={oids}
            onChange={(event) => setOids(event.target.value)}
            required
            maxLength={2064}
          />
        </label>
        <p className="muted">
          Até 16 OIDs separados por espaço. Nome: 1.3.6.1.2.1.1.5.0 · Tempo do agente: 1.3.6.1.2.1.1.3.0 ·
          Interfaces: 1.3.6.1.2.1.2.1.0.
        </p>
        <button className="button small primary" disabled={!device.power}>
          Consultar SNMP
        </button>
      </form>
      <div className="snmp-result" data-state={latest?.status ?? 'idle'} aria-live="polite">
        {latest ? <pre>{formatSnmpQuery(latest)}</pre> : <p className="muted">Nenhuma consulta SNMP.</p>}
      </div>
      <p className="muted">
        Somente leitura; sem SET, traps, SNMPv3 ou codec BER. Contadores shLab usam a árvore de exemplo
        1.3.6.1.4.1.32473.1: RX .1, TX .2, descartes .3.0, erros .4; interfaces pelo índice a partir de 1.
      </p>
    </section>
  );
}
