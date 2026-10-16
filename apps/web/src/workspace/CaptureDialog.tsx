import { useState } from 'react';
import { exportPcap } from '@shlab/engine';
import { Modal } from '../components/Modal';
import type { LabController } from './useLab';
export function CaptureDialog({ lab, onClose }: { lab: LabController; onClose: () => void }) {
  const [link, setLink] = useState(''),
    capture = exportPcap(lab.engine.state, link || undefined);
  return (
    <Modal title="Captura binária da simulação" onClose={onClose}>
      <p>
        {capture.retainedFrames} frames retidos em armazenamento independente do histórico visual. Início:{' '}
        {capture.startedAt.toFixed(0)} ms virtuais. Ethernet/VLAN, ARP, IPv4/IPv6, TCP, UDP, ICMP/NDP,
        DNS/EDNS, DHCPv4/v6 e relay, RIP, RADIUS, Modbus TCP, VXLAN e BGP/EVPN possuem codecs.
      </p>
      {capture.dropped > 0 && (
        <p role="alert">
          Captura truncada: {capture.dropped} frames antigos descartados pelo limite de 10.000 frames ou 2
          MiB.
        </p>
      )}
      <label>
        <input
          type="checkbox"
          checked={lab.engine.state.capture?.includeControl ?? false}
          onChange={(e) =>
            lab.change((engine) => {
              engine.state.capture ??= {
                frames: [],
                dropped: 0,
                includeControl: false,
                startedAt: engine.state.clock,
                bytes: 0,
              };
              engine.state.capture.includeControl = e.target.checked;
            })
          }
        />{' '}
        Capturar também tráfego de controle a partir de agora
      </label>
      <button
        className="button small"
        onClick={() =>
          lab.change((engine) => {
            engine.state.capture = {
              frames: [],
              dropped: 0,
              includeControl: engine.state.capture?.includeControl ?? false,
              startedAt: engine.state.clock,
              bytes: 0,
            };
          })
        }
      >
        Iniciar nova captura
      </button>
      <label>
        Enlace da captura
        <select value={link} onChange={(e) => setLink(e.target.value)}>
          <option value="">Todos os enlaces</option>
          {lab.engine.state.links.map((l) => (
            <option key={l.id} value={l.id}>
              {lab.engine.device(l.a.device).hostname} ↔ {lab.engine.device(l.b.device).hostname}
            </option>
          ))}
        </select>
      </label>
      <p>
        {capture.packets} frames exportáveis · {capture.excluded.length} omitidos.
      </p>
      {capture.excluded.length > 0 && (
        <details>
          <summary>Motivos das omissões</summary>
          <ul>
            {[...new Set(capture.excluded.map((e) => e.reason))].map((reason) => (
              <li key={reason}>
                {reason} — {capture.excluded.filter((e) => e.reason === reason).length} frames
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted">
        Protocolos sem formato binário, aplicações TCP com enquadramento didático, DNSSEC do modelo e
        fragmentos que transportam o envelope do simulador são omitidos.
      </p>
      <button
        className="button primary"
        disabled={!capture.packets}
        onClick={() => {
          const url = URL.createObjectURL(
              new Blob([capture.bytes.slice().buffer], { type: 'application/vnd.tcpdump.pcap' })
            ),
            anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = lab.name.replace(/[^a-zA-Z0-9_-]/g, '-') + '.pcap';
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Baixar PCAP
      </button>
    </Modal>
  );
}
