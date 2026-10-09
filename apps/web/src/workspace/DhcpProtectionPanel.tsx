import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function DhcpProtectionPanel({ lab, device }: { lab: LabController; device: Device }) {
  const c = device.dhcpSnooping;
  const [json, setJson] = useState(() =>
    JSON.stringify(
      c
        ? {
            enabled: c.enabled,
            vlans: c.vlans,
            trustedPorts: c.trustedPorts,
            sourceGuard: c.sourceGuard,
            arpInspection: c.arpInspection,
            staticBindings: c.staticBindings,
          }
        : {
            enabled: true,
            vlans: [1],
            trustedPorts: [],
            sourceGuard: false,
            arpInspection: false,
            staticBindings: [],
          },
      null,
      2
    )
  );
  if (device.type !== 'switch')
    return (
      <section>
        <h4>Detecção de conflitos IPv4</h4>
        <p className="muted">
          Antes de aplicar uma nova concessão, o cliente envia três ARP probes. Um conflito gera DHCPDECLINE e
          nova descoberta.
        </p>
        {device.interfaces
          .filter((p) => p.mode === 'routed' && !p.channel)
          .map((p) => (
            <label className="checkbox-label" key={p.id}>
              <input
                type="checkbox"
                checked={p.dhcpConflictDetection ?? false}
                onChange={(ev) =>
                  lab.change((e) => e.setDhcpConflictDetection(device.id, p.id, ev.target.checked))
                }
              />
              {p.name}: verificar endereço por ARP
            </label>
          ))}
        {device.dhcpServer?.declined?.map((v) => (
          <p key={v.address}>
            Conflito: {v.address}; quarentena até {Math.round(v.expiresAt / 1000)} s.
          </p>
        ))}
      </section>
    );
  return (
    <section className="dhcp-protection">
      <h4>DHCP snooping, DAI e IP Source Guard</h4>
      <p className="muted">
        Configure IDs das portas que levam ao servidor em trustedPorts. REQUEST/ACK aprendem
        IP/MAC/VLAN/porta. Endereços fixos exigem staticBindings ao ativar DAI ou Source Guard.
      </p>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          lab.change((e) => e.configureDhcpSnooping(device.id, JSON.parse(json)));
        }}
      >
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Proteção DHCP do switch"
          schema={configurationSchemas.dhcpProtection}
          className="config-json"
          rows={12}
          value={json}
          onChange={(ev) => setJson(ev.target.value)}
        />
        <button className="button small primary">Aplicar proteção DHCP</button>
      </form>
      <p>
        {c?.enabled ? 'Ativo' : 'Desabilitado'} · descartes {c?.dropped ?? 0} · bindings{' '}
        {c?.bindings.length ?? 0}
      </p>
      {c?.bindings.map((b) => (
        <p key={b.vlan + ':' + b.ip}>
          {b.ip} → {b.mac} · VLAN {b.vlan} · {device.interfaces.find((p) => p.id === b.port)?.name}
        </p>
      ))}
    </section>
  );
}
