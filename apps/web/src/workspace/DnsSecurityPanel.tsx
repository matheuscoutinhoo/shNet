import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { dnssecAnchor, type Device } from '@shlab/engine';
import type { LabController } from './useLab';
export function DnsSecurityPanel({ lab, device }: { lab: LabController; device: Device }) {
  const [json, setJson] = useState(() =>
    JSON.stringify(
      {
        resolver: device.dnsResolver ?? {
          validation: 'off',
          anchors: [],
          edns: { version: 0, udpSize: 1232, dnssecOk: true },
        },
        ...(['server', 'router'].includes(device.type) ? { zones: device.dnsServer?.zones ?? [] } : {}),
      },
      null,
      2
    )
  );
  return (
    <section>
      <h4>DNSSEC e EDNS</h4>
      <p className="muted">
        EDNS anuncia o tamanho UDP e DO solicita assinaturas. Para assinar uma zona, informe name, seed (64
        dígitos hexadecimais) e validity em segundos. Copie seu digest DS para anchors do resolvedor.
      </p>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          lab.change((e) => {
            const c = JSON.parse(json);
            e.configureDnsSecurity(device.id, c.resolver, c.zones);
          });
        }}
      >
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Configuração DNSSEC / EDNS"
          schema={configurationSchemas.dnsSecurity}
          className="config-json"
          rows={10}
          value={json}
          onChange={(ev) => setJson(ev.target.value)}
        />
        <button className="button small primary">Aplicar DNSSEC / EDNS</button>
      </form>
      {device.dnsServer?.zones?.map((z) => (
        <p key={z.name}>
          <strong>DS {z.name} · algoritmo 15 / SHA-256</strong>
          <br />
          <code className="break-all">{dnssecAnchor(z).digest}</code>
        </p>
      ))}
      <p>
        Validação: {device.dnsResolver?.validation ?? 'off'} · última consulta:{' '}
        {device.dnsQueries?.at(-1)?.security ?? '—'}
      </p>
    </section>
  );
}
