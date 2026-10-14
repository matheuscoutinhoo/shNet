import { useState } from 'react';
import type { Snapshot } from '@shlab/engine';
import { cloneTopology } from './cloneTopology';
import { Modal } from '../components/Modal';
import { download } from '../api';
import type { LabController } from './useLab';
export function CloneReview({
  lab,
  selection,
  onApplied,
  onClose,
}: {
  lab: LabController;
  selection: string[];
  onApplied: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [source] = useState<Snapshot>(() => lab.engine.snapshot());
  const [result] = useState(() => {
    try {
      return { proposal: cloneTopology(source, selection), error: '' };
    } catch (e) {
      return { proposal: null, error: (e as Error).message };
    }
  });
  const [error, setError] = useState(result.error);
  const p = result.proposal;
  return (
    <Modal title="Clonar célula ou rack" onClose={onClose} wide>
      <p>
        Revise os novos endereços, VLANs e objetos. A aplicação está pausada; aplicar cria uma alteração que
        pode ser desfeita.
      </p>
      {error && <p role="alert">{error}</p>}
      {p && (
        <>
          <p>
            {p.diff.filter((d) => d.action === 'added').length} objetos novos · {p.addresses.length} endereços
            remapeados · {p.vlans.length} VLANs
          </p>
          {p.warnings.map((w) => (
            <p key={w} role="status">
              {w}
            </p>
          ))}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Equipamento</th>
                  <th>Origem</th>
                  <th>Clone</th>
                </tr>
              </thead>
              <tbody>
                {p.addresses.slice(0, 200).map((a, i) => (
                  <tr key={i}>
                    <td>{a.device}</td>
                    <td>{a.before}</td>
                    <td>{a.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.addresses.length > 200 && <p>Mostrando 200 endereços; a revisão exportada contém todos.</p>}
          <details>
            <summary>Objetos e VLANs da revisão</summary>
            <pre>
              {JSON.stringify(
                {
                  objects: p.diff.map((d) => ({ kind: d.kind, name: d.name, action: d.action })),
                  vlans: p.vlans,
                },
                null,
                2
              )}
            </pre>
          </details>
          <div className="button-row">
            <button
              className="button"
              onClick={() =>
                download(lab.name + '-clone-review', {
                  diff: p.diff,
                  addresses: p.addresses,
                  vlans: p.vlans,
                  warnings: p.warnings,
                })
              }
            >
              Exportar revisão
            </button>
            <button
              className="button primary"
              onClick={() => {
                if (
                  JSON.stringify({ ...lab.engine.state, viewport: undefined }) !==
                  JSON.stringify({ ...source, viewport: undefined })
                ) {
                  setError('O laboratório mudou durante a revisão. Feche e prepare o clone novamente.');
                  return;
                }
                const applied = lab.change((e) => {
                  e.state = { ...p.snapshot, viewport: e.state.viewport };
                  return true;
                });
                if (applied) {
                  onApplied(p.selected);
                  onClose();
                }
              }}
            >
              Aplicar clone
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
