import type { Device } from '../model';
import { wirelessConfig } from '../protocols/wireless';
import { wirelessMetrics } from '../protocols/wireless-radio';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';
export function registerWirelessCommands(r: CommandRegistry) {
  r.register({
    pattern:
      /^wireless (ap|client) ssid (\S+) security (open|wpa2-psk|wpa3-sae|wpa2-enterprise)(?: key (\S+))? channel (\d+)(?: band (2\.4|5))?$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) =>
      e.configureWireless(d.id, {
        ...wirelessConfig(d),
        role: m[1].toLowerCase(),
        ssid: m[2],
        security: m[3].toLowerCase(),
        key: m[4],
        channel: Number(m[5]),
        band: m[6] ?? '2.4',
        enabled: true,
      }),
  });
  r.register({
    pattern: /^(no )?service wireless$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureWireless(d.id, { ...wirelessConfig(d), enabled: !m[1] }),
  });
  r.register({
    pattern: /^wireless (tx-power|noise|attenuation) (-?\d+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) =>
      e.configureWireless(d.id, {
        ...wirelessConfig(d),
        [{ 'tx-power': 'txPower', noise: 'noise', attenuation: 'attenuation' }[m[1].toLowerCase()]!]: Number(
          m[2]
        ),
      }),
  });
  r.register({
    pattern: /^show wireless(?: (scan|clients|radio))?$/i,
    modes: ALL_MODES,
    run: (_m, e, d) => {
      const w = d.wireless;
      if (!w) return 'Wireless não configurado';
      return (
        `${w.role} SSID=${w.ssid} ${w.security} banda=${w.band} canal=${w.channel} ${w.phase}\n` +
        w.seen.map((p) => `${p.ssid} ${p.bssid} ${p.security} ${p.signal.toFixed(1)} dBm`).join('\n') +
        '\n' +
        w.peers.map((p) => `${p.mac} ${p.phase}`).join('\n') +
        '\n' +
        e.state.links
          .filter((l) => l.cable === 'wireless' && [l.a, l.b].some((p) => p.device === d.id))
          .map((l) => {
            const m = wirelessMetrics(e.state, l);
            return `RSSI=${m.rssi.toFixed(1)} SNR=${m.snr.toFixed(1)} interference=${m.interference.toFixed(1)} loss=${(m.loss * 100).toFixed(1)}%`;
          })
          .join('\n')
      );
    },
  });
}
export function wirelessRunningConfig(d: Device) {
  const w = d.wireless;
  if (!w) return [];
  return [
    `wireless ${w.role} ssid ${w.ssid} security ${w.security}${w.key ? ' key [configured]' : ''} channel ${w.channel} band ${w.band}`,
    `wireless tx-power ${w.txPower}`,
    `wireless noise ${w.noise}`,
    `wireless attenuation ${w.attenuation}`,
    ...(!w.enabled ? ['no service wireless'] : []),
  ];
}
