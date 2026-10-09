import { useEffect, useState } from 'react';
import { api } from './api';
type Entry = {
  id: string;
  project_id: string | null;
  action: string;
  name: string;
  revision: number | null;
  created_at: string;
};
type Page = { entries: Entry[]; next: string | null };
const actions: Record<string, string> = {
  created: 'Criado',
  updated: 'Salvo',
  opened: 'Aberto',
  favorited: 'Favoritado',
  unfavorited: 'Removido dos favoritos',
  deleted: 'Excluído',
  snapshot: 'Snapshot criado',
};
export function ActivityHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]),
    [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  async function load(before?: string) {
    setLoading(true);
    setError('');
    try {
      const page = await api<Page>('/activity' + (before ? '?before=' + before : ''));
      setEntries((current) => (before ? [...current, ...page.entries] : page.entries));
      setNext(page.next);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="activity-history" aria-label="Histórico de atividades">
      <h2>Histórico de atividades</h2>
      {error && <p role="alert">{error}</p>}
      <ol>
        {entries.map((entry) => (
          <li key={entry.id}>
            <div>
              <strong>
                {actions[entry.action] ?? entry.action} · {entry.name}
              </strong>
              <time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString('pt-BR')}</time>
              {entry.revision !== null && <small>Versão {entry.revision}</small>}
            </div>
            {entry.project_id && (
              <button className="button small" onClick={() => onOpen(entry.project_id!)}>
                Abrir laboratório
              </button>
            )}
          </li>
        ))}
      </ol>
      {!entries.length && !loading && <p>Nenhuma atividade registrada ainda.</p>}
      {next && (
        <button className="button" disabled={loading} onClick={() => void load(next)}>
          Carregar mais atividades
        </button>
      )}
      {loading && <p role="status">Carregando histórico…</p>}
    </section>
  );
}
