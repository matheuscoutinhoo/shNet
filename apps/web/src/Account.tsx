import { useEffect, useState, type FormEvent } from 'react';
import { UserRound, Monitor, KeyRound, Trash2, LogOut, Save } from 'lucide-react';
import { api, type User } from './api';
import { Modal } from './components/Modal';

interface Session {
  id: string;
  user_agent: string;
  created_at: string;
  expires_at: string;
  is_current: boolean;
}
export function Account({
  user,
  onUpdate,
  onLogout,
  onClose,
}: {
  user: User;
  onUpdate: (user: User) => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState('profile');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => api<Session[]>('/auth/sessions').then(setSessions);
  useEffect(() => {
    void refresh().catch((cause) => setError(cause.message));
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir.');
    } finally {
      setBusy(false);
    }
  }
  function form(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return new FormData(event.currentTarget);
  }
  return (
    <Modal title="Conta e segurança" onClose={onClose}>
      <div className="account-tabs" role="tablist" aria-label="Configurações da conta">
        {[
          { id: 'profile', label: 'Perfil', icon: UserRound },
          { id: 'sessions', label: 'Sessões', icon: Monitor },
          { id: 'password', label: 'Senha', icon: KeyRound },
          { id: 'delete', label: 'Excluir conta', icon: Trash2 },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => {
              setTab(item.id);
              setError('');
              setMessage('');
            }}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'profile' && (
        <form
          onSubmit={(event) => {
            const data = form(event);
            void perform(async () => {
              onUpdate(
                await api<User>('/auth/profile', { method: 'PATCH', body: { name: data.get('name') } })
              );
              setMessage('Perfil atualizado.');
            });
          }}
        >
          <label>
            Nome de exibição
            <input
              name="name"
              defaultValue={user.name}
              minLength={2}
              maxLength={80}
              required
              autoComplete="name"
            />
          </label>
          <label>
            E-mail da conta
            <input value={user.email} readOnly />
          </label>
          <button className="button primary" disabled={busy}>
            <Save size={16} /> Salvar perfil
          </button>
        </form>
      )}
      {tab === 'sessions' && (
        <section>
          <div className="account-session-list">
            {sessions.map((session) => (
              <div className="account-session" key={session.id}>
                <Monitor size={20} />
                <div>
                  <strong>{session.is_current ? 'Esta sessão' : 'Outra sessão'}</strong>
                  <p>{session.user_agent || 'Cliente não identificado'}</p>
                  <small>Iniciada em {new Date(session.created_at).toLocaleString('pt-BR')}</small>
                </div>
                <button
                  className="icon-button"
                  title="Encerrar sessão"
                  aria-label={session.is_current ? 'Encerrar esta sessão' : 'Encerrar outra sessão'}
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const result = await api<{ current: boolean }>('/auth/sessions/' + session.id, {
                        method: 'DELETE',
                      });
                      if (result.current) onLogout();
                      else await refresh();
                    })
                  }
                >
                  <LogOut size={17} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="button"
            disabled={busy || sessions.length < 2}
            onClick={() =>
              void perform(async () => {
                await api('/auth/sessions/revoke-others', { method: 'POST' });
                await refresh();
                setMessage('Outras sessões encerradas.');
              })
            }
          >
            <LogOut size={16} /> Encerrar outras sessões
          </button>
        </section>
      )}
      {tab === 'password' && (
        <form
          onSubmit={(event) => {
            const data = form(event);
            void perform(async () => {
              await api('/auth/change-password', {
                method: 'POST',
                body: { currentPassword: data.get('currentPassword'), password: data.get('password') },
              });
              onLogout();
            });
          }}
        >
          <label>
            Senha atual
            <input name="currentPassword" type="password" autoComplete="current-password" required />
          </label>
          <label>
            Nova senha
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </label>
          <p className="muted">A alteração encerra todas as sessões.</p>
          <button className="button primary" disabled={busy}>
            <KeyRound size={16} /> Alterar senha
          </button>
        </form>
      )}
      {tab === 'delete' && (
        <form
          onSubmit={(event) => {
            const data = form(event);
            void perform(async () => {
              await api('/auth/account', { method: 'DELETE', body: { password: data.get('password') } });
              onLogout();
            });
          }}
        >
          <p>Excluir sua conta remove permanentemente seus laboratórios e snapshots.</p>
          <label>
            Confirme sua senha
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" required /> Entendo que esta ação é irreversível
          </label>
          <button className="button danger" disabled={busy}>
            <Trash2 size={16} /> Excluir minha conta
          </button>
        </form>
      )}
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="alert" role="status">
          {message}
        </div>
      )}
    </Modal>
  );
}
