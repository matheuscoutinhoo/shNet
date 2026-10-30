import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, type User, type Project } from './api';
import { X } from 'lucide-react';
import { Auth } from './Auth';
import { Dashboard } from './Dashboard';
const Workspace = lazy(() => import('./workspace/Workspace').then((m) => ({ default: m.Workspace })));
import './styles.css';
import '@fontsource-variable/space-grotesk';
import { initializeTheme } from './theme';
import { initI18n } from './i18n';
initializeTheme();
function App() {
  const [user, setUser] = useState<User | null>(null),
    [project, setProject] = useState<Project | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    if (new URLSearchParams(location.search).has('action')) {
      setLoading(false);
      return;
    }
    api<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  const logout = async (sessionEnded = false) => {
    if (!sessionEnded) {
      try {
        await api('/auth/logout', { method: 'POST' });
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 401)) {
          setError('Não foi possível encerrar a sessão. Verifique a conexão e tente novamente.');
          return;
        }
      }
    }
    setError('');
    setUser(null);
    setProject(null);
  };
  if (loading)
    return (
      <div className="loading-screen">
        <span className="spinner" /> Carregando laboratórios…
      </div>
    );
  if (!user)
    return (
      <Auth
        initialNotice={error}
        onLogin={(u) => {
          setError('');
          setUser(u);
          history.replaceState(null, '', '/');
        }}
      />
    );
  if (project)
    return (
      <Suspense fallback={<div className="loading-screen">Abrindo laboratório…</div>}>
        <Workspace
          project={project}
          user={user}
          onClose={() => setProject(null)}
          onExpired={() => {
            void logout(true);
            setError('Sua sessão expirou. Entre novamente.');
          }}
        />
      </Suspense>
    );
  return (
    <>
      {error && (
        <div className="global-notice" role="alert">
          <span>{error}</span>
          <button className="icon-button" aria-label="Fechar aviso" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      <Dashboard
        user={user}
        onOpen={setProject}
        onLogout={(ended = false) => void logout(ended)}
        onUserUpdate={setUser}
      />
    </>
  );
}
// English loads its dictionary before the first render, so Portuguese never flashes.
void initI18n().finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
);
