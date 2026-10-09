import { useState } from 'react';
import type { Device } from '@shlab/engine';
import type { LabController } from './useLab';

export function FirewallForm({ lab, device }: { lab: LabController; device: Device }) {
  const [mode, setMode] = useState(device.firewall?.zonePolicy ? 'zones' : 'trusted');
  const rules =
    device.firewall?.zonePolicy?.rules
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map(
        (rule) =>
          `${rule.sequence} ${rule.from} ${rule.to} ${rule.action} ${rule.protocol.toLowerCase()}${rule.destinationPort === undefined ? '' : ' eq ' + rule.destinationPort}`
      )
      .join('\n') ?? '';
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        lab.change((engine) => {
          const zones = new Map<string, string[]>();
          for (const port of device.interfaces) {
            const name = String(data.get('zone:' + port.id) ?? '').trim();
            if (name) zones.set(name, [...(zones.get(name) ?? []), port.id]);
          }
          const policyRules =
            mode === 'zones'
              ? String(data.get('rules') ?? '')
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const match =
                      /^(\d+) ([\w-]+) ([\w-]+) (inspect|permit|deny) (ip|tcp|udp|icmp)(?: eq (\d+))?$/i.exec(
                        line
                      );
                    if (!match)
                      throw new Error(
                        'Regra inválida: use sequência origem destino ação protocolo [eq porta].'
                      );
                    return {
                      sequence: Number(match[1]),
                      from: match[2],
                      to: match[3],
                      action: match[4].toLowerCase(),
                      protocol: match[5].toLowerCase() === 'ip' ? 'ip' : match[5].toUpperCase(),
                      ...(match[6] ? { destinationPort: Number(match[6]) } : {}),
                    };
                  })
              : [];
          engine.configureFirewall(device.id, {
            enabled: data.has('enabled'),
            application: device.firewall?.application,
            trustedPorts: mode === 'trusted' ? data.getAll('trusted') : (device.firewall?.trustedPorts ?? []),
            protocols:
              mode === 'trusted'
                ? data.getAll('protocol')
                : (device.firewall?.protocols ?? ['TCP', 'UDP', 'ICMP']),
            ...(mode === 'zones'
              ? {
                  zonePolicy: {
                    zones: [...zones].map(([name, ports]) => ({ name, ports })),
                    rules: policyRules,
                  },
                }
              : {}),
          });
        });
      }}
    >
      <label className="checkbox-label">
        <input name="enabled" type="checkbox" defaultChecked={device.firewall?.enabled} /> Ativar firewall
      </label>
      <label>
        Modo do firewall
        <select value={mode} onChange={(event) => setMode(event.target.value)}>
          <option value="trusted">Interfaces confiáveis</option>
          <option value="zones">Zonas e regras</option>
        </select>
      </label>
      {mode === 'trusted' ? (
        <>
          <fieldset>
            <legend>Protocolos rastreados</legend>
            {(['TCP', 'UDP', 'ICMP'] as const).map((protocol) => (
              <label className="checkbox-label" key={protocol}>
                <input
                  name="protocol"
                  type="checkbox"
                  value={protocol}
                  defaultChecked={(device.firewall
                    ? (device.firewall.protocols ?? ['TCP'])
                    : ['TCP', 'UDP', 'ICMP']
                  ).includes(protocol)}
                />
                {protocol}
              </label>
            ))}
          </fieldset>
          <p className="muted">
            Protocolos desmarcados seguem as ACLs. O retorno ICMP de erro exige uma citação correspondente à
            sessão rastreada. O próprio roteador usa as ACLs.
          </p>
          <fieldset>
            <legend>Interfaces confiáveis</legend>
            {device.interfaces
              .filter((port) => port.mode === 'routed')
              .map((port) => (
                <label className="checkbox-label" key={port.id}>
                  <input
                    name="trusted"
                    type="checkbox"
                    value={port.id}
                    defaultChecked={device.firewall?.trustedPorts.includes(port.id)}
                  />
                  {port.name} · {port.ip ?? 'Sem IPv4'}
                </label>
              ))}
          </fieldset>
        </>
      ) : (
        <>
          <fieldset>
            <legend>Zonas por interface</legend>
            {device.interfaces
              .filter((port) => port.mode === 'routed')
              .map((port) => (
                <label key={port.id}>
                  {port.name} · {port.ip ?? 'Sem IPv4'}
                  <input
                    name={'zone:' + port.id}
                    maxLength={32}
                    defaultValue={
                      device.firewall?.zonePolicy?.zones.find((zone) => zone.ports.includes(port.id))?.name ??
                      ''
                    }
                    placeholder="Sem zona"
                  />
                </label>
              ))}
          </fieldset>
          <label>
            Regras entre zonas
            <textarea
              name="rules"
              rows={6}
              defaultValue={rules}
              placeholder={'10 LAN WAN inspect ip\n20 WAN DMZ inspect tcp eq 80'}
            />
          </label>
          <p className="muted">
            Uma regra por linha: sequência, zona de origem, zona de destino, ação e protocolo. Use eq para
            filtrar a porta de destino TCP/UDP.
          </p>
          <p className="muted">
            A menor sequência correspondente decide. inspect rastreia e autoriza retorno; permit libera sem
            sessão; deny bloqueia, inclusive retornos. Sem regra, o tráfego entre zonas ou sem zona é
            descartado. Dentro da mesma zona, é permitido. Erros ICMP relacionados passam pelas mesmas ACLs e
            regras deny. O próprio roteador usa as ACLs.
          </p>
        </>
      )}
      <button className="button small">Aplicar firewall</button>
    </form>
  );
}
