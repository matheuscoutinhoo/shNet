import { useEffect, useState, type FormEvent } from 'react';
import {
  Plus,
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
  SlidersHorizontal,
} from 'lucide-react';
import { templates, labs, type LabId, type TemplateId, type LearningScore } from '@shlab/engine';
import { api, type User, type Project, type ProjectSummary } from './api';
import { Brand } from './components/Brand';
import { Modal } from './components/Modal';
import { SearchField } from './components/SearchField';
import { CatalogCard } from './components/CatalogCard';
import { searchText, templateCategories } from './catalog';
import { ActivityHistory } from './ActivityHistory';
import { Account } from './Account';

const categories = [
  ...new Set([...Object.values(templateCategories), ...labs.map((lab) => lab.category)]),
].sort((a, b) => a.localeCompare(b, 'pt-BR'));

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
    [loading, setLoading] = useState(true),
    [section, setSection] = useState<'labs' | 'templates'>('labs'),
    [query, setQuery] = useState(''),
    [modeFilter, setModeFilter] = useState('all'),
    [progressFilter, setProgressFilter] = useState('all'),
    [favoritesOnly, setFavoritesOnly] = useState(false),
    [sort, setSort] = useState('recent'),
    [catalogQuery, setCatalogQuery] = useState(''),
    [catalogKind, setCatalogKind] = useState('all'),
    [category, setCategory] = useState('all'),
    [difficulty, setDifficulty] = useState('all'),
    [activityRevision, setActivityRevision] = useState(0),
    [creating, setCreating] = useState<TemplateId | null>(null),
    [labMode, setLabMode] = useState<'free' | 'guided' | 'challenge'>('free'),
    [lesson, setLesson] = useState<LabId>('lan-foundations'),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState(false),
    [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const refresh = () =>
    Promise.all([api<ProjectSummary[]>('/projects'), api<LearningScore>('/learning/score')])
      .then(([items, points]) => {
        setProjects(items);
        setScore(points);
        setActivityRevision((revision) => revision + 1);
      })
      .catch((cause) => setError(cause.message))
      .finally(() => setLoading(false));
  useEffect(() => {
    void refresh();
  }, []);
  function chooseTemplate(id: TemplateId) {
    setLabMode('free');
    setError('');
    setCreating(id);
  }
  function chooseLesson(entry: (typeof labs)[number]) {
    setLesson(entry.id);
    setLabMode('guided');
    setError('');
    setCreating(entry.template);
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const project = await api<Project>('/projects', {
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
      onOpen(project);
    } catch (cause) {
      setError((cause as Error).message);
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
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function favorite(project: ProjectSummary) {
    setBusy(true);
    try {
      await api('/projects/' + project.id + '/favorite', {
        method: 'PATCH',
        body: { favorite: !project.favorite },
      });
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const clearLabs = () => {
    setQuery('');
    setModeFilter('all');
    setProgressFilter('all');
    setFavoritesOnly(false);
    setSort('recent');
  };
  const clearCatalog = () => {
    setCatalogQuery('');
    setCatalogKind('all');
    setCategory('all');
    setDifficulty('all');
  };
  const hasLabFilters = Boolean(query || modeFilter !== 'all' || progressFilter !== 'all' || favoritesOnly);
  const hasCatalogFilters = Boolean(
    catalogQuery || catalogKind !== 'all' || category !== 'all' || difficulty !== 'all'
  );
  const filtered = projects
    .filter(
      (project) =>
        searchText(project.name).includes(searchText(query)) &&
        (!favoritesOnly || project.favorite) &&
        (modeFilter === 'all' || project.mode === modeFilter) &&
        (progressFilter === 'all' ||
          (progressFilter === 'completed'
            ? project.completed
            : project.mode !== 'free' && !project.completed))
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, 'pt-BR')
        : new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  const filteredTemplates = templates.filter(
    (entry) =>
      catalogKind !== 'lessons' &&
      (category === 'all' || templateCategories[entry.id] === category) &&
      searchText(
        entry.name + ' ' + entry.description + ' ' + entry.level + ' ' + templateCategories[entry.id]
      ).includes(searchText(catalogQuery))
  );
  const filteredLessons = labs.filter(
    (entry) =>
      catalogKind !== 'templates' &&
      (category === 'all' || entry.category === category) &&
      (difficulty === 'all' || entry.difficulty === difficulty) &&
      searchText(entry.name + ' ' + entry.objective + ' ' + entry.category + ' ' + entry.difficulty).includes(
        searchText(catalogQuery)
      )
  );
  const template = templates.find((entry) => entry.id === creating),
    selectedLesson = labs.find((entry) => entry.id === lesson);

  return (
    <div className="dashboard">
      <aside className="dashboard-sidebar">
        <Brand />
        <span className="nav-label">ÁREA PESSOAL</span>
        <nav aria-label="Navegação principal">
          <button
            aria-label="Meus laboratórios"
            aria-current={section === 'labs' ? 'page' : undefined}
            className={section === 'labs' ? 'active' : ''}
            onClick={() => setSection('labs')}
            title="Meus laboratórios"
          >
            <Layers size={19} /> Meus laboratórios <span>{projects.length}</span>
          </button>
          <button
            aria-label="Templates"
            aria-current={section === 'templates' ? 'page' : undefined}
            className={section === 'templates' ? 'active' : ''}
            onClick={() => setSection('templates')}
            title="Templates e trilhas"
          >
            <BookOpen size={19} /> Templates
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setSettings(true)} title="Conta e segurança">
            <Settings2 size={18} /> Conta e segurança
          </button>
          <button onClick={onLogout} title="Sair">
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
            Área pessoal <ChevronRight size={14} />
            <strong>{section === 'labs' ? 'Laboratórios' : 'Templates e trilhas'}</strong>
          </span>
          <span className="private-label">
            <span className="status-dot" /> Privado
          </span>
        </header>
        <main className="dashboard-content">
          <div className="page-heading">
            <div>
              <h1>{section === 'labs' ? 'Meus laboratórios' : 'Templates e trilhas'}</h1>
              <p className="muted">
                {section === 'labs'
                  ? 'Laboratórios salvos e atividades recentes.'
                  : 'Topologias de referência e exercícios guiados.'}
              </p>
            </div>
            <button className="button primary" onClick={() => chooseTemplate('empty')}>
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
          {section === 'labs' ? (
            <>
              <div className="dashboard-stats">
                <span>
                  <Layers size={18} />
                  <strong>{projects.length}</strong>
                  <span className="stat-label">Laboratórios</span>
                </span>
                <span>
                  <Network size={18} />
                  <strong>{projects.reduce((count, project) => count + project.device_count, 0)}</strong>
                  <span className="stat-label">Dispositivos</span>
                </span>
                <span>
                  <Activity size={18} />
                  <strong>{projects.filter((project) => project.completed).length}</strong>
                  <span className="stat-label">Concluídos</span>
                </span>
                {score && (
                  <span
                    title={
                      'Trilhas: ' +
                      score.sources.labs +
                      ' · Desafios: ' +
                      score.sources.challenges +
                      ' · Tutorial: ' +
                      score.sources.tutorials
                    }
                  >
                    <BookOpen size={18} />
                    <strong>{score.score}</strong>
                    <span className="stat-label">Pontos</span>
                  </span>
                )}
              </div>
              <section aria-label="Lista de laboratórios">
                <h2 className="sr-only">Laboratórios salvos</h2>
                <div className="filter-bar" role="group" aria-label="Filtros dos laboratórios">
                  <SearchField
                    label="Buscar laboratórios"
                    placeholder="Buscar laboratório…"
                    value={query}
                    onChange={setQuery}
                  />
                  <label>
                    Modo
                    <select value={modeFilter} onChange={(event) => setModeFilter(event.target.value)}>
                      <option value="all">Todos os modos</option>
                      <option value="free">Livre</option>
                      <option value="guided">Guiado</option>
                      <option value="challenge">Desafio</option>
                    </select>
                  </label>
                  <label>
                    Progresso
                    <select
                      value={progressFilter}
                      onChange={(event) => setProgressFilter(event.target.value)}
                    >
                      <option value="all">Todos os estados</option>
                      <option value="completed">Concluídos</option>
                      <option value="in-progress">Em andamento</option>
                    </select>
                  </label>
                  <label>
                    Ordenar por
                    <select value={sort} onChange={(event) => setSort(event.target.value)}>
                      <option value="recent">Atualização recente</option>
                      <option value="name">Nome</option>
                    </select>
                  </label>
                  <button
                    className={'button filter-toggle ' + (favoritesOnly ? 'is-active' : '')}
                    aria-pressed={favoritesOnly}
                    onClick={() => setFavoritesOnly(!favoritesOnly)}
                  >
                    <Star size={16} fill={favoritesOnly ? 'currentColor' : 'none'} /> Favoritos
                  </button>
                  {hasLabFilters && (
                    <button className="text-button clear-filters" onClick={clearLabs}>
                      Limpar filtros
                    </button>
                  )}
                </div>
                <p className="filter-results" role="status">
                  {loading
                    ? 'Carregando laboratórios…'
                    : filtered.length + ' de ' + projects.length + ' laboratórios'}
                </p>
                {!loading && !filtered.length && hasLabFilters && (
                  <div className="empty-results">
                    <SlidersHorizontal size={24} />
                    <p>Nenhum laboratório corresponde aos filtros.</p>
                    <button className="button" onClick={clearLabs}>
                      Mostrar todos os laboratórios
                    </button>
                  </div>
                )}
                <div className="lab-grid">
                  {filtered.map((project) => (
                    <article className="lab-card" key={project.id}>
                      <button
                        className={'favorite icon-button ' + (project.favorite ? 'starred' : '')}
                        title={project.favorite ? 'Remover dos favoritos' : 'Favoritar laboratório'}
                        aria-label={
                          (project.favorite ? 'Remover dos favoritos ' : 'Favoritar ') + project.name
                        }
                        aria-pressed={project.favorite}
                        disabled={busy}
                        onClick={() => void favorite(project)}
                      >
                        <Star size={17} fill={project.favorite ? 'currentColor' : 'none'} />
                      </button>
                      <button className="lab-open" disabled={busy} onClick={() => void open(project.id)}>
                        <div className="lab-preview">
                          <span />
                          <i />
                          <Network size={32} />
                          <i />
                          <span />
                        </div>
                        <div className="lab-card-content">
                          <span className="eyebrow">
                            {project.mode === 'guided'
                              ? 'LABORATÓRIO GUIADO'
                              : project.mode === 'challenge'
                                ? 'DESAFIO'
                                : 'LABORATÓRIO LIVRE'}
                          </span>
                          <h3 title={project.name}>{project.name}</h3>
                          <p>
                            {project.device_count} dispositivos <span>·</span> Revisão {project.revision}
                          </p>
                          <span className="lesson-progress">
                            {project.total
                              ? project.passed +
                                '/' +
                                project.total +
                                ' tarefas' +
                                (project.completed ? ' · Concluído' : '')
                              : project.mode === 'free'
                                ? 'Modo livre'
                                : 'Não avaliado'}
                          </span>
                          <div className="lab-footer">
                            <span>
                              <Clock size={13} />
                              {new Date(project.updated_at).toLocaleDateString('pt-BR')}
                            </span>
                            <ArrowUpRight size={18} />
                          </div>
                        </div>
                      </button>
                      <button
                        className="delete-lab icon-button"
                        aria-label={'Excluir ' + project.name}
                        title="Excluir laboratório"
                        onClick={() => setDeleting(project)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </article>
                  ))}
                  {!hasLabFilters && !loading && (
                    <button className="new-lab-card" onClick={() => chooseTemplate('empty')}>
                      <span>
                        <Plus size={26} />
                      </span>
                      <strong>Criar laboratório</strong>
                      <small>Topologia em branco</small>
                    </button>
                  )}
                </div>
              </section>
              <ActivityHistory onOpen={(id) => void open(id)} refreshKey={activityRevision} />
            </>
          ) : (
            <>
              <div className="filter-bar" role="group" aria-label="Filtros de templates e trilhas">
                <SearchField
                  label="Buscar templates e trilhas"
                  placeholder="Buscar nome, protocolo ou descrição…"
                  value={catalogQuery}
                  onChange={setCatalogQuery}
                />
                <label>
                  Conteúdo
                  <select
                    value={catalogKind}
                    onChange={(event) => {
                      setCatalogKind(event.target.value);
                      if (event.target.value === 'templates') setDifficulty('all');
                    }}
                  >
                    <option value="all">Templates e trilhas</option>
                    <option value="templates">Templates</option>
                    <option value="lessons">Trilhas</option>
                  </select>
                </label>
                <label>
                  Tema
                  <select value={category} onChange={(event) => setCategory(event.target.value)}>
                    <option value="all">Todos os temas</option>
                    {categories.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Nível da trilha
                  <select
                    disabled={catalogKind === 'templates'}
                    value={difficulty}
                    onChange={(event) => {
                      setDifficulty(event.target.value);
                      if (event.target.value !== 'all') setCatalogKind('lessons');
                    }}
                  >
                    <option value="all">Todos os níveis</option>
                    <option>Iniciante</option>
                    <option>Intermediário</option>
                    <option>Avançado</option>
                  </select>
                </label>
                {hasCatalogFilters && (
                  <button className="text-button clear-filters" onClick={clearCatalog}>
                    Limpar filtros
                  </button>
                )}
              </div>
              <p className="filter-results" role="status">
                {filteredTemplates.length} templates · {filteredLessons.length} trilhas
              </p>
              {!filteredTemplates.length && !filteredLessons.length && (
                <div className="empty-results">
                  <SlidersHorizontal size={24} />
                  <p>Nenhum template ou trilha corresponde aos filtros.</p>
                  <button className="button" onClick={clearCatalog}>
                    Mostrar todo o catálogo
                  </button>
                </div>
              )}
              {catalogKind !== 'lessons' && filteredTemplates.length > 0 && (
                <section aria-label="Templates disponíveis">
                  <div className="section-heading">
                    <div>
                      <h2>
                        Templates <span className="count">{filteredTemplates.length}</span>
                      </h2>
                      <p className="muted">Topologias com equipamentos e protocolos configurados.</p>
                    </div>
                  </div>
                  <div className="template-grid">
                    {filteredTemplates.map((entry) => (
                      <CatalogCard
                        key={entry.id}
                        kind="template"
                        name={entry.name}
                        meta={entry.level}
                        description={entry.description}
                        onOpen={() => chooseTemplate(entry.id)}
                      />
                    ))}
                  </div>
                </section>
              )}
              {catalogKind !== 'templates' && filteredLessons.length > 0 && (
                <section className="learning-section" aria-label="Trilhas disponíveis">
                  <div className="section-heading">
                    <div>
                      <h2>
                        Trilhas <span className="count">{filteredLessons.length}</span>
                      </h2>
                      <p className="muted">Exercícios com objetivos e avaliação de tarefas.</p>
                    </div>
                  </div>
                  <div className="lesson-grid">
                    {filteredLessons.map((entry) => (
                      <CatalogCard
                        key={entry.id}
                        kind="lesson"
                        name={entry.name}
                        meta={entry.category + ' · ' + entry.difficulty}
                        description={entry.objective}
                        onOpen={() => chooseLesson(entry)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          <footer className="dashboard-footer">
            <Brand compact />
            <span>Simulação de redes</span>
          </footer>
        </main>
      </div>
      {creating && (
        <Modal title="Criar laboratório" onClose={() => setCreating(null)}>
          <form onSubmit={create}>
            <p className="muted">{labMode === 'free' ? template?.description : selectedLesson?.objective}</p>
            <label>
              Nome do laboratório
              <input
                name="name"
                required
                autoFocus
                maxLength={100}
                defaultValue={
                  labMode !== 'free'
                    ? selectedLesson?.name
                    : creating === 'empty'
                      ? 'Novo laboratório'
                      : template?.name
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
                Trilha
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
              Fundo do laboratório
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
            <div className="modal-actions">
              <button disabled={busy} className="button primary">
                {busy ? 'Criando…' : 'Criar e abrir laboratório'}
                <ArrowUpRight size={17} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title="Excluir laboratório?" onClose={() => setDeleting(null)}>
          <p>
            O laboratório <strong>{deleting.name}</strong> e suas versões salvas serão excluídos.
          </p>
          <div className="button-row modal-actions">
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
                } catch (cause) {
                  setError((cause as Error).message);
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
