import { useState } from 'react';
import { addCanvasItem } from '@shlab/engine';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';
export function CommentDialog({
  lab,
  selected,
  onClose,
}: {
  lab: LabController;
  selected?: string;
  onClose: () => void;
}) {
  const devices = lab.engine.state.devices,
    links = lab.engine.state.links;
  const [anchor, setAnchor] = useState(
    'device:' + (devices.find((d) => d.id === selected)?.id ?? devices[0]?.id ?? '')
  );
  return (
    <Modal title="Comentário ancorado" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const [kind, target] = anchor.split(':');
          const text = String(new FormData(event.currentTarget).get('comment'));
          const added = lab.change((engine) =>
            addCanvasItem(engine, {
              kind: 'comment',
              text,
              anchor: { kind, target },
              position: { x: 240, y: 0 },
              width: 230,
              height: 120,
              color: 'rose',
            })
          );
          if (added) onClose();
        }}
      >
        <label>
          Equipamento ou enlace
          <select
            aria-label="Âncora do comentário"
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
            required
          >
            {devices.map((d) => (
              <option value={'device:' + d.id} key={d.id}>
                {d.hostname}
              </option>
            ))}
            {links.map((l) => (
              <option value={'link:' + l.id} key={l.id}>
                {devices.find((d) => d.id === l.a.device)?.hostname} ↔{' '}
                {devices.find((d) => d.id === l.b.device)?.hostname}
              </option>
            ))}
          </select>
        </label>
        <label>
          Comentário
          <textarea name="comment" required maxLength={1000} autoFocus rows={5} />
        </label>
        <p className="muted">
          O comentário acompanha a âncora quando ela é movida e é removido quando ela é excluída.
        </p>
        <button className="button primary" disabled={!devices.length}>
          Adicionar comentário
        </button>
      </form>
    </Modal>
  );
}
