import { useState } from 'react';
import { importIosConfig, type ConfigImportReport, type Device } from '@shlab/engine';
import type { LabController } from './useLab';

/** Pastes a real IOS configuration into the device: it boots from it and reports compatibility. */
export function ConfigImportPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [text, setText] = useState('');
  const [report, setReport] = useState<ConfigImportReport | null>(null);
  if (device.type !== 'router' && device.type !== 'switch') return null;
  const run = () => {
    const result = lab.change((e) => importIosConfig(e, device.id, text));
    if (result) setReport(result);
  };
  return (
    <details className="config-import">
      <summary>Importar configuração IOS</summary>
      <p className="muted">
        Cole um <code>show running-config</code> real. O equipamento reinicia com ele, como em{' '}
        <code>copy tftp: startup-config</code> seguido de <code>reload</code>; a configuração atual é
        substituída.
      </p>
      <textarea
        aria-label="Configuração IOS a importar"
        className="code-input"
        rows={10}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button className="button" disabled={!text.trim()} onClick={run}>
        Importar e reiniciar
      </button>
      {report && (
        <div aria-label="Relatório de compatibilidade">
          <p>
            {report.hostname}: {report.applied} de {report.lines} linhas aplicadas, {report.ignored.length}{' '}
            ignoradas e {report.rejected.length} rejeitadas.
          </p>
          {[...report.rejected, ...report.ignored].length > 0 && (
            <pre className="code-output">
              {[...report.rejected, ...report.ignored]
                .sort((a, b) => a.number - b.number)
                .map((item) => (item.number ? `${item.number}: ${item.line}\n  % ` : '% ') + item.message)
                .join('\n')}
            </pre>
          )}
        </div>
      )}
    </details>
  );
}
