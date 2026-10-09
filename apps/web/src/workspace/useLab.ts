import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SimulationEngine,
  validateSnapshot,
  applySimulationDelta,
  type SimulationDelta,
  type Snapshot,
} from '@shlab/engine';
import { api, ApiError, type Project } from '../api';
export function useLab(project: Project, onExpired: () => void) {
  const [engine] = useState(() => new SimulationEngine(project.topology));
  const [tick, setTick] = useState(0),
    [name, setNameState] = useState(project.name),
    [error, setError] = useState(''),
    [saveStatus, setSaveStatus] = useState('Salvo'),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1);
  const undo = useRef<Snapshot[]>([]),
    redo = useRef<Snapshot[]>([]),
    editVersion = useRef(0),
    savedVersion = useRef(0),
    revision = useRef(project.revision),
    nameRef = useRef(name),
    saving = useRef<Promise<void> | null>(null),
    conflict = useRef(false);
  const workerGeneration = useRef(0);
  const refresh = useCallback(() => {
    editVersion.current++;
    setTick((t) => t + 1);
    setSaveStatus('Alterações pendentes');
  }, []);
  const change = useCallback(
    <T>(action: (e: SimulationEngine) => T, checkpoint = true, simulationMutation = true): T | undefined => {
      if (simulationMutation) {
        workerGeneration.current++;
        setPlaying(false);
      }
      const before = checkpoint ? engine.snapshot() : null;
      try {
        const result = action(engine);
        engine.refreshSpanningTree();
        engine.refreshVrrp();
        engine.refreshBgp();
        if (before) {
          validateSnapshot(engine.state);
          undo.current.push(before);
          if (undo.current.length > (engine.state.devices.length > 200 ? 5 : 30)) undo.current.shift();
          redo.current = [];
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
  const restore = useCallback(
    (snapshot: unknown) => {
      change((e) => {
        e.state = validateSnapshot(snapshot);
      });
      setPlaying(false);
    },
    [change]
  );
  const history = useCallback(
    (direction: 'undo' | 'redo') => {
      const source = direction === 'undo' ? undo : redo,
        target = direction === 'undo' ? redo : undo;
      const previous = source.current.pop();
      if (!previous) return;
      target.current.push(engine.snapshot());
      workerGeneration.current++;
      engine.state = previous;
      setPlaying(false);
      refresh();
    },
    [engine, refresh]
  );
  const save = useCallback(async (): Promise<void> => {
    if (conflict.current) throw new Error('Conflito de versão: exporte e reabra o laboratório.');
    if (saving.current) {
      await saving.current;
      if (editVersion.current !== savedVersion.current) return save();
      return;
    }
    if (editVersion.current === savedVersion.current) return;
    const version = editVersion.current;
    setSaveStatus('Salvando…');
    const promise = api<Project>('/projects/' + project.id, {
      method: 'PUT',
      body: { name: nameRef.current, revision: revision.current, topology: engine.snapshot() },
    })
      .then((p) => {
        revision.current = p.revision;
        savedVersion.current = version;
        setSaveStatus(version === editVersion.current ? 'Salvo' : 'Alterações pendentes');
      })
      .catch((e) => {
        setSaveStatus('Falha ao salvar');
        setError(e.message);
        if (e instanceof ApiError && e.status === 409) conflict.current = true;
        if (e instanceof ApiError && e.status === 401) onExpired();
        throw e;
      })
      .finally(() => {
        saving.current = null;
      });
    saving.current = promise;
    return promise;
  }, [engine, project.id, onExpired]);
  useEffect(() => {
    if (!tick || conflict.current) return;
    const timer = setTimeout(() => {
      void save().catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [tick, save]);
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
    const generation = ++workerGeneration.current;
    const worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' });
    let ready = false,
      busy = false;
    worker.onmessage = (
      event: MessageEvent<{ kind: string; generation: number; delta?: SimulationDelta; message?: string }>
    ) => {
      const message = event.data;
      if (message.generation !== workerGeneration.current || message.generation !== generation) return;
      if (message.kind === 'ready') ready = true;
      else if (message.kind === 'delta' && message.delta) {
        busy = false;
        applySimulationDelta(engine.state, message.delta);
        if (message.delta.processed) refresh();
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
    const timer = setInterval(() => {
      if (ready && !busy) {
        busy = true;
        worker.postMessage({
          kind: 'step',
          generation,
          maxSteps: engine.state.devices.length > 200 ? 200 : Math.max(1, Math.floor(speed)),
        });
      }
    }, 650 / speed);
    return () => {
      workerGeneration.current++;
      clearInterval(timer);
      worker.terminate();
    };
  }, [playing, speed, engine, refresh]);
  useEffect(() => {
    const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/events');
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === project.id && data.type === 'project.deleted') {
        conflict.current = true;
        setError('Este laboratório foi excluído em outra aba. Exporte seu trabalho.');
      } else if (
        data.id === project.id &&
        data.type === 'project.updated' &&
        data.revision > revision.current &&
        !saving.current
      ) {
        conflict.current = true;
        setError('Outra aba salvou uma versão mais recente. Exporte suas alterações e reabra o laboratório.');
      }
    };
    return () => socket.close();
  }, [project.id]);
  return {
    engine,
    revision: revision.current,
    getRevision: () => revision.current,
    acceptProject: (next: Project) => {
      workerGeneration.current++;
      engine.state = validateSnapshot(next.topology);
      revision.current = next.revision;
      nameRef.current = next.name;
      undo.current = [];
      redo.current = [];
      savedVersion.current = editVersion.current;
      conflict.current = false;
      setNameState(next.name);
      setError('');
      setPlaying(false);
      setSaveStatus('Salvo');
      setTick((value) => value + 1);
    },
    tick,
    name,
    error,
    setError,
    saveStatus,
    playing,
    setPlaying,
    speed,
    setSpeed,
    change,
    restore,
    history,
    save,
    setName: (value: string) => {
      setNameState(value);
      nameRef.current = value;
      refresh();
    },
    canUndo: undo.current.length > 0,
    canRedo: redo.current.length > 0,
  };
}
export type LabController = ReturnType<typeof useLab>;
