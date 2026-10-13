import { useEffect, useRef, useState } from 'react';
import {
  preflight,
  fidelityMatrix,
  scenarioSchema,
  factoryScenarios,
  type ScenarioRunner,
} from '@shlab/engine';
import { Modal } from '../components/Modal';
import { download } from '../api';
import type { LabController } from './useLab';
import { IndustrialPanel } from './IndustrialPanel';
import { ConfigurationReview } from './ConfigurationReview';
type Report = ReturnType<ScenarioRunner['report']>;
export function FactoryTools({ lab, onClose }: { lab: LabController; onClose: () => void }) {
  const first =
    lab.engine.state.devices.find((d) => d.interfaces.some((p) => p.ip) && d.type === 'pc') ??
    lab.engine.state.devices.find((d) => d.interfaces.some((p) => p.ip));
  const other = lab.engine.state.devices.find((d) => d.id !== first?.id && d.interfaces.some((p) => p.ip));
  const [tab, setTab] = useState('review'),
    [error, setError] = useState(''),
    [running, setRunning] = useState(false),
    [progress, setProgress] = useState(0);
  const [reports, setReports] = useState<Report[]>([]);
  const [text, setText] = useState(() =>
    JSON.stringify(
      {
        name: 'Disponibilidade da fábrica',
        durationMs: 10000,
        intervalMs: 1000,
        deadlineMs: 1000,
        flows: [
          {
            name: 'Fluxo principal',
            source: first?.hostname ?? '',
            target: other?.interfaces.find((p) => p.ip)?.ip ?? '192.0.2.1',
            protocol: 'icmp',
            port: 80,
            expect: 'allow',
            maxLossPercent: 0,
          },
        ],
        faults: [],
      },
      null,
      2
    )
  );
  const presets = factoryScenarios(lab.engine.state);
  const saved = lab.engine.state.scenarios ?? [];
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  const issues = preflight(lab.engine.state);
  const run = (baseline = false) => {
    try {
      const scenario = scenarioSchema.parse(JSON.parse(text));
      if (baseline) {
        scenario.faults = [];
        scenario.name += ' — baseline';
      }
      worker.current?.terminate();
      const w = new Worker(new URL('./scenario.worker.ts', import.meta.url), { type: 'module' });
      worker.current = w;
      setError('');
      setProgress(0);
      setRunning(true);
      w.onmessage = (event) => {
        if (event.data.kind === 'progress') setProgress(event.data.progress);
        else {
          setRunning(false);
          w.terminate();
          worker.current = null;
          if (event.data.kind === 'complete') {
            setProgress(1);
            setReports((previous) => [...previous, event.data.report].slice(-10));
          } else setError(event.data.message);
        }
      };
      w.onerror = () => {
        setRunning(false);
        setError('Falha ao executar o cenário.');
        w.terminate();
        worker.current = null;
      };
      w.postMessage({ snapshot: lab.engine.snapshot(), scenario });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal wide title="Validação da fábrica" onClose={onClose}>
      {lab.error && <p role="alert">{lab.error}</p>}
      <div className="button-row">
        <button className="button" aria-pressed={tab === 'review'} onClick={() => setTab('review')}>
          Verificar topologia
        </button>
        <button className="button" aria-pressed={tab === 'scenarios'} onClick={() => setTab('scenarios')}>
          Cenários e SLA
        </button>
        <button className="button" aria-pressed={tab === 'fidelity'} onClick={() => setTab('fidelity')}>
          Capacidades do modelo
        </button>
        <button className="button" aria-pressed={tab === 'industrial'} onClick={() => setTab('industrial')}>
          PLC / HMI
        </button>
        <button
          className="button"
          aria-pressed={tab === 'configuration'}
          onClick={() => setTab('configuration')}
        >
          Configuração e revisão
        </button>
      </div>
      {tab === 'review' && (
        <>
          <p>
            {issues.filter((i) => i.severity === 'error').length} erros ·{' '}
            {issues.filter((i) => i.severity === 'warning').length} avisos. A verificação estática não
            comprova disponibilidade ou bloqueio de tráfego.
          </p>
          <button className="button" onClick={() => download(lab.name + '-preflight', issues)}>
            Exportar revisão
          </button>
          {!issues.length && <p>Nenhum problema detectado pelas regras disponíveis.</p>}
          {issues.map((i, n) => (
            <details key={i.code + n}>
              <summary>
                {i.severity.toUpperCase()} · {i.message}
              </summary>
              <p>{i.recommendation}</p>
            </details>
          ))}
        </>
      )}
      {tab === 'fidelity' && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Recurso</th>
                <th>Disponibilidade</th>
                <th>Limites</th>
              </tr>
            </thead>
            <tbody>
              {fidelityMatrix.map((row) => (
                <tr key={row.feature}>
                  <td>{row.feature}</td>
                  <td>{row.status}</td>
                  <td>{row.limit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'industrial' && <IndustrialPanel lab={lab} />}
      {tab === 'configuration' && <ConfigurationReview lab={lab} />}
      {tab === 'scenarios' && (
        <>
          <p>
            Execute em uma cópia isolada da topologia. Compare baseline e falhas; tempos e SLAs são virtuais.
            Até 180 amostras por cenário.
          </p>
          <label>
            Carregar cenário
            <select
              aria-label="Carregar cenário"
              defaultValue=""
              disabled={running}
              onChange={(e) => {
                const [kind, index] = e.target.value.split(':');
                const scenario = (kind === 'saved' ? saved : presets)[Number(index)];
                if (scenario) setText(JSON.stringify(scenario, null, 2));
              }}
            >
              <option value="">Selecione um cenário</option>
              {saved.map((s, i) => (
                <option key={'saved' + i} value={'saved:' + i}>
                  Salvo: {s.name}
                </option>
              ))}
              {presets.map((s, i) => (
                <option key={'preset' + i} value={'preset:' + i}>
                  Modelo: {s.name}
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>Formato dos cenários</summary>
            <p>
              Fluxos: origem por nome/ID, destino IPv4, protocolo icmp/http/modbus, expectativa allow/deny,
              perda e latência máximas. Falhas: atMs, kind device/link, target por nome/ID de equipamento ou
              ID de enlace, up false/true. A expectativa deny verifica ausência de resposta; investigue a
              causa no relatório. Modbus exige transaction, unit, function (3/6/16), address, quantity e
              values para escrita; expectedRegisters valida os valores lidos. requireFinalSuccess exige
              sucesso na última amostra.
            </p>
          </details>
          <label>
            Definição do cenário
            <textarea
              aria-label="Definição do cenário"
              rows={16}
              value={text}
              disabled={running}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="button-row">
            <button
              className="button"
              disabled={running}
              onClick={() => {
                try {
                  const scenario = scenarioSchema.parse(JSON.parse(text));
                  const previous = saved.filter((s) => s.name !== scenario.name);
                  if (previous.length >= 32) throw new Error('Limite de 32 cenários salvos.');
                  lab.change((e) => {
                    e.state.scenarios = [...previous, scenario];
                  });
                  setError('');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Salvar cenário no laboratório
            </button>
            <button className="button primary" disabled={running} onClick={() => run()}>
              Executar cenário
            </button>
            <button className="button" disabled={running} onClick={() => run(true)}>
              Executar baseline
            </button>
            <button
              className="button"
              disabled={running}
              onClick={() => {
                try {
                  download('cenario', scenarioSchema.parse(JSON.parse(text)));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Exportar definição
            </button>
            {running && (
              <button
                className="button"
                onClick={() => {
                  worker.current?.terminate();
                  worker.current = null;
                  setRunning(false);
                }}
              >
                Cancelar
              </button>
            )}
          </div>
          {running && <p role="status">Executando: {(progress * 100).toFixed(0)}%</p>}
          {error && <p role="alert">{error}</p>}
          {reports.length > 0 && (
            <>
              <button className="button" onClick={() => download(lab.name + '-cenarios', reports)}>
                Exportar resultados
              </button>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Cenário / fluxo</th>
                      <th>Resultado</th>
                      <th>Perda</th>
                      <th>p95 / p99</th>
                      <th>Jitter p95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.flatMap((r, n) =>
                      r.flows.map((f) => (
                        <tr key={n + f.name}>
                          <td>
                            {r.name} / {f.name}
                          </td>
                          <td>{f.passed ? 'Aprovado' : 'Reprovado'}</td>
                          <td>{f.lossPercent.toFixed(1)}%</td>
                          <td>
                            {f.p95Ms?.toFixed(2) ?? '—'} / {f.p99Ms?.toFixed(2) ?? '—'} ms
                          </td>
                          <td>{f.jitterP95Ms?.toFixed(2) ?? '—'} ms</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
