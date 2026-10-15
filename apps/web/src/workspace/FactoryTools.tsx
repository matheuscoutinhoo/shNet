import { useEffect, useRef, useState } from 'react';
import {
  preflight,
  fidelityMatrix,
  scenarioSchema,
  factoryScenarios,
  enterpriseScenarios,
  dualAccessScenarios,
  ENGINE_BUILD,
  type ScenarioRunner,
  type Snapshot,
} from '@shlab/engine';
import { Modal } from '../components/Modal';
import { api, download } from '../api';
import type { LabController } from './useLab';
import { IndustrialPanel } from './IndustrialPanel';
import { ConfigurationReview } from './ConfigurationReview';
import { pendingResults, storePendingResult, removePendingResult } from './pending-scenario-results';
import { ScenarioForm } from './ScenarioForm';
import scenarioWorkerUrl from './scenario.worker.ts?execution-worker';
import { workerArtifact } from './worker-artifact';
type Report = ReturnType<ScenarioRunner['report']> & { engineArtifact?: string };
interface ScenarioRun {
  id: string;
  revision: number;
  source_hash: string;
  kind: 'scenario' | 'baseline';
  status: 'running' | 'complete' | 'cancelled' | 'expired';
  verification?: {
    execution: 'client';
    samples: 'samples-v2' | 'legacy-unverified';
    replay?: {
      status: 'matched' | 'mismatch';
      engineContract: string;
      verifiedAt: string;
      reportHash: string;
    };
  };
  created_at: string;
  scenario: Report['scenario'];
  report: Report | null;
  topology?: Snapshot;
  build_identity?: { client: string; server: string; engineContract: string; schemaVersion: number } | null;
}
export function FactoryTools({ lab, onClose }: { lab: LabController; onClose: () => void }) {
  const first =
    lab.engine.state.devices.find((d) => d.interfaces.some((p) => p.ip) && d.type === 'pc') ??
    lab.engine.state.devices.find((d) => d.interfaces.some((p) => p.ip));
  const other = lab.engine.state.devices.find((d) => d.id !== first?.id && d.interfaces.some((p) => p.ip));
  const [tab, setTab] = useState('review'),
    [error, setError] = useState(''),
    [running, setRunning] = useState(false),
    [progress, setProgress] = useState(0);
  const [runs, setRuns] = useState<ScenarioRun[]>([]);
  const [verifying, setVerifying] = useState('');
  const reports = runs.flatMap((r) => (r.report ? [r.report] : []));
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
  const presets = [
    ...factoryScenarios(lab.engine.state),
    ...enterpriseScenarios(lab.engine.state),
    ...dualAccessScenarios(lab.engine.state),
  ];
  const saved = lab.engine.state.scenarios ?? [];
  const worker = useRef<Worker | null>(null);
  const active = useRef<ScenarioRun | null>(null),
    operation = useRef(0);
  const mounted = useRef(true),
    watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endpoint = '/projects/' + lab.projectId + '/scenario-runs';
  const upsert = (row: ScenarioRun) => {
    if (!mounted.current) return;
    setRuns((previous) =>
      [{ ...row, topology: undefined }, ...previous.filter((r) => r.id !== row.id)].slice(0, 50)
    );
  };
  useEffect(() => {
    mounted.current = true;
    void api<ScenarioRun[]>(endpoint + '?limit=50')
      .then(async (rows) => {
        const pending = await pendingResults<ScenarioRun>(lab.projectId).catch((cause) => {
          if (mounted.current)
            setError('Não foi possível consultar os resultados locais: ' + (cause as Error).message);
          return [];
        });
        rows = rows.map((row) =>
          row.status === 'complete' || row.status === 'cancelled'
            ? row
            : (pending.find((x) => x.id === row.id) ?? row)
        );
        for (const row of rows.filter((row) => row.status === 'complete' || row.status === 'cancelled'))
          void removePendingResult(lab.projectId, row.id).catch(() => {});
        if (mounted.current)
          setRuns((previous) => [...previous, ...rows.filter((r) => !previous.some((p) => p.id === r.id))]);
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      });
    return () => {
      mounted.current = false;
      clearTimeout(watchdog.current);
      operation.current++;
      worker.current?.terminate();
      if (active.current)
        void api(endpoint + '/' + active.current.id, {
          method: 'PATCH',
          body: { status: 'cancelled' },
        }).catch(() => {});
    };
  }, [endpoint]);
  const issues = preflight(lab.engine.state);
  const persist = async (row: ScenarioRun, localError = '', generation = operation.current) => {
    try {
      const saved = await api<ScenarioRun>(endpoint + '/' + row.id, {
        method: 'PUT',
        body: { report: row.report },
      });
      upsert(saved);
      await removePendingResult(lab.projectId, row.id).catch(() => {});
      if (mounted.current && generation === operation.current) setError('');
    } catch (e) {
      if (mounted.current && generation === operation.current)
        setError(
          'Resultado calculado, mas não salvo: ' +
            (e as Error).message +
            (localError
              ? '. Armazenamento local indisponível: ' + localError + '. Exporte o ensaio antes de fechar.'
              : '')
        );
    }
  };
  const run = async (baseline = false) => {
    const generation = ++operation.current;
    try {
      const scenario = scenarioSchema.parse(JSON.parse(text));
      if (baseline) {
        scenario.faults = [];
        delete scenario.actions;
        delete scenario.assertions;
        scenario.name += ' — baseline';
      }
      worker.current?.terminate();
      setError('');
      setProgress(0);
      setRunning(true);
      lab.change(() => {}, false);
      await lab.save();
      if (generation !== operation.current) return;
      const artifact = ENGINE_BUILD === 'development' ? undefined : await workerArtifact(scenarioWorkerUrl);
      if (generation !== operation.current) return;
      const row = await api<ScenarioRun>(endpoint, {
        method: 'POST',
        body: {
          revision: lab.getRevision(),
          kind: baseline ? 'baseline' : 'scenario',
          scenario,
          clientBuild: ENGINE_BUILD,
          clientArtifact: artifact,
        },
      });
      if (generation !== operation.current) {
        await api(endpoint + '/' + row.id, { method: 'PATCH', body: { status: 'cancelled' } });
        return;
      }
      active.current = row;
      upsert(row);
      const w = new Worker(scenarioWorkerUrl, { type: 'module' });
      worker.current = w;
      setError('');
      setProgress(0);
      setRunning(true);
      w.onmessage = (event) => {
        if (generation !== operation.current || !mounted.current) return;
        if (event.data.kind === 'progress') setProgress(event.data.progress);
        else {
          clearTimeout(watchdog.current);
          setRunning(false);
          w.terminate();
          worker.current = null;
          if (event.data.kind === 'complete') {
            setProgress(1);
            active.current = null;
            const result = { ...row, topology: undefined, report: event.data.report };
            upsert(result);
            void storePendingResult(lab.projectId, result)
              .then(
                () => '',
                (e) => (e as Error).message
              )
              .then((localError) => persist(result, localError, generation));
          } else {
            active.current = null;
            setError(event.data.message);
            void api<ScenarioRun>(endpoint + '/' + row.id, { method: 'PATCH', body: { status: 'cancelled' } })
              .then(upsert)
              .catch((e) => setError(e.message));
          }
        }
      };
      w.onerror = () => {
        if (generation !== operation.current || !mounted.current) return;
        clearTimeout(watchdog.current);
        setRunning(false);
        setError('Falha ao executar o cenário.');
        w.terminate();
        worker.current = null;
        active.current = null;
        void api<ScenarioRun>(endpoint + '/' + row.id, { method: 'PATCH', body: { status: 'cancelled' } })
          .then(upsert)
          .catch((e) => setError(e.message));
      };
      watchdog.current = setTimeout(() => {
        if (generation !== operation.current || !mounted.current) return;
        operation.current++;
        w.terminate();
        worker.current = null;
        active.current = null;
        setRunning(false);
        setError('Execução excedeu três minutos. Divida o cenário; nenhum relatório parcial será aprovado.');
        void api<ScenarioRun>(endpoint + '/' + row.id, { method: 'PATCH', body: { status: 'cancelled' } })
          .then(upsert)
          .catch((cause) => {
            if (mounted.current) setError((cause as Error).message);
          });
      }, 180000);
      w.postMessage({ snapshot: row.topology, scenario, artifact });
    } catch (e) {
      if (generation !== operation.current || !mounted.current) return;
      setRunning(false);
      setError((e as Error).message);
    }
  };
  return (
    <Modal wide title="Validação de redes e cenários" onClose={onClose}>
      <div className="factory-tools">
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
              Execute em uma cópia isolada da topologia. Compare baseline e falhas; tempos e SLAs são
              virtuais. Até 180 amostras por cenário. Os ensaios guardam a revisão e a topologia de origem no
              laboratório. O baseline conserva fluxos e SLAs e remove falhas, ações agendadas e verificações
              dependentes das intervenções.
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
                Fluxos: origem por nome/ID, destino IPv4/IPv6, vrf e scope opcionais em ICMP/HTTP/Modbus;
                protocolo icmp/http/modbus/dns/dhcp/mqtt/snmp/ntp/syslog, expectativa allow/deny, perda e
                latência máximas. Falhas: atMs, kind device/link/port/service/power, target por nome/ID de
                equipamento ou ID de enlace, up false/true. Porta exige port; serviço exige service
                (dns/dhcp/http/modbus/mqtt/snmp/ntp/syslog); power corta rede e bateria de uma UPS. A
                expectativa deny verifica ausência de resposta dentro do deadline; denyEvidence policy exige
                regra correlacionada. Investigue a causa no relatório. Modbus exige transaction, unit,
                function (3/6/16), address, quantity e values para escrita; expectedRegisters valida os
                valores lidos. requireFinalSuccess exige sucesso na última amostra. DNS exige name e aceita
                expectedAnswers; DHCP exige interface e aceita expectedServer/expectedAddress. MQTT exige
                operation connect/publish; publicações usam QoS 1, topic e payload, com receiver/filter
                opcionais para validar recepção. SNMP exige community/oids e aceita expectedVarbinds. NTP
                exige maxOffsetMs; syslog exige text e aceita severity. DHCP/MQTT/NTP usam equipamentos
                exclusivos e intervalo maior ou igual ao deadline.
              </p>
            </details>
            <details>
              <summary>Editar por formulário</summary>
              <ScenarioForm text={text} setText={setText} snapshot={lab.engine.state} />
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
                    operation.current++;
                    clearTimeout(watchdog.current);
                    worker.current?.terminate();
                    worker.current = null;
                    setRunning(false);
                    const row = active.current;
                    active.current = null;
                    if (row)
                      void api<ScenarioRun>(endpoint + '/' + row.id, {
                        method: 'PATCH',
                        body: { status: 'cancelled' },
                      })
                        .then(upsert)
                        .catch((e) => setError(e.message));
                  }}
                >
                  Cancelar
                </button>
              )}
            </div>
            {running && <p role="status">Executando: {(progress * 100).toFixed(0)}%</p>}
            {error && <p role="alert">{error}</p>}
            {runs.map((row) => (
              <details key={row.id}>
                <summary>
                  {row.scenario.name} · revisão {row.revision} ·{' '}
                  {row.report && row.status === 'complete'
                    ? 'Salvo'
                    : row.report
                      ? 'Resultado não salvo'
                      : row.status === 'cancelled'
                        ? 'Cancelado'
                        : row.status === 'expired'
                          ? 'Expirado; resultado pode ser recuperado'
                          : 'Em execução'}
                </summary>
                <p>
                  {row.kind === 'baseline' ? 'Baseline' : 'Cenário'} ·{' '}
                  {new Date(row.created_at).toLocaleString()} · SHA-256: {row.source_hash}
                </p>
                {row.build_identity && (
                  <details>
                    <summary>Origem e versão do motor</summary>
                    <p>
                      Build do cliente: {row.build_identity.client} · motor do servidor:{' '}
                      {row.build_identity.server} · migrações {row.build_identity.schemaVersion}.
                    </p>
                  </details>
                )}
                <p>
                  Execução no cliente ·{' '}
                  {row.verification?.samples === 'samples-v2'
                    ? 'Métricas recalculadas pela API'
                    : 'Resultado anterior ou local ainda não revalidado'}
                  . O hash identifica a origem; não atesta execução autoritativa.
                </p>
                {row.verification?.replay && (
                  <p role="status">
                    Reexecução no servidor:{' '}
                    {row.verification.replay.status === 'matched'
                      ? 'resultado confirmado'
                      : 'resultado divergente'}
                    . Contrato {row.verification.replay.engineContract} ·{' '}
                    {new Date(row.verification.replay.verifiedAt).toLocaleString()}.
                  </p>
                )}
                <div className="button-row">
                  {row.report && row.status === 'complete' && (
                    <button
                      className="button"
                      disabled={!!verifying}
                      onClick={() => {
                        setVerifying(row.id);
                        setError('');
                        void api<ScenarioRun>(endpoint + '/' + row.id + '/verify', { method: 'POST' })
                          .then(upsert)
                          .catch((e) => setError(e.message))
                          .finally(() => setVerifying(''));
                      }}
                    >
                      {verifying === row.id ? 'Verificando…' : 'Verificar no servidor'}
                    </button>
                  )}
                  {row.report && (
                    <button
                      className="button"
                      onClick={() => download(row.scenario.name + '-resultado', row)}
                    >
                      Exportar ensaio
                    </button>
                  )}
                  {row.report && row.status !== 'complete' && (
                    <button className="button" onClick={() => void persist(row)}>
                      Tentar salvar resultado
                    </button>
                  )}
                  <button
                    className="button"
                    onClick={() =>
                      void api<ScenarioRun>(endpoint + '/' + row.id)
                        .then((run) => download(row.scenario.name + '-origem', run.topology))
                        .catch((e) => setError(e.message))
                    }
                  >
                    Exportar topologia de origem
                  </button>
                  <button
                    className="button"
                    disabled={running}
                    onClick={() =>
                      void api(endpoint + '/' + row.id, { method: 'DELETE' })
                        .then(async () => {
                          await removePendingResult(lab.projectId, row.id).catch(() => {});
                          setRuns((previous) => previous.filter((r) => r.id !== row.id));
                        })
                        .catch((e) => setError(e.message))
                    }
                  >
                    Excluir ensaio
                  </button>
                </div>
                {row.report && (
                  <>
                    <p>
                      {row.report.samples.filter((s) => s.status === 'failed').length} amostras sem sucesso.
                      Recuperação observada com tentativas a cada {row.scenario.intervalMs} ms; a resposta
                      utiliza seu timestamp virtual. Percentis e jitter usam respostas bem-sucedidas.
                    </p>
                    {row.report.faults.length > 0 && (
                      <details>
                        <summary>Falhas e recuperação observada</summary>
                        <ul>
                          {row.report.faults.flatMap((f, index) =>
                            f.recovery.map((v) => (
                              <li key={index + v.flow}>
                                {f.atMs} ms · {f.target} · {v.flow}:{' '}
                                {v.recoveryMs === null
                                  ? 'sem recuperação observada'
                                  : v.recoveryMs.toFixed(3) + ' ms após a falha'}
                                {v.recoveryResponseAtMs !== undefined && v.recoveryResponseAtMs !== null
                                  ? ' · resposta em ' + v.recoveryResponseAtMs.toFixed(3) + ' ms'
                                  : ''}
                                {' · tentativas a cada ' + v.resolutionMs + ' ms'}
                              </li>
                            ))
                          )}
                        </ul>
                      </details>
                    )}
                    {row.report.actions && (
                      <ul>
                        {row.report.actions.map((a, i) => (
                          <li key={i}>
                            {a.atMs} ms · {a.kind} {a.checkpoint} · época {a.epoch} · relógio {a.beforeClock}{' '}
                            → {a.afterClock} ms · SHA-256 {a.snapshotHash}
                          </li>
                        ))}
                      </ul>
                    )}
                    {row.report.assertions && (
                      <ul>
                        {row.report.assertions.map((a) => (
                          <li key={a.name}>
                            {a.atMs} ms · {a.name}: {a.passed ? 'Aprovado' : 'Falhou'} · observado{' '}
                            {a.observed} · época {a.epoch}
                          </li>
                        ))}
                      </ul>
                    )}
                    <ul>
                      {row.report.samples
                        .filter((s) => s.status === 'failed')
                        .slice(0, 10)
                        .map((s) => (
                          <li key={s.flow + s.atMs}>
                            {s.flow} · {s.atMs} ms: {s.reason ?? 'Sem resposta'}
                            {s.evidence && (
                              <>
                                {' '}
                                ·{' '}
                                {
                                  {
                                    policy: 'Bloqueio por política',
                                    link: 'Falha de enlace/interface',
                                    transport: 'Falha de transporte',
                                    response: 'Resposta divergente',
                                    timeout: 'Sem resposta no deadline',
                                    unknown: 'Causa indeterminada',
                                  }[s.evidence.cause]
                                }
                                {s.evidence.path.length > 0 && (
                                  <> · Equipamentos observados: {s.evidence.path.join(', ')}</>
                                )}
                                {s.evidence.hops?.length ? (
                                  <details>
                                    <summary>Sequência de eventos de transporte</summary>
                                    <ol>
                                      {s.evidence.hops.map((h) => (
                                        <li key={h.id}>
                                          {h.atMs.toFixed(3)} ms · {h.device} {h.port ?? ''} ·{' '}
                                          {h.direction === 'sent' ? 'envio' : 'recepção'}
                                        </li>
                                      ))}
                                    </ol>
                                  </details>
                                ) : null}
                                {s.evidence.truncated && (
                                  <>
                                    {' '}
                                    · Evidência limitada pela retenção; consulte a origem e repita com captura
                                    adequada.
                                  </>
                                )}
                                {s.evidence.events.map((e) => (
                                  <p key={e.id}>
                                    {e.atMs.toFixed(3)} ms · {e.device}: {e.reason}
                                  </p>
                                ))}
                              </>
                            )}
                          </li>
                        ))}
                    </ul>
                  </>
                )}
              </details>
            ))}
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
      </div>
    </Modal>
  );
}
