import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Play, Trophy } from 'lucide-react';
import { labs, describeLabTasks, type LabEvaluation } from '@shlab/engine';
import { api, type Project } from '../api';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';
interface Progress {
  revision: number;
  result: LabEvaluation;
  completed: boolean;
  checked_at: string;
}
export function LabPanel({
  project,
  lab,
  onClose,
}: {
  project: Project;
  lab: LabController;
  onClose: () => void;
}) {
  const definition = labs.find((entry) => entry.id === project.lab_id)!;
  const [initial] = useState(() => describeLabTasks(definition.id));
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<Progress | null>('/projects/' + project.id + '/progress')
      .then(setProgress)
      .catch((cause) => setError(cause.message));
  }, [project.id]);
  const stale = !!progress && (progress.revision !== lab.revision || lab.saveStatus !== 'Salvo');
  return (
    <Modal title={definition.name} onClose={onClose}>
      <div className="lesson-meta">
        <span>{definition.category}</span>
        <span>{definition.difficulty}</span>
        <span>{project.mode === 'challenge' ? 'Desafio' : 'Guiado'}</span>
      </div>
      <p>{definition.objective}</p>
      <ol className="lab-task-list">
        {(progress?.result.tasks ?? initial).map((task) => (
          <li key={task.id} className={task.passed ? 'passed' : ''}>
            {task.passed ? <CheckCircle2 size={20} /> : <Circle size={20} />}
            <span>{task.label}</span>
          </li>
        ))}
      </ol>
      {progress && (
        <div className="lab-evaluation" role="status">
          {progress.result.complete && <Trophy size={20} />}
          <strong>
            {progress.result.passed}/{progress.result.total} tarefas
          </strong>
          <span>
            {stale
              ? 'Alterações ainda não avaliadas'
              : progress.result.complete
                ? 'Laboratório concluído'
                : 'Em andamento'}
          </span>
        </div>
      )}
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      <button
        className="button primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          lab.setPlaying(false);
          try {
            await lab.save();
            setProgress(await api<Progress>('/projects/' + project.id + '/evaluate', { method: 'POST' }));
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Avaliação indisponível.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Play size={16} /> {busy ? 'Avaliando...' : 'Validar laboratório'}
      </button>
    </Modal>
  );
}
