import { ConfigEditor, configChoices } from '../components/ConfigEditor';
import { configurationSchemas } from '@shlab/engine';
import { useState } from 'react';
import { type Device, type NetworkInterface, ipv6Number, ipv6String, network6 } from '@shlab/engine';
import type { LabController } from './useLab';

export function Dhcp6Panel({
  lab,
  device,
  port,
}: {
  lab: LabController;
  device: Device;
  port?: NetworkInterface;
}) {
  const [operation, setOperation] = useState('client');
  const clientInput = () => ({
    enabled: port?.dhcp6?.enabled ?? true,
    requestAddress: port?.dhcp6?.requestAddress ?? true,
    requestPrefix: port?.dhcp6?.requestPrefix ?? false,
    rapidCommit: port?.dhcp6?.rapidCommit ?? false,
    ...(port?.dhcp6?.delegatePort ? { delegatePort: port.dhcp6.delegatePort } : {}),
  });
  const sample = (op: string) => {
    if (op === 'client') return clientInput();
    if (op === 'relay')
      return {
        enabled: port?.dhcp6Relay?.enabled ?? true,
        servers: port?.dhcp6Relay?.servers ?? ['2001:db8:2::10'],
      };
    if (op === 'udp') return device.udp6Services?.[0] ?? { kind: 'echo', port: 7, enabled: true };
    if (device.dhcp6Server)
      return {
        enabled: device.dhcp6Server.enabled,
        rapidCommit: device.dhcp6Server.rapidCommit,
        relayPeers: device.dhcp6Server.relayPeers,
        pools: device.dhcp6Server.pools,
      };
    const ip = port?.ipv6?.addresses.find((a) => a.origin !== 'link-local')?.ip ?? '2001:db8:1::1',
      n = ipv6Number(network6(ip, 64));
    return {
      enabled: true,
      rapidCommit: false,
      pools: [
        {
          name: 'LAN',
          port: port?.id ?? 'p0',
          addresses: { start: ipv6String(n + 0x100n), end: ipv6String(n + 0x1ffn) },
          validMs: 60000,
          preferredMs: 45000,
          t1Ms: 20000,
          t2Ms: 40000,
          dns: [],
        },
      ],
    };
  };
  const [value, setValue] = useState(() => JSON.stringify(clientInput(), null, 2));
  return (
    <section className="ipv6-services">
      <h3>DHCPv6 e UDP</h3>
      <p className="muted">
        DHCPv6 fornece endereço, DNS e delegação de prefixo; o gateway e os prefixos on-link vêm dos RAs.
        Habilite IPv6 na interface selecionada. Para delegação, use requestPrefix e delegatePort com o ID da
        interface LAN.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          lab.change((e) => {
            const input: unknown = JSON.parse(value);
            if (operation === 'server') e.configureDhcp6Server(device.id, input);
            else if (operation === 'udp') e.configureUdp6Service(device.id, input);
            else if (operation === 'relay') {
              if (!port) throw new Error('Selecione uma interface.');
              e.configureDhcp6Relay(device.id, port.id, input);
            } else {
              if (!port) throw new Error('Selecione uma interface.');
              e.configureDhcp6Client(device.id, port.id, input);
            }
          });
        }}
      >
        <label>
          Configuração DHCPv6/UDP
          <select
            value={operation}
            onChange={(event) => {
              const next = event.target.value;
              setOperation(next);
              setValue(JSON.stringify(sample(next), null, 2));
            }}
          >
            <option value="client">Cliente DHCPv6 da interface</option>
            {['server', 'router', 'switch'].includes(device.type) && (
              <option value="server">Servidor e pools DHCPv6</option>
            )}
            <option value="udp">Serviço echo UDP IPv6</option>
            {['router', 'switch'].includes(device.type) && (
              <option value="relay">Relay DHCPv6 da interface</option>
            )}
          </select>
        </label>
        <ConfigEditor
          choices={configChoices(lab.engine, device)}
          label="Configuração IPv6 de serviços"
          schema={configurationSchemas.dhcp6[operation as keyof typeof configurationSchemas.dhcp6]}
          value={value}
          rows={10}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          maxLength={20000}
        />
        <button className="button small">Aplicar serviços IPv6</button>
      </form>
      {port?.dhcp6Relay && (
        <p>
          Relay DHCPv6: {port.dhcp6Relay.forwarded} encaminhamentos · {port.dhcp6Relay.replied} respostas ·{' '}
          {port.dhcp6Relay.pending.length} correlações.
        </p>
      )}
      {port?.dhcp6 && (
        <div aria-live="polite" data-dhcp6-state={port.dhcp6.state}>
          <p>
            DHCPv6: <strong>{port.dhcp6.state}</strong> · {port.dhcp6.address ?? 'Sem endereço'}
            {port.dhcp6.delegatedPrefix
              ? ' · PD ' + port.dhcp6.delegatedPrefix + '/' + port.dhcp6.prefixLength
              : ''}
          </p>
          <p>DNS: {port.dhcp6.dns.join(', ') || 'não informado'}</p>
          <button
            className="button small"
            onClick={() => lab.change((e) => e.releaseDhcp6(device.id, port.id))}
          >
            Liberar concessão DHCPv6
          </button>
        </div>
      )}
      {device.dhcp6Server && (
        <p>
          Servidor DHCPv6: {device.dhcp6Server.leases.length} concessões ·{' '}
          {device.dhcp6Server.declined.length} endereços em quarentena
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          lab.change(
            (e) =>
              e.sendUdp6(
                device.id,
                String(fields.get('target')),
                Number(fields.get('port')),
                String(fields.get('data')),
                port?.vrf,
                port?.id
              ),
            false
          );
        }}
      >
        <label>
          Destino UDP IPv6
          <input name="target" placeholder="2001:db8:2::10" required />
        </label>
        <label>
          Porta UDP IPv6
          <input name="port" type="number" min={1} max={65535} defaultValue={7} required />
        </label>
        <label>
          Dados UDP IPv6
          <input name="data" defaultValue="Datagrama IPv6" maxLength={8192} required />
        </label>
        <button className="button small">Enviar UDP IPv6</button>
      </form>
      <div aria-live="polite">
        {device.udp6Records
          ?.slice(-6)
          .reverse()
          .map((r, i) => (
            <p key={r.id + '-' + i}>
              {r.reply ? 'Resposta' : 'Recebido'} de {r.source}:{r.sourcePort}: <code>{r.data}</code>
            </p>
          ))}
      </div>
    </section>
  );
}
