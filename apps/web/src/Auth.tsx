import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowLeft, ShieldCheck, Network, Layers, TerminalSquare } from 'lucide-react';
import { api, type User } from './api';
import { Brand } from './components/Brand';
import { LanguageSwitch } from './i18n/LanguageSwitch';
type Mode = 'login' | 'register' | 'forgot' | 'verify' | 'reset';
const initialMode = (): Mode => {
  const action = new URLSearchParams(location.search).get('action');
  return action === 'verify' ? 'verify' : action === 'reset' ? 'reset' : 'login';
};
const initialToken = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
if (initialToken) history.replaceState(null, '', location.pathname + location.search);
export function Auth({
  onLogin,
  initialNotice = '',
}: {
  onLogin: (user: User) => void;
  initialNotice?: string;
}) {
  const [mode, setMode] = useState<Mode>(initialMode),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [notice, setNotice] = useState(initialNotice),
    [busy, setBusy] = useState(false),
    [email, setEmail] = useState(''),
    [emailEnabled, setEmailEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    api<{ emailEnabled: boolean }>('/auth/capabilities')
      .then((capabilities) => {
        if (active) setEmailEnabled(capabilities.emailEnabled);
      })
      .catch(() => {
        if (active) setEmailEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const change = (next: Mode) => {
    setMode(next);
    setError('');
    setMessage('');
    setNotice('');
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    setMessage('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'login') {
        const r = await api<{ user: User }>('/auth/login', {
          method: 'POST',
          body: { email, password: form.get('password') },
        });
        onLogin(r.user);
      } else if (mode === 'register') {
        const r = await api<{ message: string }>('/auth/register', {
          method: 'POST',
          body: { name: form.get('name'), email, password: form.get('password') },
        });
        setMessage(r.message);
        if (emailEnabled === false) setMode('login');
      } else if (mode === 'forgot') {
        const r = await api<{ message: string }>('/auth/forgot-password', {
          method: 'POST',
          body: { email },
        });
        setMessage(r.message);
      } else if (mode === 'verify') {
        const r = await api<{ message: string }>('/auth/verify-email', {
          method: 'POST',
          body: { token: initialToken },
        });
        setMessage(r.message);
        setMode('login');
      } else {
        const r = await api<{ message: string }>('/auth/reset-password', {
          method: 'POST',
          body: { token: initialToken, password: form.get('password') },
        });
        setMessage(r.message);
        setMode('login');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Brand />
        <div className="story-body">
          <span className="eyebrow">SIMULADOR DE REDES</span>
          <h1>
            Topologias de rede.
            <br />
            <span>Equipamentos e protocolos.</span>
          </h1>
          <p>
            Configure equipamentos e observe o tráfego
            <br />
            entre os dispositivos do laboratório.
          </p>
          <div className="network-illustration">
            <div className="network-line line-a" />
            <div className="network-line line-b" />
            <div className="network-line line-c" />
            <span className="illustration-node n1">
              <TerminalSquare />
              <small>PC-01</small>
            </span>
            <span className="illustration-node n2">
              <Network />
              <small>SW-CORE</small>
            </span>
            <span className="illustration-node n3">
              <Layers />
              <small>ROUTER</small>
            </span>
            <span className="illustration-packet">
              ICMP · Echo Request <ArrowRight size={14} />
            </span>
          </div>
          <div className="story-caption">
            <span className="live-dot" /> Simulação de tráfego entre equipamentos.
          </div>
        </div>
        <footer>shLab · Simulação de redes</footer>
      </section>
      <section className="auth-form-side">
        <LanguageSwitch className="auth-language" />
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-form-wrap">
          <div className="badge">
            <ShieldCheck size={14} /> Acesso aos laboratórios
          </div>
          <h2>
            {
              {
                login: 'Entrar no shLab',
                register: 'Criar conta',
                forgot: 'Recuperar acesso',
                verify: 'Confirme seu e-mail.',
                reset: 'Escolha uma nova senha.',
              }[mode]
            }
          </h2>
          <p className="muted">
            {
              {
                login: 'Entre para acessar seus laboratórios.',
                register: 'Informe seus dados para criar uma conta.',
                forgot: 'Enviaremos um link seguro para redefinir sua senha.',
                verify: 'Confirme abaixo para ativar sua conta no shLab.',
                reset: 'Use pelo menos 12 caracteres para proteger sua conta.',
              }[mode]
            }
          </p>
          <form onSubmit={submit}>
            {mode === 'register' && (
              <label>
                Seu nome
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={80}
                  autoComplete="name"
                  placeholder="Seu nome"
                />
              </label>
            )}
            {['login', 'register', 'forgot'].includes(mode) && (
              <label>
                E-mail
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="voce@exemplo.com"
                />
              </label>
            )}
            {['login', 'register', 'reset'].includes(mode) && (
              <label>
                Senha
                <input
                  name="password"
                  type="password"
                  required
                  minLength={mode === 'login' ? 1 : 12}
                  maxLength={128}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder={mode === 'login' ? 'Sua senha' : 'No mínimo 12 caracteres'}
                />
              </label>
            )}
            {mode === 'login' && emailEnabled && (
              <button type="button" className="text-button forgot" onClick={() => change('forgot')}>
                Esqueceu sua senha?
              </button>
            )}
            {notice && (
              <div className="alert warning" role="alert">
                {notice}
              </div>
            )}
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            {message && (
              <div className="alert success" role="status">
                {message}
              </div>
            )}
            <button className="button primary auth-submit" disabled={busy || emailEnabled === null}>
              {busy
                ? 'Aguarde…'
                : {
                    login: 'Entrar no shLab',
                    register: 'Criar conta',
                    forgot: 'Enviar link de recuperação',
                    verify: 'Verificar e-mail',
                    reset: 'Salvar nova senha',
                  }[mode]}
              <ArrowRight size={17} />
            </button>
          </form>
          {mode === 'login' ? (
            <>
              <p className="auth-switch">
                Ainda não tem uma conta?{' '}
                <button className="text-button" onClick={() => change('register')}>
                  Criar conta
                </button>
              </p>
              {emailEnabled && (
                <button
                  className="text-button verification-retry"
                  disabled={!email || busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await api<{ message: string }>('/auth/request-verification', {
                        method: 'POST',
                        body: { email },
                      });
                      setMessage(r.message);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Reenviar verificação de e-mail
                </button>
              )}
            </>
          ) : (
            <button className="text-button auth-back" onClick={() => change('login')}>
              <ArrowLeft size={15} /> Voltar para o login
            </button>
          )}
          <div className="auth-trust">
            <ShieldCheck size={16} /> Seus laboratórios são privados.
          </div>
        </div>
      </section>
    </main>
  );
}
