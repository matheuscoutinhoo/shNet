import { wirelessMetrics } from '@shlab/engine';
import { useState, type FormEvent } from 'react';
import type { Connection } from '@xyflow/react';
import { Cable, Trash2 } from 'lucide-react';
import { linkSchema, type Link } from '@shlab/engine';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';
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
              <option value="serial">Serial WAN · DCE / DTE</option>
              <option value="console">Console · UART</option>
              <option value="copper">UTP Cat6 · direto</option>
              <option value="crossover">UTP Cat6 · crossover</option>
              <option value="fiber-sm">Fibra monomodo · SFP</option>
              <option value="fiber-mm">Fibra multimodo · SFP/QSFP</option>
              <option value="dac">DAC · SFP/QSFP (até 7 m)</option>
            </select>
          </label>
          <label>
            Distância (metros)
            <input name="distance" type="number" min="0" max="100000" defaultValue={10} required />
          </label>
        </div>
        <div className="learning-card">
          <p>
            {cable === 'dac'
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
  const link = lab.engine.state.links.find((l) => l.id === id)!;
  if (link.cable === 'wireless') {
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
        <p className="muted">
          O enlace é criado pelo rádio. Posição, canal, potência e obstáculos determinam os parâmetros.
        </p>
        <button
          className="button primary"
          onClick={() =>
            lab.change(() => {
              link.up = !link.up;
            })
          }
        >
          {link.up ? 'Interromper enlace wireless' : 'Restaurar enlace wireless'}
        </button>
      </Modal>
    );
  }
  return (
    <Modal title="Propriedades da conexão" onClose={onClose}>
      <p className="muted">
        {lab.engine.device(link.a.device).hostname} ↔ {lab.engine.device(link.b.device).hostname} ·{' '}
        {link.cable}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const result = lab.change(() => {
            Object.assign(
              link,
              linkSchema.parse({
                ...link,
                up: f.get('up') === 'on',
                latency: Number(f.get('latency')),
                loss: Number(f.get('loss')) / 100,
                jitter: Number(f.get('jitter')),
              })
            );
            return true;
          });
          if (result) onClose();
        }}
      >
        <label className="checkbox-label">
          <input name="up" type="checkbox" defaultChecked={link.up} /> Conexão ativa
        </label>
        <div className="form-grid">
          <label>
            Latência (ms)
            <input name="latency" type="number" step=".1" min=".1" max="10000" defaultValue={link.latency} />
          </label>
          <label>
            Jitter (ms)
            <input name="jitter" type="number" step=".1" min="0" max="10000" defaultValue={link.jitter} />
          </label>
        </div>
        <label>
          Perda de pacotes (%)
          <input name="loss" type="number" step=".1" min="0" max="100" defaultValue={link.loss * 100} />
        </label>
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
