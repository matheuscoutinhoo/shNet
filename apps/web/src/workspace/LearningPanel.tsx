import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, X } from 'lucide-react';
import {
  validateChallenge,
  networkTutorial,
  type ChallengeDefinition,
  type ChallengeRecord,
  type LearningPredicate,
  type LearningProgress,
  type TutorialProgress,
} from '@shlab/engine';
import { api, type Project } from '../api';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';

type ChallengeState = { challenge: ChallengeRecord | null; progress: LearningProgress | null };
const labels: Record<LearningPredicate['kind'], string> = {
  devices: 'Quantidade de equipamentos',
  linked: 'Enlace ativo',
  ipv4: 'Endereço IPv4',
  vlan: 'Participação em VLAN',
  dhcp: 'Concessão DHCP',
  ping: 'Ping IPv4 / IPv6',
  'tcp-echo': 'TCP echo',
  http: 'Resposta HTTP',
  dns: 'Resposta DNS',
  route: 'Rota instalada',
};
function defaultPredicate(kind: LearningPredicate['kind'], lab: LabController): LearningPredicate {
  const d = lab.engine.state.devices.find((entry) => entry.type === 'pc') ?? lab.engine.state.devices[0],
    p = d?.interfaces[0];
  const endpoint = { device: d?.id ?? '', port: p?.id ?? '' },
    target =
      lab.engine.state.devices
        .flatMap((entry) => entry.interfaces)
        .find((entry) => entry.ip && entry.ip !== p?.ip)?.ip ?? '192.168.10.20';
  switch (kind) {
    case 'devices':
      return { kind, type: 'pc', minimum: 2 };
    case 'linked': {
      const peer = lab.engine.state.devices.find((entry) => entry.id !== d?.id);
      return { kind, ...endpoint, peer: peer?.id ?? '', peerPort: peer?.interfaces[0]?.id ?? '' };
    }
    case 'ipv4':
      return { kind, ...endpoint, address: p?.ip ?? '192.168.10.10', prefix: p?.prefix ?? 24 };
    case 'vlan':
      return { kind, ...endpoint, vlan: 1, mode: 'access' };
    case 'dhcp':
      return { kind, ...endpoint };
    case 'ping':
      return { kind, device: endpoint.device, target, expect: 'success' };
    case 'tcp-echo':
      return { kind, device: endpoint.device, target, destinationPort: 7, text: 'Aprendi TCP.' };
    case 'http':
      return { kind, device: endpoint.device, target, destinationPort: 80, path: '/', contains: 'HTTP' };
    case 'dns':
      return { kind, device: endpoint.device, name: 'lab.test', type: 'A', value: target, secure: false };
    case 'route':
      return { kind, device: endpoint.device, network: '192.168.20.0', prefix: 24, protocol: 'static' };
  }
}
function PredicateFields({
  value,
  lab,
  onChange,
}: {
  value: LearningPredicate;
  lab: LabController;
  onChange: (value: LearningPredicate) => void;
}) {
  const fields = value as unknown as Record<string, unknown>;
  const update = (key: string, entry: unknown) => onChange({ ...value, [key]: entry } as LearningPredicate);
  const device = lab.engine.state.devices.find((d) => d.id === fields.device);
  return (
    <div className="learning-fields">
      {Object.entries(fields)
        .filter(([key]) => key !== 'kind')
        .map(([key, entry]) => {
          if (['device', 'peer'].includes(key))
            return (
              <label key={key}>
                {key === 'peer' ? 'Equipamento remoto' : 'Equipamento'}
                <select
                  value={String(entry)}
                  onChange={(event) => {
                    const id = event.target.value,
                      next = { ...fields, [key]: id };
                    if (key === 'device' && 'port' in next)
                      next.port = lab.engine.device(id).interfaces[0]?.id ?? '';
                    if (key === 'peer') next.peerPort = lab.engine.device(id).interfaces[0]?.id ?? '';
                    onChange(next as unknown as LearningPredicate);
                  }}
                >
                  {lab.engine.state.devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.hostname}
                    </option>
                  ))}
                </select>
              </label>
            );
          if (['port', 'peerPort', 'scope'].includes(key)) {
            const owner =
              key === 'peerPort' ? lab.engine.state.devices.find((d) => d.id === fields.peer) : device;
            return (
              <label key={key}>
                Interface ({key})
                <select value={String(entry)} onChange={(event) => update(key, event.target.value)}>
                  {owner?.interfaces.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          const options =
            key === 'type'
              ? value.kind === 'devices'
                ? ['pc', 'server', 'switch', 'router']
                : ['A', 'AAAA', 'CNAME']
              : key === 'mode'
                ? ['access', 'trunk']
                : key === 'protocol'
                  ? ['static', 'rip', 'ospf', 'bgp']
                  : key === 'expect'
                    ? ['success', 'unreachable']
                    : undefined;
          return (
            <label key={key}>
              {key}
              {options ? (
                <select value={String(entry)} onChange={(event) => update(key, event.target.value)}>
                  {options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              ) : typeof entry === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={entry}
                  onChange={(event) => update(key, event.target.checked)}
                />
              ) : (
                <input
                  type={typeof entry === 'number' ? 'number' : 'text'}
                  value={String(entry)}
                  onChange={(event) =>
                    update(key, typeof entry === 'number' ? Number(event.target.value) : event.target.value)
                  }
                />
              )}
            </label>
          );
        })}
    </div>
  );
}
export function LearningPanel({
  project,
  lab,
  onClose,
}: {
  project: Project;
  lab: LabController;
  onClose: () => void;
}) {
  const [stored, setStored] = useState<ChallengeState>({ challenge: null, progress: null }),
    [loaded, setLoaded] = useState(false),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [json, setJson] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChallengeDefinition>({
    schemaVersion: 1,
    name: 'Meu desafio de rede',
    description: 'Configure a topologia para cumprir os objetivos.',
    objectives: [
      {
        id: 'objetivo-1',
        label: 'Dois PCs ligados',
        hint: 'Use o catálogo de equipamentos.',
        weight: 1,
        predicate: { kind: 'devices', type: 'pc', minimum: 2 },
      },
    ],
  });
  useEffect(() => {
    void api<ChallengeState>('/projects/' + project.id + '/challenge')
      .then((data) => {
        setStored(data);
        if (data.challenge) setDraft(data.challenge.definition);
        else setEditing(true);
        setLoaded(true);
      })
      .catch((cause) => setError(cause.message));
  }, [project.id]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    lab.setPlaying(false);
    try {
      await lab.save();
      await work();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revise = (index: number, patch: Partial<ChallengeDefinition['objectives'][number]>) =>
    setDraft({
      ...draft,
      objectives: draft.objectives.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  return (
    <Modal title="Desafio personalizado" onClose={onClose} wide>
      <p>
        Defina objetivos e verifique a rede com tráfego novo. A definição salva também guarda a topologia
        inicial para reiniciar a prática.
      </p>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {!loaded && !error && <p role="status">Carregando desafio…</p>}
      {loaded && (
        <>
          <div className="button-row learning-actions">
            <button
              className="button"
              aria-pressed={!editing}
              onClick={() => setEditing(false)}
              disabled={!stored.challenge}
            >
              Praticar
            </button>
            <button className="button" aria-pressed={editing} onClick={() => setEditing(true)}>
              Editar objetivos
            </button>
          </div>
          {editing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const definition = validateChallenge(
                    json === null ? draft : JSON.parse(json),
                    lab.engine.snapshot()
                  );
                  const data = await api<ChallengeState>('/projects/' + project.id + '/challenge', {
                    method: 'PUT',
                    body: {
                      revision: stored.challenge?.revision ?? 0,
                      projectRevision: lab.getRevision(),
                      definition,
                    },
                  });
                  setStored(data);
                  setDraft(definition);
                  setJson(null);
                  setEditing(false);
                });
              }}
            >
              <label>
                Nome do desafio
                <input
                  required
                  maxLength={100}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label>
                Descrição
                <textarea
                  required
                  maxLength={2000}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              {json === null ? (
                draft.objectives.map((item, index) => (
                  <fieldset key={item.id} className="learning-objective">
                    <legend>Objetivo {index + 1}</legend>
                    <label>
                      Descrição do objetivo
                      <input
                        required
                        value={item.label}
                        maxLength={180}
                        onChange={(event) => revise(index, { label: event.target.value })}
                      />
                    </label>
                    <div className="learning-fields">
                      <label>
                        Verificação
                        <select
                          aria-label={'Verificação ' + (index + 1)}
                          value={item.predicate.kind}
                          onChange={(event) =>
                            revise(index, {
                              predicate: defaultPredicate(
                                event.target.value as LearningPredicate['kind'],
                                lab
                              ),
                            })
                          }
                        >
                          {Object.entries(labels).map(([id, label]) => (
                            <option key={id} value={id}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Peso
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={item.weight}
                          onChange={(event) => revise(index, { weight: Number(event.target.value) })}
                        />
                      </label>
                    </div>
                    <PredicateFields
                      value={item.predicate}
                      lab={lab}
                      onChange={(predicate) => revise(index, { predicate })}
                    />
                    <label>
                      Dica
                      <input
                        maxLength={1000}
                        value={item.hint}
                        onChange={(event) => revise(index, { hint: event.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      className="text-button"
                      disabled={draft.objectives.length === 1}
                      onClick={() =>
                        setDraft({ ...draft, objectives: draft.objectives.filter((_, i) => i !== index) })
                      }
                    >
                      Remover objetivo
                    </button>
                  </fieldset>
                ))
              ) : (
                <label>
                  Definição JSON
                  <textarea
                    className="code-input"
                    rows={16}
                    value={json}
                    onChange={(event) => setJson(event.target.value)}
                  />
                </label>
              )}
              <div className="button-row learning-actions">
                <button
                  type="button"
                  className="button"
                  disabled={draft.objectives.length >= 16 || json !== null}
                  onClick={() => {
                    let n = 1;
                    while (draft.objectives.some((o) => o.id === 'objetivo-' + n)) n++;
                    setDraft({
                      ...draft,
                      objectives: [
                        ...draft.objectives,
                        {
                          id: 'objetivo-' + n,
                          label: 'Novo objetivo',
                          hint: '',
                          weight: 1,
                          predicate: defaultPredicate('ping', lab),
                        },
                      ],
                    });
                  }}
                >
                  Adicionar objetivo
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    if (json === null) setJson(JSON.stringify(draft, null, 2));
                    else {
                      try {
                        setDraft(validateChallenge(JSON.parse(json), lab.engine.snapshot()));
                        setJson(null);
                        setError('');
                      } catch (cause) {
                        setError((cause as Error).message);
                      }
                    }
                  }}
                >
                  {json === null ? 'Importar / editar JSON' : 'Voltar ao formulário'}
                </button>
                <button className="button primary" disabled={busy}>
                  {busy ? 'Salvando…' : 'Salvar desafio e estado inicial'}
                </button>
              </div>
            </form>
          ) : (
            stored.challenge && (
              <>
                <h3>{stored.challenge.definition.name}</h3>
                <p>{stored.challenge.definition.description}</p>
                <ol className="lab-task-list">
                  {stored.challenge.definition.objectives.map((item) => {
                    const result = stored.progress?.result.tasks.find((t) => t.id === item.id);
                    return (
                      <li key={item.id}>
                        {result?.passed ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                        <div>
                          <strong>{item.label}</strong>
                          {result && <p>{result.evidence}</p>}
                          {item.hint && (
                            <details>
                              <summary>Dica</summary>
                              {item.hint}
                            </details>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {stored.progress && (
                  <p role="status">
                    Pontuação: {stored.progress.result.score}/100 · Melhor resultado:{' '}
                    {stored.progress.best_score}/100 {stored.progress.completed && '· Concluído'}
                    {(stored.progress.revision !== lab.revision || lab.saveStatus !== 'Salvo') &&
                      ' · Alterações ainda não avaliadas'}
                  </p>
                )}
                <div className="button-row learning-actions">
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const progress = await api<LearningProgress>(
                          '/projects/' + project.id + '/challenge/evaluate',
                          { method: 'POST', body: { revision: stored.challenge!.revision } }
                        );
                        setStored({ ...stored, progress });
                      })
                    }
                  >
                    {busy ? 'Verificando…' : 'Verificar objetivos'}
                  </button>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const next = await api<Project>('/projects/' + project.id + '/challenge/reset', {
                          method: 'POST',
                          body: { revision: stored.challenge!.revision, projectRevision: lab.getRevision() },
                        });
                        lab.acceptProject(next);
                      })
                    }
                  >
                    Reiniciar topologia do desafio
                  </button>
                </div>
                <p className="muted">
                  Reiniciar restaura equipamentos e configurações do estado inicial. Editar os objetivos
                  inicia uma nova avaliação e zera os pontos deste desafio.
                </p>
              </>
            )
          )}
        </>
      )}
    </Modal>
  );
}
export function TutorialPanel({
  project,
  lab,
  onClose,
  onNavigate,
}: {
  project: Project;
  lab: LabController;
  onClose: () => void;
  onNavigate: (panel: string) => void;
}) {
  const [progress, setProgress] = useState<TutorialProgress | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [hint, setHint] = useState(false);
  useEffect(() => {
    void api<TutorialProgress>('/projects/' + project.id + '/tutorial')
      .then(setProgress)
      .catch((cause) => setError(cause.message));
  }, [project.id]);
  const step = networkTutorial[progress?.step ?? 0];
  return (
    <aside className="tutorial-card" aria-label="Tutorial interativo">
      <div className="modal-head">
        <h2>Tutorial de redes</h2>
        <button className="icon-button" aria-label="Fechar tutorial" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {progress ? (
        progress.complete ? (
          <p role="status">
            Tutorial concluído! Você montou uma LAN, verificou ARP/ICMP e transmitiu dados por TCP. 100
            pontos.
          </p>
        ) : (
          <>
            <progress max={progress.total} value={progress.step} />
            <p className="muted">
              Etapa {progress.step + 1} de {progress.total}
            </p>
            <h3>{step.title}</h3>
            <p>{step.instruction}</p>
            <button className="text-button" onClick={() => setHint(!hint)}>
              {hint ? 'Ocultar dica' : 'Mostrar dica'}
            </button>
            {hint && <p>{step.hint}</p>}
            {progress.result && !progress.result.complete && (
              <p role="status">
                {progress.result.tasks
                  .filter((t) => !t.passed)
                  .map((t) => t.evidence)
                  .join(' ')}
              </p>
            )}
            <div className="button-row learning-actions">
              <button className="button" onClick={() => onNavigate(step.panel)}>
                Abrir área da etapa
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  lab.setPlaying(false);
                  try {
                    await lab.save();
                    setProgress(
                      await api<TutorialProgress>('/projects/' + project.id + '/tutorial/check', {
                        method: 'POST',
                        body: { step: progress.step },
                      })
                    );
                    setHint(false);
                  } catch (cause) {
                    setError((cause as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Verificando…' : 'Verificar etapa'}
              </button>
            </div>
          </>
        )
      ) : (
        <p>Carregando etapas…</p>
      )}
    </aside>
  );
}
