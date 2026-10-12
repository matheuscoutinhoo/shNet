import {
  cableMetrics,
  endpoint,
  linkOperational,
  linkSchema,
  validateMedia,
  wirelessMetrics,
  type Link,
} from '@shlab/engine';
import { useState, type FormEvent } from 'react';
import type { Connection } from '@xyflow/react';
import { Cable, Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';
const cableChoices = [
  ['serial', 'Serial WAN · DCE / DTE'],
  ['console', 'Console · UART'],
  ['copper', 'UTP Cat6 · direto'],
  ['crossover', 'UTP Cat6 · crossover'],
  ['fiber-sm', 'Fibra monomodo · SFP'],
  ['fiber-mm', 'Fibra multimodo · SFP/QSFP'],
  ['dac', 'DAC · SFP/QSFP (até 7 m)'],
] as const;
function CableOptions() {
  return cableChoices.map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
}
export function ConnectDialog({
  lab,
  initial,
  onClose,
}: {
  lab: LabController;
  initial?: Connection;
  onClose: () => void;
}) {
  const [a, setA] = useState(initial?.source ?? lab.engine.state.devices[0]?.id ?? ''),
    [b, setB] = useState(initial?.target ?? lab.engine.state.devices[1]?.id ?? ''),
    [cable, setCable] = useState<Link['cable']>('copper'),
    [error, setError] = useState('');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    let failure = '';
    const result = lab.change((sim) => {
      try {
        return sim.connect(
          { device: a, port: String(f.get('portA')) },
          { device: b, port: String(f.get('portB')) },
          cable,
          { distance: Number(f.get('distance')) }
        );
      } catch (e) {
        failure = (e as Error).message;
        throw e;
      }
    });
    if (result) onClose();
    else setError(failure);
  }
  const ports = (id: string) =>
    lab.engine.state.devices
      .find((d) => d.id === id)
      ?.interfaces.filter(
        (p) =>
          !p.logical &&
          !p.aggregate &&
          !p.tunnel &&
          !p.vxlan &&
          !p.capwapPeer &&
          !p.meshPeer &&
          p.media !== 'wifi'
      ) ?? [];
  const occupied = (device: string, port: string) =>
    lab.engine.state.links.some((l) => [l.a, l.b].some((p) => p.device === device && p.port === port));
  return (
    <Modal title="Conectar interfaces" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Escolha as duas portas e uma mídia fisicamente compatível.</p>
        <div className="form-grid">
          <label>
            Equipamento A
            <select value={a} onChange={(e) => setA(e.target.value)} required>
              {lab.engine.state.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                </option>
              ))}
            </select>
          </label>
          <label>
            Interface A
            <select name="portA" key={a} defaultValue={initial?.sourceHandle ?? undefined} required>
              {ports(a).map((p) => (
                <option value={p.id} key={p.id} disabled={occupied(a, p.id)}>
                  {p.name} · {p.media}
                  {occupied(a, p.id) ? ' (ocupada)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="connection-symbol">
          <Cable size={22} />
        </div>
        <div className="form-grid">
          <label>
            Equipamento B
            <select value={b} onChange={(e) => setB(e.target.value)} required>
              {lab.engine.state.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                </option>
              ))}
            </select>
          </label>
          <label>
            Interface B
            <select name="portB" key={b} defaultValue={initial?.targetHandle ?? undefined} required>
              {ports(b).map((p) => (
                <option value={p.id} key={p.id} disabled={occupied(b, p.id)}>
                  {p.name} · {p.media}
                  {occupied(b, p.id) ? ' (ocupada)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-grid">
          <label>
            Tipo de cabo
            <select value={cable} onChange={(e) => setCable(e.target.value as Link['cable'])}>
              <CableOptions />
            </select>
          </label>
          <label>
            Distância (metros)
            <input name="distance" type="number" min="0" max="100000" defaultValue={10} required />
          </label>
        </div>
        <div className="learning-card">
          <p>
            {cable === 'serial'
              ? 'Serial exige interfaces DCE/DTE e até 50 m. O clock do DCE define a transmissão.'
              : cable === 'console'
                ? 'Console exige portas UART compatíveis, mesma taxa de baud e até 15 m.'
                : cable === 'dac'
                  ? 'DAC exige módulos DAC, sockets iguais e distância até 7 m.'
                  : cable.startsWith('fiber')
                    ? 'Fibra exige transceivers compatíveis nas duas pontas. Portas SFP do catálogo vêm com módulos monomodo.'
                    : 'RJ45 · até 100 m no modelo. As portas usam Auto-MDIX conceitual, aceitando cabo direto ou crossover.'}
          </p>
        </div>
        {error && (
          <div role="alert" className="alert error">
            {error}
          </div>
        )}
        <button className="button primary" disabled={lab.engine.state.devices.length < 2}>
          <Cable size={16} /> Conectar equipamentos
        </button>
      </form>
    </Modal>
  );
}
export function LinkDialog({ lab, id, onClose }: { lab: LabController; id: string; onClose: () => void }) {
  const link = lab.engine.state.links.find((l) => l.id === id);
  const [error, setError] = useState('');
  if (!link) return null;
  if (link.cable === 'wireless' || link.cable === 'mesh') {
    const m = wirelessMetrics(lab.engine.state, link);
    return (
      <Modal title="Enlace wireless" onClose={onClose}>
        <p>
          {lab.engine.device(link.a.device).hostname} ↔ {lab.engine.device(link.b.device).hostname}
        </p>
        <p>
          Distância {m.distance.toFixed(1)} m · RSSI {m.rssi.toFixed(1)} dBm · SNR {m.snr.toFixed(1)} dB
        </p>
        <p>
          Interferência {m.interference.toFixed(1)} dB · Perda {(m.loss * 100).toFixed(1)}%
        </p>
        <p>Latência base {m.latency.toFixed(3)} ms</p>
        <p className="muted">
          O enlace é criado pelo rádio. Posição, canal, potência e obstáculos determinam os parâmetros.
        </p>
        <button
          className="button primary"
          onClick={() =>
            lab.change((sim) => {
              const current = sim.state.links.find((entry) => entry.id === id);
              if (current) current.up = !current.up;
            })
          }
        >
          {link.up ? 'Interromper enlace wireless' : 'Restaurar enlace wireless'}
        </button>
      </Modal>
    );
  }
  const metrics = cableMetrics(link);
  return (
    <Modal title="Propriedades da conexão" onClose={onClose}>
      <p className="muted">
        {lab.engine.device(link.a.device).hostname} ↔ {lab.engine.device(link.b.device).hostname} ·{' '}
        {link.cable}
      </p>
      <dl className="link-metrics" aria-label="Métricas da conexão">
        <dt>Estado físico</dt>
        <dd>{linkOperational(lab.engine.state, link) ? 'Operacional' : 'Inoperante'}</dd>
        <dt>Latência base</dt>
        <dd>{metrics.latency.toFixed(6)} ms</dd>
        <dt>Propagação no cabo</dt>
        <dd>{(metrics.propagation * 1000).toFixed(3)} µs</dd>
        <dt>Jitter do cenário</dt>
        <dd>{metrics.jitter.toFixed(3)} ms</dd>
        <dt>Perda do cenário</dt>
        <dd>{(metrics.loss * 100).toFixed(1)}%</dd>
      </dl>
      <p className="muted">
        O comprimento contribui para o tempo de propagação. Mídia, módulos e velocidades precisam ser
        compatíveis. A entrega também depende do tamanho do frame, das filas e do processamento.
      </p>
      {(link.loss > 0 || link.jitter > 0 || link.latency !== 2) && (
        <p className="muted">Este laboratório contém uma condição de transporte definida pelo cenário.</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          let failure = '';
          const result = lab.change((sim) => {
            try {
              const current = sim.state.links.find((entry) => entry.id === id);
              if (!current) throw new Error('Conexão inexistente.');
              const next = linkSchema.parse({
                ...current,
                up: f.get('up') === 'on',
                cable: String(f.get('cable')),
                distance: Number(f.get('distance')),
              });
              validateMedia(next, endpoint(sim.state, next.a).port, endpoint(sim.state, next.b).port);
              Object.assign(current, next);
              return true;
            } catch (failureCause) {
              failure = (failureCause as Error).message;
              throw failureCause;
            }
          });
          if (result) onClose();
          else setError(failure);
        }}
      >
        <label className="checkbox-label">
          <input name="up" type="checkbox" defaultChecked={link.up} /> Conexão ativa
        </label>
        <div className="form-grid">
          <label>
            Tipo de cabo
            <select name="cable" defaultValue={link.cable}>
              <CableOptions />
            </select>
          </label>
          <label>
            Comprimento do cabo (metros)
            <input
              name="distance"
              type="number"
              min="0"
              max="100000"
              step="0.1"
              defaultValue={link.distance}
              required
            />
          </label>
        </div>
        {error && (
          <div role="alert" className="alert error">
            {error}
          </div>
        )}
        <div className="button-row">
          <button className="button primary">Aplicar</button>
          <button
            className="button danger"
            type="button"
            onClick={() => {
              lab.change((sim) => sim.removeLink(id));
              onClose();
            }}
          >
            <Trash2 size={16} /> Remover cabo
          </button>
        </div>
      </form>
    </Modal>
  );
}
