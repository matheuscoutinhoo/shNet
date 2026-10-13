import { useState } from 'react';
import { configurationDiff, validateSnapshot, preflight, type Snapshot } from '@shlab/engine';
import { download } from '../api';
import type { LabController } from './useLab';
export function ConfigurationReview({ lab }: { lab: LabController }) {
  const [candidate, setCandidate] = useState<Snapshot | null>(null),
    [error, setError] = useState(''),
    [bulk, setBulk] = useState('');
  const changes = candidate ? configurationDiff(lab.engine.state, candidate) : [];
  const inspect = (value: unknown) => {
    try {
      setCandidate(validateSnapshot(value));
      setError('');
    } catch (e) {
      setError((e as Error).message);
      setCandidate(null);
    }
  };
  return (
    <>
      <p>
        Revise uma topologia importada ou prepare alterações em lote. A aplicação valida a proposta antes de
        permitir sua aplicação; você pode desfazer a mudança.
      </p>
      <label>
        Comparar arquivo de topologia
        <input
          type="file"
          accept=".json"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) {
              setError('Arquivo excede 5 MiB.');
              return;
            }
            try {
              inspect(JSON.parse(await file.text()));
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      </label>
      <label>
        Configuração em lote
        <textarea
          rows={6}
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          placeholder={
            '[{"hostname":"PC-ERP","port":"p0","ip":"10.20.10.15","prefix":24,"gateway":"10.20.10.1"}]'
          }
        />
      </label>
      <button
        className="button"
        onClick={() => {
          try {
            const entries: unknown = JSON.parse(bulk);
            if (!Array.isArray(entries) || entries.length > 2000)
              throw new Error('Informe uma lista de até 2000 alterações.');
            const snapshot = lab.engine.snapshot();
            for (const entry of entries) {
              if (
                !entry ||
                typeof entry !== 'object' ||
                Object.keys(entry).some(
                  (key) =>
                    !['hostname', 'port', 'ip', 'prefix', 'gateway', 'dns', 'description'].includes(key)
                )
              )
                throw new Error('Campos permitidos: hostname, port, ip, prefix, gateway, dns, description.');
              const d = snapshot.devices.find((d) => d.hostname === entry.hostname),
                p = d?.interfaces.find((p) => p.id === entry.port || p.name === entry.port);
              if (!d || !p)
                throw new Error('Equipamento/interface inexistente: ' + entry.hostname + '/' + entry.port);
              if (p.dhcp || p.ipv4Mode === 'dhcp')
                throw new Error('Desabilite DHCP antes de editar o endereço: ' + d.hostname);
              for (const key of ['ip', 'prefix', 'dns', 'description'] as const)
                if (key in entry) Object.assign(p, { [key]: entry[key] });
              if ('gateway' in entry) {
                if (d.type === 'pc' || d.type === 'server') d.gateway = entry.gateway;
                else p.gateway = entry.gateway;
              }
              d.arpTable = [];
              d.pending = [];
              delete d.arpResolutions;
              snapshot.queue = snapshot.queue.filter(
                (q) => q.action.kind !== 'arp-timeout' || q.action.device !== d.id
              );
            }
            inspect(snapshot);
          } catch (e) {
            setError((e as Error).message);
            setCandidate(null);
          }
        }}
      >
        Preparar alterações
      </button>
      {error && <p role="alert">{error}</p>}
      {candidate && (
        <>
          <p>
            {changes.length} objetos com configuração alterada ·{' '}
            {preflight(candidate).filter((i) => i.severity === 'warning').length} avisos de revisão. Tráfego e
            contadores não entram no diff.
          </p>
          {changes.map((c) => (
            <details key={c.kind + c.id}>
              <summary>
                {c.action} · {c.name}
              </summary>
              <pre>{JSON.stringify({ antes: c.before, depois: c.after }, null, 2)}</pre>
            </details>
          ))}
          <div className="button-row">
            <button className="button" onClick={() => download(lab.name + '-revisao', changes)}>
              Exportar revisão
            </button>
            <button
              className="button primary"
              onClick={() => {
                lab.restore(candidate);
                setCandidate(null);
              }}
            >
              Aplicar proposta
            </button>
          </div>
        </>
      )}
    </>
  );
}
