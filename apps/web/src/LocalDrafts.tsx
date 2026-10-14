import { useState } from 'react';
import { api, download, type Project } from './api';
import { Modal } from './components/Modal';
import { projectDrafts, removeProjectDraft, type ProjectDraft } from './workspace/project-drafts';
export function LocalDrafts({ owner, onOpen }: { owner: string; onOpen: (p: Project) => void }) {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<ProjectDraft[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const act = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="button"
        onClick={() => {
          setOpen(true);
          void act(async () => setRows(await projectDrafts(owner)));
        }}
      >
        Rascunhos locais
      </button>
      {open && (
        <Modal title="Rascunhos locais" onClose={() => setOpen(false)}>
          <p>
            Recupere ou exporte trabalho deste usuário e navegador, inclusive de laboratórios excluídos.
            Descartar libera a quota local.
          </p>
          {error && <p role="alert">{error}</p>}
          {!rows.length && !busy && <p>Nenhum rascunho local disponível.</p>}
          {rows.map((draft) => (
            <div key={draft.key}>
              <p>
                {draft.name} · {new Date(draft.updatedAt).toLocaleString('pt-BR')} · revisão {draft.revision}
              </p>
              <div className="button-row">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const name = (draft.name.slice(0, 82) + ' (recuperado)').slice(0, 100),
                        project = await api<Project>('/projects', {
                          method: 'POST',
                          body: { name, template: 'empty' },
                        });
                      let saved: Project;
                      try {
                        saved = await api<Project>('/projects/' + project.id, {
                          method: 'PUT',
                          body: { name, revision: project.revision, topology: draft.topology },
                        });
                      } catch (cause) {
                        await api('/projects/' + project.id, { method: 'DELETE' }).catch(() => {});
                        throw cause;
                      }
                      await removeProjectDraft(draft.key, draft.editVersion).catch(() => {});
                      setRows((previous) => previous.filter((d) => d.key !== draft.key));
                      setOpen(false);
                      onOpen(saved);
                    })
                  }
                >
                  Recuperar em novo laboratório
                </button>
                <button className="button" onClick={() => download(draft.name + '-rascunho', draft.topology)}>
                  Exportar rascunho
                </button>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await removeProjectDraft(draft.key, draft.editVersion);
                      setRows((previous) => previous.filter((d) => d.key !== draft.key));
                    })
                  }
                >
                  Descartar rascunho
                </button>
              </div>
            </div>
          ))}
        </Modal>
      )}
    </>
  );
}
