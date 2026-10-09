import { useEffect, useState, type FormEvent } from 'react';
import {
  Plus,
  Search,
  ArrowUpRight,
  Star,
  Network,
  BookOpen,
  Layers,
  Clock,
  LogOut,
  Settings2,
  Trash2,
  ChevronRight,
  Activity,
} from 'lucide-react';
import { templates, labs, type LabId, type TemplateId, type LearningScore } from '@shlab/engine';
import { api, type User, type Project, type ProjectSummary } from './api';
import { Brand } from './components/Brand';
import { Modal } from './components/Modal';
import { ActivityHistory } from './ActivityHistory';
import { Account } from './Account';
export function Dashboard({
  user,
  onOpen,
  onLogout,
  onUserUpdate,
}: {
  user: User;
  onOpen: (project: Project) => void;
  onLogout: () => void;
  onUserUpdate: (user: User) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]),
    [score, setScore] = useState<LearningScore | null>(null),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [section, setSection] = useState('labs'),
    [creating, setCreating] = useState<TemplateId | null>(null),
    [labMode, setLabMode] = useState<'free' | 'guided' | 'challenge'>('free'),
    [lesson, setLesson] = useState<LabId>('lan-foundations'),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState(false),
    [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const refresh = () =>
    Promise.all([api<ProjectSummary[]>('/projects'), api<LearningScore>('/learning/score')])
      .then(([projects, points]) => {
        setProjects(projects);
        setScore(points);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const p = await api<Project>('/projects', {
        method: 'POST',
        body: {
          name: data.get('name'),
          template: creating,
          background: data.get('background'),
          mode: labMode,
          ...(labMode !== 'free' ? { labId: lesson } : {}),
        },
      });
      setCreating(null);
      setLabMode('free');
      onOpen(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setBusy(true);
    try {
      const project = await api<Project>('/projects/' + id);
      await api('/projects/' + id + '/visits', { method: 'POST', body: {} });
      onOpen(project);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = projects.filter(
    (p) => p.name.toLowerCase().includes(query.toLowerCase()) && (section !== 'favorites' || p.favorite)
  );
  return (
    <div className="dashboard">
      <aside className="dashboard-sidebar">
        <Brand />
        <span className="nav-label">WORKSPACE</span>
        <nav>
          <button className={section === 'labs' ? 'active' : ''} onClick={() => setSection('labs')}>
            <Layers size={19} /> Meus laboratórios <span>{projects.length}</span>
          </button>
          <button className={section === 'templates' ? 'active' : ''} onClick={() => setSection('templates')}>
            <BookOpen size={19} /> Explorar templates
          </button>
          <button className={section === 'favorites' ? 'active' : ''} onClick={() => setSection('favorites')}>
            <Star size={19} /> Favoritos
          </button>
          <button className={section === 'history' ? 'active' : ''} onClick={() => setSection('history')}>
            <Clock size={19} /> Histórico
          </button>
        </nav>
        <div className="sidebar-guide">
          <span className="guide-icon">
            <Network size={22} />
          </span>
          <h4>Aprenda fazendo.</h4>
          <p>Comece com uma LAN e siga o caminho do primeiro pacote.</p>
          <button
            onClick={() => {
              setLabMode('guided');
              setLesson('lan-foundations');
              setCreating('empty');
            }}
          >
            Abrir laboratório guiado <ChevronRight size={16} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setSettings(true)}>
            <Settings2 size={18} /> Conta e segurança
          </button>
          <button onClick={onLogout}>
            <LogOut size={18} /> Sair
          </button>
          <div className="user-card">
            <span className="avatar">{user.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <span>
            Workspace pessoal <ChevronRight size={14} />{' '}
            <strong>
              {section === 'history'
                ? 'Histórico'
                : section === 'templates'
                  ? 'Templates'
                  : section === 'favorites'
                    ? 'Favoritos'
                    : 'Laboratórios'}
            </strong>
          </span>
          <span className="private-label">
            <span className="status-dot" /> Ambiente privado
          </span>
        </header>
        <main className="dashboard-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">EXPLORE. EXPERIMENTE. ENTENDA.</span>
              <h1>
                {section === 'templates'
                  ? 'Um ponto de partida.'
                  : section === 'favorites'
                    ? 'Sempre à mão.'
                    : 'Sua próxima conexão.'}
              </h1>
              <p className="muted">
                {section === 'templates'
                  ? 'Topologias prontas para investigar como uma rede funciona.'
                  : 'Bem-vindo, ' + user.name.split(' ')[0] + '. O que vamos construir hoje?'}
              </p>
            </div>
            <button className="button primary" onClick={() => setCreating('empty')}>
              <Plus size={18} /> Novo laboratório
            </button>
          </div>
          {error && (
            <div role="alert" className="alert error">
              {error}
              <button className="text-button" onClick={() => setError('')}>
                Fechar
              </button>
            </div>
          )}
          <div className="dashboard-stats">
            {score && (
              <span
                title={`Labs: ${score.sources.labs} · Desafios: ${score.sources.challenges} · Tutorial: ${score.sources.tutorials}`}
              >
                <BookOpen size={18} />
                <strong>{score.score}</strong> Pontos de aprendizagem
              </span>
            )}
            <span>
              <Layers size={18} />
              <strong>{projects.length}</strong> Laboratórios
            </span>
            <span>
              <Network size={18} />
              <strong>{projects.reduce((count, project) => count + project.device_count, 0)}</strong>{' '}
              Dispositivos
            </span>
            <span>
              <Activity size={18} />
              <strong>{projects.filter((project) => project.completed).length}</strong> Labs concluídos
            </span>
          </div>
          {section === 'history' && <ActivityHistory onOpen={(id) => void open(id)} />}
          {!['templates', 'history'].includes(section) && (
            <>
              <div className="section-heading">
                <div>
                  <h2>
                    {section === 'favorites' ? 'Seus favoritos' : 'Meus laboratórios'}{' '}
                    <span className="count">{filtered.length}</span>
                  </h2>
                  <p className="muted">Um espaço para testar ideias e encontrar respostas.</p>
                </div>
                <label className="search">
                  <Search size={16} />
                  <input
                    aria-label="Buscar laboratórios"
                    placeholder="Buscar laboratório…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              <div className="lab-grid">
                {filtered.map((p) => (
                  <article className="lab-card" key={p.id}>
                    <button
                      className={'favorite icon-button ' + (p.favorite ? 'starred' : '')}
                      title="Favoritar"
                      aria-label={'Favoritar ' + p.name}
                      onClick={async () => {
                        try {
                          await api('/projects/' + p.id + '/favorite', {
                            method: 'PATCH',
                            body: { favorite: !p.favorite },
                          });
                          await refresh();
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      <Star size={17} fill={p.favorite ? 'currentColor' : 'none'} />
                    </button>
                    <button className="lab-open" disabled={busy} onClick={() => open(p.id)}>
                      <div className="lab-preview">
                        <span />
                        <i />
                        <Network size={32} />
                        <i />
                        <span />
                      </div>
                      <div className="lab-card-content">
                        <span className="eyebrow">
                          {p.mode === 'guided'
                            ? 'LABORATÓRIO GUIADO'
                            : p.mode === 'challenge'
                              ? 'DESAFIO'
                              : 'LABORATÓRIO LIVRE'}
                        </span>
                        <h3>{p.name}</h3>
                        <p>
                          {p.device_count} dispositivos <span>·</span> Revisão {p.revision}
                        </p>
                        {!!p.total && (
                          <span className="lesson-progress">
                            {p.passed}/{p.total} tarefas{p.completed ? ' · Concluído' : ''}
                          </span>
                        )}
                        <div className="lab-footer">
                          <span>
                            <Clock size={13} /> {new Date(p.updated_at).toLocaleDateString('pt-BR')}
                          </span>
                          <ArrowUpRight size={18} />
                        </div>
                      </div>
                    </button>
                    <button
                      className="delete-lab icon-button"
                      aria-label={'Excluir ' + p.name}
                      title="Excluir laboratório"
                      onClick={() => setDeleting(p)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </article>
                ))}
                <button className="new-lab-card" onClick={() => setCreating('empty')}>
                  <span>
                    <Plus size={26} />
                  </span>
                  <strong>Uma ideia, uma nova rede.</strong>
                  <small>Criar laboratório em branco</small>
                </button>
              </div>
            </>
          )}
          {section !== 'favorites' && (
            <>
              <div className="section-heading">
                <div>
                  <h2>Aprenda com uma topologia</h2>
                  <p className="muted">Configurações reais. Liberdade para experimentar.</p>
                </div>
                <span className="subtle">DO BÁSICO AO PRIMEIRO DESAFIO</span>
              </div>
              <div className="template-grid">
                {templates
                  .filter((t) => t.id !== 'empty')
                  .map((t, i) => (
                    <button className="template-card" key={t.id} onClick={() => setCreating(t.id)}>
                      <span className={'template-number tone-' + i}>0{i + 1}</span>
                      <div>
                        <span className="eyebrow">{t.level}</span>
                        <h3>{t.name}</h3>
                        <p>{t.description}</p>
                      </div>
                      <ArrowUpRight size={18} />
                    </button>
                  ))}
              </div>
            </>
          )}
          {section !== 'favorites' && (
            <section className="learning-section">
              <div className="section-heading">
                <div>
                  <h2>Trilhas de laboratório</h2>
                  <p className="muted">Fundamentos, serviços e troubleshooting</p>
                </div>
              </div>
              <div className="lesson-grid">
                {labs.map((entry) => (
                  <button
                    className="lesson-card"
                    key={entry.id}
                    onClick={() => {
                      setLesson(entry.id);
                      setLabMode('guided');
                      setCreating(entry.template);
                    }}
                  >
                    <span className="lesson-icon">
                      <BookOpen size={23} />
                    </span>
                    <span className="lesson-meta">
                      {entry.category} · {entry.difficulty}
                    </span>
                    <h3>{entry.name}</h3>
                    <p>{entry.objective}</p>
                    <span className="text-button">
                      Abrir lab <ArrowUpRight size={15} />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <footer className="dashboard-footer">
            <Brand compact />
            <span>Redes são mais fáceis de entender quando você pode vê-las.</span>
            <span>NETOS · MVP 1</span>
          </footer>
        </main>
      </div>
      {creating && (
        <Modal title="Criar laboratório" onClose={() => setCreating(null)}>
          <form onSubmit={create}>
            <p className="muted">{templates.find((t) => t.id === creating)?.description}</p>
            <label>
              Nome do laboratório
              <input
                name="name"
                required
                autoFocus
                maxLength={100}
                defaultValue={
                  labMode !== 'free'
                    ? labs.find((entry) => entry.id === lesson)?.name
                    : creating === 'empty'
                      ? 'Minha primeira rede'
                      : templates.find((t) => t.id === creating)?.name
                }
              />
            </label>
            <label>
              Modo do laboratório
              <select value={labMode} onChange={(event) => setLabMode(event.target.value as typeof labMode)}>
                <option value="free">Livre</option>
                <option value="guided">Guiado</option>
                <option value="challenge">Desafio</option>
              </select>
            </label>
            {labMode !== 'free' && (
              <label>
                Lab
                <select value={lesson} onChange={(event) => setLesson(event.target.value as LabId)}>
                  {labs.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Fundo do canvas
              <select name="background">
                <option value="light">Claro</option>
                <option value="gray">Cinza</option>
                <option value="dark">Escuro</option>
              </select>
            </label>
            {error && (
              <div role="alert" className="alert error">
                {error}
              </div>
            )}
            <button disabled={busy} className="button primary">
              {busy ? 'Criando…' : 'Criar e abrir laboratório'}
              <ArrowUpRight size={17} />
            </button>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title="Excluir laboratório?" onClose={() => setDeleting(null)}>
          <p>
            O laboratório <strong>{deleting.name}</strong> e seus snapshots serão excluídos.
          </p>
          <div className="button-row">
            <button className="button" onClick={() => setDeleting(null)}>
              Cancelar
            </button>
            <button
              className="button danger"
              onClick={async () => {
                try {
                  await api('/projects/' + deleting.id, { method: 'DELETE' });
                  setDeleting(null);
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Excluir laboratório
            </button>
          </div>
        </Modal>
      )}
      {settings && (
        <Account user={user} onUpdate={onUserUpdate} onLogout={onLogout} onClose={() => setSettings(false)} />
      )}
    </div>
  );
}
