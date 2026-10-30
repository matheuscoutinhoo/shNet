import { useState, type ReactNode } from 'react';
import { configChanges } from '@shlab/engine';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';

/** Unsaved changes of one device: running-config compared with startup-config. */
export function ConfigChangesPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [open, setOpen] = useState(false);
  if (device.type !== 'router' && device.type !== 'switch') return null;
  let body: ReactNode = null;
  if (open) {
    try {
      const diff = configChanges(lab.engine, device.id);
      body = !diff.saved ? (
        <p className="muted">
          Ainda não há startup-config. Use <code>write memory</code> para salvar; até lá, toda a configuração
          se perde em um reload.
        </p>
      ) : !diff.changes.length ? (
        <p className="muted">Nenhuma alteração desde o último write memory.</p>
      ) : (
        <>
          <p className="muted">
            {diff.changes.filter((line) => /^\s?[+-]/.test(line)).length} linhas diferem. “+” existe só na
            running-config; “−” só na startup-config (equivale a <code>show archive config differences</code>
            ).
          </p>
          <pre className="code-output" aria-label="Diferenças de configuração">
            {diff.changes.map((line, i) => (
              <span
                key={i}
                className={
                  'config-diff-line' + (/^\s?\+/.test(line) ? ' added' : /^\s?-/.test(line) ? ' removed' : '')
                }
              >
                {line + '\n'}
              </span>
            ))}
          </pre>
        </>
      );
    } catch (error) {
      body = <p role="alert">{(error as Error).message}</p>;
    }
  }
  return (
    <details className="config-changes" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Alterações não salvas (running × startup)</summary>
      {body}
    </details>
  );
}
