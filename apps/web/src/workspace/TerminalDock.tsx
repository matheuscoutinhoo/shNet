import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Maximize2, Minimize2, Plus, TerminalSquare, X } from 'lucide-react';
import type { LabController } from './useLab';
import { observeDocument, tr } from '../i18n';

const Terminal = lazy(() => import('./Terminal').then((m) => ({ default: m.Terminal })));
type DockMode = 'docked' | 'maximized' | 'popout';

/** Opens a same-origin child window that shares this page's stylesheets. */
function usePopout(active: boolean, title: string, onClosed: () => void) {
  const [popup, setPopup] = useState<Window | null>(null);
  // The window is created once per pop-out session; later prop changes must not reopen it.
  const latest = useRef({ title, onClosed });
  latest.current = { title, onClosed };
  useEffect(() => {
    if (!active) return;
    const w = window.open('', 'shlab-terminals', 'width=980,height=640');
    if (!w) {
      latest.current.onClosed();
      return;
    }
    w.document.title = tr(latest.current.title);
    w.document.head.replaceChildren(
      ...[...document.querySelectorAll('style, link[rel="stylesheet"]')].map((node) => node.cloneNode(true))
    );
    for (const attribute of [...document.documentElement.attributes])
      w.document.documentElement.setAttribute(attribute.name, attribute.value);
    w.document.body.className = 'terminal-popout';
    w.document.body.replaceChildren();
    const stopTranslating = observeDocument(w.document.body);
    const closed = () => latest.current.onClosed();
    w.addEventListener('pagehide', closed);
    setPopup(w);
    return () => {
      stopTranslating();
      w.removeEventListener('pagehide', closed);
      w.close();
      setPopup(null);
    };
  }, [active]);
  return popup;
}

export function TerminalDock({
  lab,
  tabs,
  active,
  onActivate,
  onOpen,
  onCloseTab,
  onClose,
}: {
  lab: LabController;
  tabs: string[];
  active: string | null;
  onActivate: (id: string) => void;
  onOpen: (id: string) => void;
  onCloseTab: (id: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<DockMode>('docked');
  const popup = usePopout(mode === 'popout', 'Terminais · ' + lab.name, () => setMode('docked'));
  const devices = lab.engine.state.devices;
  const live = tabs.filter((id) => devices.some((d) => d.id === id));
  const current = active && live.includes(active) ? active : live[0];
  const hostname = (id: string) => devices.find((d) => d.id === id)?.hostname ?? id;
  const addable = devices
    .filter(
      (d) => !live.includes(d.id) && !['rack', 'patch-panel', 'ups'].includes(d.infrastructure?.kind ?? '')
    )
    .sort((a, b) => a.hostname.localeCompare(b.hostname, 'en', { numeric: true }));
  const content: ReactNode = (
    <section
      className={'terminal-dock ' + mode}
      aria-label="Terminais"
      onKeyDown={(event) => {
        // Delete/Backspace act on the dock (closing a tab), never on the selected canvas devices.
        if (event.key === 'Delete' || event.key === 'Backspace') event.stopPropagation();
        // Ctrl+PageUp/PageDown switch tabs, as in terminal emulators.
        if (!event.ctrlKey || !['PageUp', 'PageDown'].includes(event.key) || !current) return;
        event.preventDefault();
        const index = live.indexOf(current) + (event.key === 'PageDown' ? 1 : -1);
        onActivate(live[(index + live.length) % live.length]);
      }}
    >
      <div className="terminal-dock-bar">
        <TerminalSquare size={15} aria-hidden />
        <div className="terminal-tabs" role="tablist" aria-label="Sessões de terminal">
          {live.map((id) => (
            <span key={id} className={'terminal-tab' + (id === current ? ' active' : '')}>
              <button
                role="tab"
                aria-selected={id === current}
                aria-keyshortcuts="Delete"
                title={hostname(id) + ' · Delete fecha a aba'}
                onClick={() => onActivate(id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Delete') return;
                  event.preventDefault();
                  onCloseTab(id);
                }}
              >
                {hostname(id)}
              </button>
              {/* Mouse shortcut; keyboard and assistive technology close a tab with Delete. */}
              <span className="terminal-tab-close" aria-hidden onClick={() => onCloseTab(id)}>
                <X size={12} />
              </span>
            </span>
          ))}
        </div>
        <label className="terminal-dock-add" title="Abrir outro terminal">
          <Plus size={14} aria-hidden />
          <select
            aria-label="Abrir terminal de outro equipamento"
            value=""
            onChange={(event) => event.target.value && onOpen(event.target.value)}
          >
            <option value="">Abrir…</option>
            {addable.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </select>
        </label>
        <span className="terminal-dock-tools">
          {mode !== 'popout' && (
            <button
              className="icon-button"
              aria-label={mode === 'maximized' ? 'Restaurar terminais' : 'Maximizar terminais'}
              title={mode === 'maximized' ? 'Restaurar' : 'Maximizar'}
              onClick={() => setMode(mode === 'maximized' ? 'docked' : 'maximized')}
            >
              {mode === 'maximized' ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          <button
            className="icon-button"
            aria-label={mode === 'popout' ? 'Trazer terminais de volta' : 'Abrir terminais em outra janela'}
            title={mode === 'popout' ? 'Trazer de volta' : 'Abrir em outra janela'}
            onClick={() => setMode(mode === 'popout' ? 'docked' : 'popout')}
          >
            <ExternalLink size={15} />
          </button>
          <button className="icon-button" aria-label="Fechar terminais" title="Fechar" onClick={onClose}>
            <X size={15} />
          </button>
        </span>
      </div>
      <div className="terminal-dock-body" role="tabpanel">
        {current ? (
          <Suspense fallback={<p className="muted">Carregando terminal…</p>}>
            <Terminal key={current} lab={lab} deviceId={current} compact />
          </Suspense>
        ) : (
          <p className="muted">Escolha um equipamento em “Abrir…”.</p>
        )}
      </div>
    </section>
  );
  if (mode === 'popout' && popup)
    return (
      <>
        <div className="terminal-dock-placeholder" role="status">
          <TerminalSquare size={15} aria-hidden /> {live.length} terminais em outra janela
          <button className="button small" onClick={() => setMode('docked')}>
            Trazer de volta
          </button>
        </div>
        {createPortal(content, popup.document.body)}
      </>
    );
  return content;
}
