import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type User, type Project } from './api';
import { Auth } from './Auth';
import { Dashboard } from './Dashboard';
const Workspace = lazy(() => import('./workspace/Workspace').then((m) => ({ default: m.Workspace })));
import './styles.css';
import '@fontsource-variable/space-grotesk';
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
  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* Already expired or revoked by password change. */
    }
    setUser(null);
    setProject(null);
  };
  if (loading)
    return (
      <div className="loading-screen">
        <span className="spinner" /> Preparando seu workspace…
      </div>
    );
  if (!user)
    return (
      <Auth
        onLogin={(u) => {
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
            setError('Sua sessão expirou. Entre novamente.');
            void logout();
          }}
        />
      </Suspense>
    );
  return (
    <>
      {error && (
        <div className="global-notice" onClick={() => setError('')}>
          {error}
        </div>
      )}
      <Dashboard user={user} onOpen={setProject} onLogout={() => void logout()} onUserUpdate={setUser} />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
