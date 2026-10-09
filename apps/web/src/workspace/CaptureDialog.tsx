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
        Frames enviados nos {capture.retainedEvents} eventos retidos. Os horários começam no tempo virtual
        zero. Ethernet/VLAN, ARP, IPv4/IPv6, TCP, UDP, ICMP/NDP, DNS/EDNS, DHCPv6/relay, RIP e RADIUS possuem
        codecs.
      </p>
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
              <li key={reason}>{reason}</li>
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
