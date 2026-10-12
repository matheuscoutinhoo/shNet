import { ALL_MODES, type CommandRegistry } from './registry';
import { ipv4Schema } from '../model';
import { wirelessConfig } from '../protocols/wireless';
import { interfaceOperational } from '../protocols/layer3';

export function registerHostCommands(r: CommandRegistry) {
  r.register({
    pattern: /^(ipconfig(?: \/all)?|ip (?:addr|address|link) show)$/i,
    modes: ALL_MODES,
    run: (_m, e, d) =>
      d.interfaces
        .map((p) =>
          [
            p.name + ' · ' + (interfaceOperational(e.state, d, p) ? 'enlace ativo' : 'sem enlace ativo'),
            '  MAC: ' + p.mac,
            '  IPv4: ' + (p.ip ? p.ip + '/' + p.prefix : 'não configurado'),
            '  IPv6: ' +
              (p.ipv6?.addresses.map((a) => a.ip + '/' + a.prefix).join(', ') || 'não configurado'),
            '  Gateway: ' + (p.gateway ?? d.gateway ?? 'não configurado'),
            '  DNS: ' + (p.dns?.join(', ') || 'não configurado'),
          ].join('\n')
        )
        .join('\n\n'),
  });
  r.register({
    pattern: /^(?:ip (?:addr|address) add) ([\d.]+\/\d+) dev (\S+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => {
      const port = d.interfaces.find((p) => p.name.toLowerCase() === m[2].toLowerCase());
      if (!port) throw new Error('Interface inexistente. Consulte ipconfig /all.');
      return r.execute('ip address ' + m[1], e, d, { mode: 'interface', port: port.id });
    },
  });
  r.register({
    pattern: /^ip (?:addr|address) del ([\d.]+\/\d+) dev (\S+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.name.toLowerCase() === m[2].toLowerCase());
      if (!p || p.ip + '/' + p.prefix !== m[1])
        throw new Error('Este endereço não está configurado nesta interface.');
      return r.execute('no ip address', e, d, { mode: 'interface', port: p.id });
    },
  });
  r.register({
    pattern: /^ip link set dev (\S+) (up|down)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.name.toLowerCase() === m[1].toLowerCase());
      if (!p) throw new Error('Interface inexistente. Consulte ip link show.');
      e.setPort(d.id, p.id, m[2].toLowerCase() === 'up');
    },
  });
  r.register({
    pattern: /^ip route add default via ([\d.]+)$/i,
    modes: ALL_MODES,
    run: (m, _e, d) => {
      d.gateway = ipv4Schema.parse(m[1]);
    },
  });
  r.register({
    pattern: /^ip route del default$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) => {
      delete d.gateway;
    },
  });
  r.register({
    pattern: /^(ip route show|route print|arp -a)$/i,
    modes: ALL_MODES,
    run: (m, e, d) =>
      r.execute(m[1].toLowerCase() === 'arp -a' ? 'show arp' : 'show ip route', e, d, { mode: 'user' }),
  });
  r.register({
    pattern: /^ipconfig \/(renew|release)(?: (\S+))?$/i,
    modes: ALL_MODES,
    run: (m, e, d) => {
      const ports = m[2]
        ? d.interfaces.filter((p) => p.name.toLowerCase() === m[2].toLowerCase())
        : d.interfaces.filter((p) => p.mode === 'routed' && !p.logical);
      if (!ports.length) throw new Error('Interface inexistente ou sem suporte a endereço IP.');
      for (const p of ports) {
        if (m[1].toLowerCase() === 'renew') e.requestDhcp(d.id, p.id);
        else e.releaseDhcp(d.id, p.id);
      }
      return m[1].toLowerCase() === 'renew'
        ? 'Solicitação DHCP iniciada. Avance a simulação e consulte ipconfig /all.'
        : 'Endereço DHCP liberado.';
    },
  });
  r.register({
    pattern: /^wifi scan$/i,
    modes: ALL_MODES,
    run: (_m, e, d) => r.execute('show wireless scan', e, d, { mode: 'user' }),
  });
  r.register({
    pattern: /^wifi connect (\S+) security (open|wpa2-psk|wpa3-sae)(?: key (\S+))?$/i,
    modes: ALL_MODES,
    run: (m, e, d) => {
      const ap = e.state.devices.find(
        (ap) => ap.power && ap.wireless?.enabled && ap.wireless.role === 'ap' && ap.wireless.ssid === m[1]
      );
      if (!ap?.wireless) throw new Error('Rede não anunciada por um AP ativo. Consulte wifi scan.');
      e.configureWireless(d.id, {
        ...wirelessConfig(d),
        enabled: true,
        role: 'client',
        ssid: m[1],
        security: m[2].toLowerCase() as 'open' | 'wpa2-psk' | 'wpa3-sae',
        key: m[3],
        channel: ap.wireless.channel,
        band: ap.wireless.band,
      });
      return 'Rádio configurado. Avance a simulação para observar associação e autenticação.';
    },
  });
}
