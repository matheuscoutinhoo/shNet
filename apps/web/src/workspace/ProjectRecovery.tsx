import { useState } from 'react';
import { configurationDiff, type Snapshot } from '@shlab/engine';
import { api, download, type Project } from '../api';
import type { LabController } from './useLab';
export function ProjectRecovery({ lab, onRecovered }: { lab: LabController; onRecovered: () => void }) {
  const [busy, setBusy] = useState(false);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (cause) {
      lab.setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const differences = (snapshot: Snapshot) => {
    try {
      return configurationDiff(lab.engine.state, snapshot).length + ' diferenças de configuração';
    } catch {
      return 'Rascunho inválido; exporte para revisar';
    }
  };
  return (
    <div className="project-recovery">
      {lab.draftWarning && (
        <p role="alert" className="alert error">
          {lab.draftWarning}
        </p>
      )}
      {lab.drafts.length > 0 && (
        <details>
          <summary>Rascunhos locais disponíveis ({lab.drafts.length})</summary>
          <p>
            Compare antes de recuperar. Cada aba conserva seu próprio rascunho; o servidor será atualizado
            após a recuperação.
          </p>
          {lab.drafts.map((d) => (
            <div key={d.key}>
              <p>
                {d.name} · {new Date(d.updatedAt).toLocaleString('pt-BR')} · {differences(d.topology)}
              </p>
              <button className="button" disabled={busy} onClick={() => lab.recoverDraft(d)}>
                Recuperar rascunho
              </button>
              <button className="button" onClick={() => download(d.name + '-rascunho', d.topology)}>
                Exportar rascunho
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => void action(() => lab.discardDraft(d))}
              >
                Descartar rascunho
              </button>
            </div>
          ))}
        </details>
      )}
      {lab.conflicted && (
        <div role="alert" className="alert error">
          <p>
            Há uma versão diferente no servidor. Suas alterações continuam neste laboratório e no rascunho
            local quando disponível.
          </p>
          <button
            className="button"
            onClick={() => download(lab.name + '-recuperacao', lab.engine.snapshot())}
          >
            Exportar alterações
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                if (!(await lab.persistDraft(true)))
                  throw new Error(
                    'Não foi possível preservar as alterações localmente. Exporte antes de carregar a versão do servidor.'
                  );
                lab.acceptProject(await api<Project>('/projects/' + lab.projectId));
              })
            }
          >
            Carregar versão do servidor
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const topology: Snapshot = lab.engine.snapshot(),
                  name = (lab.name.slice(0, 82) + ' (recuperado)').slice(0, 100);
                const copy = await api<Project>('/projects', {
                  method: 'POST',
                  body: { name, template: 'empty' },
                });
                try {
                  await api('/projects/' + copy.id, {
                    method: 'PUT',
                    body: { name, revision: copy.revision, topology },
                  });
                } catch (cause) {
                  await api('/projects/' + copy.id, { method: 'DELETE' }).catch(() => {});
                  throw cause;
                }
                onRecovered();
              })
            }
          >
            Salvar alterações em uma cópia
          </button>
        </div>
      )}
    </div>
  );
}
