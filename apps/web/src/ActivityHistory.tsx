import { useEffect, useState } from 'react';
import { api } from './api';
import { formatLocale } from './i18n';
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
  snapshot: 'Versão salva',
};
export function ActivityHistory({
  onOpen,
  refreshKey = 0,
}: {
  onOpen: (id: string) => void;
  refreshKey?: number;
}) {
  const [entries, setEntries] = useState<Entry[]>([]),
    [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  async function load(before?: string) {
    setLoading(true);
    setError('');
    try {
      const page = await api<Page>('/activity?limit=10' + (before ? '&before=' + before : ''));
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
  }, [refreshKey]);
  return (
    <section className="activity-history" aria-label="Histórico de atividades">
      <div className="section-heading">
        <div>
          <h2>Histórico de atividades</h2>
          <p className="muted">Criação, alterações e acessos aos seus laboratórios.</p>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <ol>
        {entries.map((entry) => (
          <li key={entry.id}>
            <div>
              <strong>
                {actions[entry.action] ?? entry.action} · {entry.name}
              </strong>
              <time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString(formatLocale())}</time>
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
