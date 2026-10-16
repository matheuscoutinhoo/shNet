import { useState } from 'react';
import { quorumCommittedView, type Device } from '@shlab/engine';
import type { LabController } from './useLab';

export function QuorumPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [pending, setPending] = useState<{ term: number; index: number }>();
  const q = device.quorum;
  if (device.type !== 'server') return null;
  const candidates = lab.engine.state.devices.filter(
    (d) => d.type === 'server' && d.id !== device.id && !d.quorum
  );
  const confirmed =
    pending && q && q.node.log[pending.index - 1]?.term === pending.term && q.node.commit >= pending.index;
  return (
    <section className="protocol-panel quorum-panel" data-quorum-role={q?.node.role ?? 'disabled'}>
      <h4>Laboratório de quorum e dados replicados</h4>
      <p className="muted">
        Três réplicas completas, eleição por votos e confirmação por maioria. Cada par usa um cabo dedicado
        sem IP. Este armazenamento é independente do banco SQL e dos demais serviços.
      </p>
      {q ? (
        <>
          <p aria-live="polite">
            {q.node.role} · termo {q.node.term} · commit {q.node.commit}/{q.node.log.length}
          </p>
          <p>
            {q.node.members
              .map((id) => lab.engine.state.devices.find((d) => d.id === id)?.hostname ?? id)
              .join(', ')}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              lab.change(
                (e) =>
                  setPending(
                    e.proposeQuorumLab(device.id, {
                      kind: 'put',
                      key: String(data.get('key')),
                      value: String(data.get('value')),
                    })
                  ),
                false
              );
            }}
          >
            <label>
              Chave replicada
              <input
                name="key"
                pattern="[a-zA-Z0-9_.:-]{1,64}"
                maxLength={64}
                required
                defaultValue="registro"
              />
            </label>
            <label>
              Valor replicado
              <input name="value" maxLength={4096} required defaultValue="valor do laboratório" />
            </label>
            <button
              className="button small"
              disabled={!device.power || q.node.role !== 'leader' || q.node.log.length >= 256}
            >
              Propor gravação
            </button>
          </form>
          {pending && (
            <p aria-live="polite">
              Operação termo {pending.term}, índice {pending.index}:{' '}
              {confirmed ? 'confirmada por maioria' : 'sem confirmação desta operação'}
            </p>
          )}
          <details>
            <summary>Cópia local confirmada (histórica)</summary>
            <pre>{JSON.stringify(quorumCommittedView(q.node), null, 2)}</pre>
          </details>
          <p className="muted">
            Um líder isolado pode continuar se considerando líder, mas não confirma novas operações. A cópia
            histórica não prova leitura atual. Limite: 256 entradas; sem compactação ou alteração de membros.
          </p>
          <button
            className="button small"
            onClick={() => {
              lab.change((e) => e.removeQuorumLab(device.id));
              setPending(undefined);
            }}
          >
            Remover grupo de quorum
          </button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            lab.change((e) =>
              e.configureQuorumLab([device.id, String(data.get('second')), String(data.get('third'))])
            );
            setPending(undefined);
          }}
        >
          {(['second', 'third'] as const).map((name, index) => (
            <label key={name}>
              Servidor réplica {index + 2}
              <select name={name} required defaultValue="">
                <option value="">Selecione</option>
                {candidates.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hostname}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button className="button small" disabled={candidates.length < 2}>
            Criar grupo de três réplicas
          </button>
        </form>
      )}
    </section>
  );
}
