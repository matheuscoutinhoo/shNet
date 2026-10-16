import { useState } from 'react';
import { quorumCommittedView, quorumBase, quorumLastIndex, quorumEntryAt, type Device } from '@shlab/engine';
import type { LabController } from './useLab';

export function QuorumPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [pending, setPending] = useState<{ term: number; index: number }>();
  const q = device.quorum;
  if (device.type !== 'server') return null;
  const candidates = lab.engine.state.devices.filter(
    (d) => d.type === 'server' && d.id !== device.id && !d.quorum
  );
  const confirmed =
    pending &&
    q &&
    (quorumEntryAt(q.node, pending.index)?.term === pending.term ||
      (q.node.snapshot?.index === pending.index && q.node.snapshot.term === pending.term)) &&
    q.node.commit >= pending.index;
  return (
    <section className="protocol-panel quorum-panel" data-quorum-role={q?.node.role ?? 'disabled'}>
      <h4>Laboratório de quorum e dados replicados</h4>
      <p className="muted">
        Três réplicas completas, eleição por votos e confirmação por maioria. Cada par usa um cabo dedicado
        sem IP.{' '}
        {device.databaseHa
          ? 'Este grupo está vinculado ao banco SQL; use consultas pela rede.'
          : 'Este armazenamento é independente do banco SQL e dos demais serviços.'}
      </p>
      {q ? (
        <>
          <p aria-live="polite">
            {q.node.role} · termo {q.node.term} · commit {q.node.commit}/{quorumLastIndex(q.node)}
          </p>
          <p data-quorum-checkpoint={quorumBase(q.node)}>
            Checkpoint {quorumBase(q.node)} · {q.node.log.length}/256 entradas retidas ·{' '}
            {quorumLastIndex(q.node) - q.node.commit}/128 sem confirmação
          </p>
          {q.node.receiving && (
            <p>
              Recebendo checkpoint {q.node.receiving.index}: {q.node.receiving.dataHex.length / 2}/
              {q.node.receiving.total} bytes; ainda não instalado.
            </p>
          )}
          <button
            className="button small"
            disabled={!device.power || q.node.commit <= quorumBase(q.node)}
            onClick={() => lab.change((e) => e.compactQuorumLab(device.id), false)}
          >
            Compactar histórico confirmado
          </button>
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
                    e.proposeQuorumLab(
                      device.id,
                      data.get('operation') === 'delete'
                        ? { kind: 'delete' as const, key: String(data.get('key')) }
                        : {
                            kind: 'put' as const,
                            key: String(data.get('key')),
                            value: String(data.get('value')),
                          }
                    )
                  ),
                false
              );
            }}
          >
            <label>
              Operação replicada
              <select name="operation" defaultValue="put">
                <option value="put">Gravar chave</option>
                <option value="delete">Excluir chave</option>
              </select>
            </label>
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
              <input name="value" maxLength={4096} defaultValue="valor do laboratório" />
            </label>
            <button
              className="button small"
              disabled={
                !!device.databaseHa ||
                !device.power ||
                q.node.role !== 'leader' ||
                q.node.log.length >= 256 ||
                quorumLastIndex(q.node) - q.node.commit >= 128
              }
            >
              Propor operação
            </button>
          </form>
          {pending && (
            <p aria-live="polite">
              Operação termo {pending.term}, índice {pending.index}:{' '}
              {confirmed
                ? 'confirmada por maioria'
                : pending.index < quorumBase(q.node)
                  ? 'índice compactado; confirmação individual indisponível'
                  : 'sem confirmação desta operação'}
            </p>
          )}
          <details>
            <summary>Cópia local confirmada (histórica)</summary>
            <pre>{JSON.stringify(quorumCommittedView(q.node), null, 2)}</pre>
          </details>
          <p className="muted">
            Um líder isolado pode continuar se considerando líder, mas não confirma novas operações. A cópia
            histórica não prova leitura atual. Compactação automática de prefixos confirmados, até 256
            entradas retidas, 128 sem confirmação e checkpoint de 512 KiB. Sem alteração de membros.
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
