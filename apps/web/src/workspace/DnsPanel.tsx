import { useState, type FormEvent } from 'react';
import { Plus, Pencil, Trash2, Search, Eraser, Save } from 'lucide-react';
import { dnsRecordSchema, formatDnsQuery, type Device, type DnsRecord } from '@shlab/engine';
import type { LabController } from './useLab';
import { Modal } from '../components/Modal';
import { DnsSecurityPanel } from './DnsSecurityPanel';

export function DnsPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [editing, setEditing] = useState<{ record?: DnsRecord } | null>(null);
  const [portId, setPortId] = useState(device.interfaces[0].id);
  const port = device.interfaces.find((entry) => entry.id === portId)!;
  const latest = device.dnsQueries?.at(-1);
  const cache = device.dnsCache?.filter((entry) => entry.expiresAt > lab.engine.state.clock) ?? [];
  const serverCapable = device.type === 'server' || device.type === 'router';
  function query(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    lab.setError('');
    const data = new FormData(event.currentTarget);
    lab.change(
      (engine) =>
        engine.lookupDns(
          device.id,
          String(data.get('name')),
          data.get('type') as DnsRecord['type'],
          String(data.get('server') ?? '').trim() || undefined,
          undefined,
          data.get('transport') as 'auto' | 'udp' | 'tcp'
        ),
      false
    );
  }
  return (
    <div className="dns-panel">
      <DnsSecurityPanel lab={lab} device={device} />
      {serverCapable && (
        <>
          <div className="mode-switch">
            <span>Serviço DNS · UDP e TCP/53</span>
            <button
              type="button"
              role="switch"
              aria-label="Serviço DNS"
              aria-checked={device.dnsServer?.enabled ?? false}
              className={'switch ' + (device.dnsServer?.enabled ? 'on' : '')}
              onClick={() =>
                lab.change((engine) => engine.setDnsEnabled(device.id, !device.dnsServer?.enabled))
              }
            >
              <i />
            </button>
          </div>
          <section className="table-section dns-records">
            <div className="dns-heading">
              <h4>
                Registros <span>{device.dnsServer?.records.length ?? 0}</span>
              </h4>
              <button
                className="button small"
                onClick={() => {
                  lab.setError('');
                  setEditing({});
                }}
              >
                <Plus size={14} /> Novo registro
              </button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Nome / valor</th>
                    <th>TTL</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {device.dnsServer?.records.map((record) => (
                    <tr key={JSON.stringify([record.name, record.type, record.value])}>
                      <td>
                        <strong>{record.name}</strong>
                        <br />
                        <small>
                          {record.type} · {record.value}
                        </small>
                      </td>
                      <td>{record.ttl} s</td>
                      <td>
                        <div className="dns-actions">
                          <button
                            className="icon-button"
                            title="Editar registro"
                            aria-label={'Editar ' + record.name + ' ' + record.type}
                            onClick={() => {
                              lab.setError('');
                              setEditing({ record });
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            className="icon-button"
                            title="Excluir registro"
                            aria-label={'Excluir ' + record.name + ' ' + record.type}
                            onClick={() => lab.change((engine) => engine.removeDnsRecord(device.id, record))}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!device.dnsServer?.records.length && <p className="table-empty">Nenhum registro DNS.</p>}
          </section>
        </>
      )}
      <section>
        <h4 className="dns-section-title">Resolvedor</h4>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            lab.setError('');
            const data = new FormData(event.currentTarget);
            lab.change((engine) =>
              engine.setDnsServers(
                device.id,
                port.id,
                String(data.get('servers') ?? '')
                  .trim()
                  .split(/[\s,]+/)
                  .filter(Boolean)
              )
            );
          }}
        >
          <label>
            Interface do resolvedor
            <select value={portId} onChange={(event) => setPortId(event.target.value)}>
              {device.interfaces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} · {entry.ip ?? 'Sem IPv4'}
                </option>
              ))}
            </select>
          </label>
          <label>
            {port.ipv4Mode === 'dhcp' ? 'Servidores DNS (DHCP)' : 'Servidores DNS'}
            <input
              name="servers"
              key={port.id + ':' + port.dns?.join(',')}
              defaultValue={port.dns?.join(', ') ?? ''}
              readOnly={port.ipv4Mode === 'dhcp'}
              placeholder="192.168.50.2"
            />
          </label>
          {port.ipv4Mode !== 'dhcp' && (
            <button className="button small">
              <Save size={14} /> Salvar resolvedor
            </button>
          )}
        </form>
      </section>
      <section>
        <h4 className="dns-section-title">Consulta DNS</h4>
        <form onSubmit={query}>
          <label>
            Nome consultado
            <input name="name" required maxLength={254} defaultValue="server.lab" />
          </label>
          <div className="form-grid">
            <label>
              Tipo de consulta
              <select name="type" defaultValue="A">
                <option>A</option>
                <option>AAAA</option>
                <option>CNAME</option>
              </select>
            </label>
            <label>
              Servidor da consulta
              <input name="server" placeholder="Automático" />
            </label>
          </div>
          <label>
            Transporte DNS
            <select name="transport" defaultValue="auto">
              <option value="auto">Automático (UDP, depois TCP se truncado)</option>
              <option value="udp">Somente UDP</option>
              <option value="tcp">TCP</option>
            </select>
          </label>
          <button className="button small primary" disabled={!device.power}>
            <Search size={14} /> Consultar DNS
          </button>
        </form>
        <div className="dns-query-result" data-state={latest?.status ?? 'idle'} aria-live="polite">
          {latest ? <pre>{formatDnsQuery(latest)}</pre> : <p className="muted">Nenhuma consulta.</p>}
        </div>
      </section>
      <section className="table-section dns-cache">
        <div className="dns-heading">
          <h4>
            Cache <span>{cache.length}</span>
          </h4>
          <button
            className="icon-button"
            title="Limpar cache DNS"
            aria-label="Limpar cache DNS"
            disabled={!cache.length}
            onClick={() => lab.change((engine) => engine.clearDnsCache(device.id))}
          >
            <Eraser size={15} />
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Nome / tipo</th>
                <th>TTL restante</th>
              </tr>
            </thead>
            <tbody>
              {cache.map((entry) => (
                <tr key={JSON.stringify([entry.server, entry.question])}>
                  <td>
                    {entry.question.name}
                    <br />
                    <small>
                      {entry.question.type} · {entry.server}
                    </small>
                  </td>
                  <td>{Math.ceil((entry.expiresAt - lab.engine.state.clock) / 1000)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!cache.length && <p className="table-empty">Cache DNS vazio.</p>}
      </section>
      {!!device.dnsQueries?.length && (
        <details className="dns-history">
          <summary>Histórico de consultas</summary>
          {device.dnsQueries
            .slice(-20)
            .reverse()
            .map((entry) => (
              <pre key={entry.id}>{formatDnsQuery(entry)}</pre>
            ))}
        </details>
      )}
      {editing && (
        <DnsRecordEditor lab={lab} device={device} record={editing.record} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function DnsRecordEditor({
  lab,
  device,
  record,
  onClose,
}: {
  lab: LabController;
  device: Device;
  record?: DnsRecord;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    lab.setError('');
    const data = new FormData(event.currentTarget);
    try {
      const parsed = dnsRecordSchema.parse({
        name: data.get('name'),
        type: data.get('type'),
        value: data.get('value'),
        ttl: Number(data.get('ttl')),
      });
      if (lab.change((engine) => engine.configureDnsRecord(device.id, parsed, record))) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Registro inválido.');
    }
  }
  return (
    <Modal title={record ? 'Editar registro DNS' : 'Novo registro DNS'} onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Nome DNS
          <input
            name="name"
            defaultValue={record?.name ?? ''}
            maxLength={254}
            required
            placeholder="server.lab"
          />
        </label>
        <div className="form-grid">
          <label>
            Tipo do registro
            <select name="type" defaultValue={record?.type ?? 'A'}>
              <option>A</option>
              <option>AAAA</option>
              <option>CNAME</option>
            </select>
          </label>
          <label>
            TTL (segundos)
            <input name="ttl" type="number" min="0" max="86400" defaultValue={record?.ttl ?? 300} required />
          </label>
        </div>
        <label>
          Valor do registro
          <input name="value" defaultValue={record?.value ?? ''} maxLength={254} required />
        </label>
        {(error || lab.error) && (
          <div className="alert error" role="alert">
            {error || lab.error}
          </div>
        )}
        <button className="button primary">
          <Save size={15} /> Salvar registro
        </button>
      </form>
    </Modal>
  );
}
