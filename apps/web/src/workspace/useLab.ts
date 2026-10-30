import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SimulationEngine,
  validateSnapshot,
  applySimulationDelta,
  canonicalScenarioJson,
  materializeMark,
  type SimulationDelta,
  type StateMark,
} from '@shlab/engine';
import { api, ApiError, type Project } from '../api';
import { SnapshotHistory } from './snapshot-history';
import { projectDrafts, storeProjectDraft, removeProjectDraft, type ProjectDraft } from './project-drafts';
import simulationWorkerUrl from './simulation.worker.ts?execution-worker';
let tabSession = '';
export function useLab(project: Project, onExpired: () => void, userId = project.user_id ?? '') {
  const [engine] = useState(() => new SimulationEngine(project.topology));
  const [tick, setTick] = useState(0),
    [simulationRevision, setSimulationRevision] = useState(0),
    [name, setNameState] = useState(project.name),
    [error, setError] = useState(''),
    [saveStatus, setSaveStatus] = useState('Salvo'),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [playbackMode, setPlaybackMode] = useState<'simulation' | 'realtime'>('simulation'),
    [playbackMetrics, setPlaybackMetrics] = useState({ lagMs: 0, eventsPerSecond: 0, ready: false });
  const snapshots = useRef(new SnapshotHistory(project.topology.devices.length > 200 ? 5 : 30)),
    editVersion = useRef(0),
    savedVersion = useRef(0),
    revision = useRef(project.revision),
    nameRef = useRef(name),
    saving = useRef<Promise<void> | null>(null),
    conflict = useRef(false),
    saveError = useRef<string | null>(null);
  const epoch = useRef(0),
    draftSaving = useRef<Promise<void> | null>(null),
    lastDraftVersion = useRef(-1);
  const [drafts, setDrafts] = useState<ProjectDraft[]>([]),
    [draftWarning, setDraftWarning] = useState(''),
    [conflicted, setConflicted] = useState(false),
    [liveStatus, setLiveStatus] = useState('Conectando');
  const [session] = useState(() => (tabSession ||= crypto.randomUUID()));
  const recoveredDraft = useRef<ProjectDraft | null>(null);
  const owner = userId,
    draftKey = owner + '/' + project.id + '/' + session;
  const persistDraft = useCallback(
    async (archive = false) => {
      if (draftSaving.current) await draftSaving.current;
      if (
        editVersion.current === savedVersion.current ||
        (!archive && lastDraftVersion.current === editVersion.current)
      )
        return true;
      let saved = false;
      const version = editVersion.current,
        generation = epoch.current;
      const pending = storeProjectDraft({
        owner,
        project: project.id,
        session: archive ? session + '-' + crypto.randomUUID() : session,
        name: nameRef.current,
        revision: revision.current,
        editVersion: version,
        updatedAt: Date.now(),
        topology: engine.snapshot(),
      })
        .then(async () => {
          saved = true;
          if (epoch.current === generation) {
            if (!archive) lastDraftVersion.current = version;
            setDraftWarning('');
            if (archive) setDrafts(await projectDrafts(owner, project.id));
          }
        })
        .catch((cause) => {
          if (epoch.current === generation)
            setDraftWarning(
              'Recuperação local indisponível: ' +
                (cause as Error).message +
                ' Exporte as alterações se o servidor também falhar.'
            );
        });
      draftSaving.current = pending;
      try {
        await pending;
      } finally {
        if (draftSaving.current === pending) draftSaving.current = null;
      }
      return saved;
    },
    [engine, owner, project.id, session]
  );
  useEffect(() => {
    let active = true;
    void projectDrafts(owner, project.id)
      .then((rows) => {
        const original = canonicalScenarioJson(project.topology);
        if (active)
          setDrafts(
            rows.filter((d) => d.name !== project.name || canonicalScenarioJson(d.topology) !== original)
          );
      })
      .catch((cause) => {
        if (active)
          setDraftWarning('Não foi possível consultar os rascunhos locais: ' + (cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, [owner, project.id, project.name, project.topology]);
  const workerGeneration = useRef(0);
  const refresh = useCallback(() => {
    editVersion.current++;
    setTick((t) => t + 1);
    setSaveStatus('Alterações pendentes');
  }, []);
  const change = useCallback(
    <T>(
      action: (e: SimulationEngine) => T,
      checkpoint = true,
      simulationMutation = true,
      // The action already refreshed protocols and validated the state (e.g. a terminal command).
      validated = false
    ): T | undefined => {
      if (simulationMutation) {
        workerGeneration.current++;
        setSimulationRevision((value) => value + 1);
        setPlaying(false);
      }
      const before = checkpoint ? engine.checkpoint() : null;
      try {
        const result = action(engine);
        if (!validated) {
          engine.refreshSpanningTree();
          engine.refreshVrrp();
          engine.refreshBgp();
        }
        if (before) {
          if (!validated) validateSnapshot(engine.state, { trustedLogs: true });
          snapshots.current.checkpoint(before);
        }
        refresh();
        return result;
      } catch (e) {
        if (before) engine.state = before;
        setError((e as Error).message);
        return undefined;
      }
    },
    [engine, refresh]
  );
  /** Records a terminal command's pre-command mark as an undo step without another full copy. */
  const remember = useCallback((mark: StateMark) => {
    snapshots.current.checkpointLazy(() => materializeMark(mark), mark.bytes);
  }, []);
  const restore = useCallback(
    (snapshot: unknown) => {
      const applied = change((e) => {
        e.state = validateSnapshot(snapshot);
        return true;
      });
      setPlaying(false);
      return applied;
    },
    [change]
  );
  const history = useCallback(
    (direction: 'undo' | 'redo') => {
      try {
        const previous = snapshots.current.restore(direction, engine.snapshot());
        if (!previous) return;
        workerGeneration.current++;
        engine.state = previous;
        setPlaying(false);
        refresh();
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [engine, refresh]
  );
  const save = useCallback(
    async (requestedVersion = editVersion.current): Promise<void> => {
      if (conflict.current) throw new Error('Conflito de versão: exporte e reabra o laboratório.');
      if (saving.current) {
        await saving.current;
        if (savedVersion.current < requestedVersion) return save(requestedVersion);
        return;
      }
      if (editVersion.current === savedVersion.current) return;
      const version = editVersion.current;
      const generation = epoch.current;
      const restoredDraft = recoveredDraft.current;
      setSaveStatus('Salvando…');
      const promise = api<Project>('/projects/' + project.id, {
        method: 'PUT',
        body: { name: nameRef.current, revision: revision.current, topology: engine.snapshot() },
      })
        .then((p) => {
          if (epoch.current !== generation) return;
          revision.current = p.revision;
          savedVersion.current = version;
          setSaveStatus(version === editVersion.current ? 'Salvo' : 'Alterações pendentes');
          const previousError = saveError.current;
          if (previousError) setError((message) => (message === previousError ? '' : message));
          saveError.current = null;
          setDraftWarning('');
          void (async () => {
            await draftSaving.current;
            await removeProjectDraft(draftKey, version);
            if (restoredDraft) {
              await removeProjectDraft(restoredDraft.key, restoredDraft.editVersion);
              if (recoveredDraft.current === restoredDraft) recoveredDraft.current = null;
              setDrafts((rows) => rows.filter((d) => d.key !== restoredDraft.key));
            }
          })().catch(() => {});
        })
        .catch(async (e) => {
          if (epoch.current !== generation) throw e;
          setSaveStatus('Falha ao salvar');
          saveError.current = e.message;
          setError(e.message);
          if (e instanceof ApiError && e.status === 409) {
            conflict.current = true;
            setConflicted(true);
          }
          if (e instanceof ApiError && e.status === 401) {
            workerGeneration.current++;
            setPlaying(false);
          }
          const protectedWork = await persistDraft();
          if (e instanceof ApiError && e.status === 401) {
            if (protectedWork) onExpired();
            else {
              saveError.current =
                'Sessão expirada e recuperação local indisponível. Exporte o trabalho antes de entrar novamente.';
              setError(saveError.current);
            }
          }
          throw e;
        })
        .finally(() => {
          if (saving.current === promise) saving.current = null;
        });
      saving.current = promise;
      return promise;
    },
    [engine, project.id, onExpired, draftKey, persistDraft]
  );
  const acceptProject = useCallback(
    (next: Project) => {
      const validated = validateSnapshot(next.topology);
      epoch.current++;
      workerGeneration.current++;
      engine.state = validated;
      revision.current = next.revision;
      nameRef.current = next.name;
      snapshots.current.clear();
      savedVersion.current = editVersion.current;
      conflict.current = false;
      saveError.current = null;
      setConflicted(false);
      lastDraftVersion.current = -1;
      recoveredDraft.current = null;
      setNameState(next.name);
      setError('');
      setPlaying(false);
      setSaveStatus('Salvo');
      setTick((n) => n + 1);
    },
    [engine]
  );
  useEffect(() => {
    const timer = setInterval(() => {
      void persistDraft();
      if (editVersion.current !== savedVersion.current && !conflict.current) void save().catch(() => {});
    }, 5000);
    const flush = () => {
      void persistDraft();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      flush();
    };
  }, [persistDraft, save]);
  useEffect(() => {
    if (!tick || conflict.current) return;
    const timer = setTimeout(() => {
      void persistDraft();
      void save().catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [tick, save, persistDraft]);
  useEffect(() => {
    const warning = (e: BeforeUnloadEvent) => {
      if (editVersion.current !== savedVersion.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warning);
    return () => window.removeEventListener('beforeunload', warning);
  }, []);
  useEffect(() => {
    if (!playing) return;
    setPlaybackMetrics({ lagMs: 0, eventsPerSecond: 0, ready: false });
    const generation = ++workerGeneration.current;
    const worker = new Worker(simulationWorkerUrl, { type: 'module' });
    let ready = false,
      busy = false;
    let startedAt = 0,
      initialClock = engine.state.clock,
      processed = 0,
      lastResponse = performance.now();
    const requestStep = () => {
      if ((!ready || busy) && performance.now() - lastResponse > 30000) {
        setError(
          'O processamento não respondeu em 30 segundos. A simulação foi pausada; você pode salvar e retomar.'
        );
        setPlaying(false);
        return;
      }
      if (!ready || busy || generation !== workerGeneration.current) return;
      busy = true;
      worker.postMessage({
        kind: 'step',
        generation,
        maxSteps: engine.state.devices.length > 200 ? 200 : Math.max(1, Math.floor(speed)),
        ...(playbackMode === 'realtime'
          ? { until: Math.max(engine.state.clock, initialClock + (performance.now() - startedAt) * speed) }
          : {}),
      });
    };
    worker.onmessage = (
      event: MessageEvent<{ kind: string; generation: number; delta?: SimulationDelta; message?: string }>
    ) => {
      const message = event.data;
      if (message.generation !== workerGeneration.current || message.generation !== generation) return;
      lastResponse = performance.now();
      if (message.kind === 'ready') {
        ready = true;
        startedAt = performance.now();
        initialClock = engine.state.clock;
        setPlaybackMetrics({ lagMs: 0, eventsPerSecond: 0, ready: true });
      } else if (message.kind === 'delta' && message.delta) {
        busy = false;
        applySimulationDelta(engine.state, message.delta);
        processed += message.delta.processed;
        const elapsed = performance.now() - startedAt;
        setPlaybackMetrics({
          lagMs:
            playbackMode === 'realtime'
              ? Math.max(0, initialClock + elapsed * speed - engine.state.clock)
              : 0,
          eventsPerSecond: elapsed > 0 ? (processed * 1000) / elapsed : 0,
          ready: true,
        });
        refresh();
        if (playbackMode === 'realtime' && initialClock + elapsed * speed - engine.state.clock > 100)
          requestStep();
      } else if (message.kind === 'error') {
        setError(message.message ?? 'Falha na simulação.');
        setPlaying(false);
      }
    };
    worker.onerror = () => {
      if (workerGeneration.current === generation) {
        setError('Falha ao carregar o processamento da simulação.');
        setPlaying(false);
      }
    };
    worker.postMessage({ kind: 'load', generation, snapshot: engine.snapshot() });
    const timer = setInterval(requestStep, playbackMode === 'realtime' ? 100 : 650 / speed);
    return () => {
      workerGeneration.current++;
      clearInterval(timer);
      worker.terminate();
    };
  }, [playing, speed, playbackMode, engine, refresh, simulationRevision]);
  useEffect(() => {
    let closed = false,
      socket: WebSocket | undefined,
      reconnect: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    const reconcile = async () => {
      try {
        const generation = epoch.current,
          remote = await api<Project>('/projects/' + project.id);
        if (closed || generation !== epoch.current || remote.revision <= revision.current || saving.current)
          return;
        if (editVersion.current === savedVersion.current) acceptProject(remote);
        else {
          conflict.current = true;
          setConflicted(true);
          void persistDraft();
          setError('Outra aba salvou alterações. Compare ou crie uma cópia antes de continuar.');
        }
      } catch (cause) {
        if (!closed && cause instanceof ApiError && cause.status === 401) {
          workerGeneration.current++;
          setPlaying(false);
          if (await persistDraft()) onExpired();
          else
            setError(
              'Sessão expirada e recuperação local indisponível. Exporte o trabalho antes de entrar novamente.'
            );
        } else if (!closed && !(cause instanceof ApiError))
          setError('Não foi possível atualizar o laboratório: ' + (cause as Error).message);
        if (!closed && cause instanceof ApiError && cause.status === 404) {
          conflict.current = true;
          setConflicted(true);
          setError('Laboratório excluído; recupere o rascunho em uma cópia.');
        }
      }
    };
    const connect = () => {
      if (closed) return;
      setLiveStatus('Reconectando');
      socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/events');
      socket.onopen = () => {
        delay = 1000;
        setLiveStatus('Conectado');
        void reconcile();
      };
      socket.onclose = () => {
        if (!closed) {
          setLiveStatus('Desconectado');
          reconnect = setTimeout(connect, delay);
          delay = Math.min(30000, delay * 2);
        }
      };
      socket.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.id === project.id && data.type === 'project.deleted') {
          conflict.current = true;
          setConflicted(true);
          setError('Este laboratório foi excluído em outra aba. Exporte seu trabalho.');
        } else if (
          data.id === project.id &&
          data.type === 'project.updated' &&
          data.revision > revision.current &&
          !saving.current
        ) {
          void reconcile();
        }
      };
    };
    connect();
    const online = () => {
      void reconcile();
    };
    window.addEventListener('online', online);
    return () => {
      closed = true;
      clearTimeout(reconnect);
      socket?.close();
      window.removeEventListener('online', online);
    };
  }, [project.id, acceptProject, persistDraft, onExpired]);
  return {
    engine,
    projectId: project.id,
    revision: revision.current,
    getRevision: () => revision.current,
    acceptProject,
    tick,
    name,
    error,
    setError,
    saveStatus,
    playing,
    setPlaying,
    speed,
    setSpeed,
    playbackMode,
    setPlaybackMode,
    playbackMetrics,
    change,
    remember,
    restore,
    history,
    save,
    setName: (value: string) => {
      setNameState(value);
      nameRef.current = value;
      refresh();
    },
    canUndo: snapshots.current.canUndo,
    canRedo: snapshots.current.canRedo,
    drafts,
    draftWarning,
    conflicted,
    liveStatus,
    persistDraft,
    recoverDraft: (draft: ProjectDraft) => {
      if (draft.project !== project.id || draft.owner !== owner) return;
      if (
        change((e) => {
          e.state = validateSnapshot(draft.topology);
          return true;
        })
      ) {
        recoveredDraft.current = draft;
        nameRef.current = draft.name;
        setNameState(draft.name);
      }
    },
    discardDraft: async (draft: ProjectDraft) => {
      if (draft.project !== project.id || draft.owner !== owner) return;
      await removeProjectDraft(draft.key);
      setDrafts((rows) => rows.filter((d) => d.key !== draft.key));
    },
  };
}
export type LabController = ReturnType<typeof useLab>;
