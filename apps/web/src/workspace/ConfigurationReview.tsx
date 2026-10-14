import { useRef, useState } from 'react';
import {
  configurationDiff,
  validateSnapshot,
  preflight,
  applyConfigurationPatch,
  SimulationEngine,
  type Snapshot,
  type ConfigurationPatch,
} from '@shlab/engine';
import { download } from '../api';
import type { LabController } from './useLab';
import { normalizeBulkConfiguration } from './configuration-bulk';
export function ConfigurationReview({ lab }: { lab: LabController }) {
  const [candidate, setCandidate] = useState<Snapshot | null>(null),
    [error, setError] = useState(''),
    [bulk, setBulk] = useState('');
  const base = useRef<Snapshot | null>(null),
    patch = useRef<ConfigurationPatch | null>(null);
  const changes = candidate ? configurationDiff(lab.engine.state, candidate) : [];
  const inspect = (value: unknown) => {
    try {
      setCandidate(validateSnapshot(value));
      base.current = lab.engine.snapshot();
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
            setCandidate(null);
            patch.current = null;
            if (file.size > 16 * 1024 * 1024) {
              setError('Arquivo excede 16 MiB.');
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
            '[{"device":"PC-ERP","ports":[{"port":"p0","ip":"10.20.10.15","prefix":24,"gateway":"10.20.10.1"}]}]'
          }
        />
      </label>
      <button
        className="button"
        onClick={() => {
          try {
            lab.change(() => {}, false);
            const proposed = normalizeBulkConfiguration(JSON.parse(bulk), lab.engine.state);
            const preview = new SimulationEngine(lab.engine.snapshot());
            applyConfigurationPatch(preview, proposed);
            patch.current = proposed;
            inspect(preview.snapshot());
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
          <p>
            {patch.current
              ? 'O lote aplica apenas os campos revisados ao estado atual. A simulação foi pausada para a revisão.'
              : 'A importação restaura a topologia inteira, incluindo relógio, filas e captura do arquivo.'}
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
                if (base.current && configurationDiff(base.current, lab.engine.state).length) {
                  setError('A configuração mudou durante a revisão. Prepare a proposta novamente.');
                  return;
                }
                const applied = patch.current
                  ? lab.change((engine) => {
                      applyConfigurationPatch(engine, patch.current!);
                      return true;
                    })
                  : lab.restore(candidate);
                if (applied) setCandidate(null);
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
