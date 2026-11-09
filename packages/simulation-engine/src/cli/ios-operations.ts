import type { Device } from '../model';
import type { SimulationEngine } from '../core/engine';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';
import { showRoutes, showInterfacesStatus } from './operational';
import { interfaceReference } from './ios-management';
import { configBody } from './running-config';
export function archiveRunning(e: SimulationEngine, d: Device, r: CommandRegistry) {
  const a = d.iosSystem?.archive;
  if (!a) throw new Error('Configure archive first.');
  const configuration = configBody(r.execute('show running-config', e, d, { mode: 'privileged' }));
  if (configuration.length > 65536) throw new Error('Archive configuration exceeds 64 KiB.');
  const name = (a.path + '-' + e.state.clock + '-' + e.id('archive')).slice(0, 160);
  a.copies.push({ at: e.state.clock, name, configuration });
  a.copies = a.copies.slice(-a.maximum);
  return name;
}
export function registerIosOperations(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?service password-encryption$/i,
    syntax: ['service password-encryption', 'no service password-encryption'],
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      d.iosSystem ??= {};
      if (m[1]) delete d.iosSystem.passwordEncryption;
      else d.iosSystem.passwordEncryption = true;
    },
  });
  r.register({
    pattern: /^(no )?ntp server ([\d.]+)((?: (?:prefer|iburst|burst|key \d+|version [1-4]|source \S+))*)$/i,
    syntax: [
      'ntp server <address>',
      'ntp server <address> prefer',
      'ntp server <address> key <id>',
      'ntp server <address> source <interface>',
    ],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const address = m[2],
        servers = [...(d.ntp?.servers ?? []).filter((s) => s !== address), ...(m[1] ? [] : [address])];
      if (!servers.length) {
        if (d.ntp)
          e.configureNtp(d.id, { enabled: false, servers: d.ntp.servers, intervalMs: d.ntp.intervalMs });
      } else e.configureNtp(d.id, { enabled: true, servers, intervalMs: d.ntp?.intervalMs ?? 64000 });
      // Re-entering a server replaces its options, as on IOS.
      const ntp = ((d.iosSystem ??= {}).ntp ??= {});
      ntp.serverOptions = ntp.serverOptions?.filter((o) => o.address !== address);
      if (ntp.prefer === address) delete ntp.prefer;
      if (!m[1]) {
        const words = m[3].trim().split(/\s+/).filter(Boolean),
          option: NonNullable<typeof ntp.serverOptions>[number] = { address };
        for (let i = 0; i < words.length; i++) {
          const word = words[i].toLowerCase();
          if (word === 'prefer') ntp.prefer = address;
          else if (word === 'iburst' || word === 'burst') option.iburst = true;
          else if (word === 'key') option.key = Number(words[++i]);
          else if (word === 'version') option.version = Number(words[++i]);
          else if (word === 'source') option.source = interfaceReference(d, words[++i]);
        }
        if (option.key !== undefined && (option.key < 1 || option.key > 65535))
          throw new Error('NTP key ID is 1-65535.');
        if (Object.keys(option).length > 1) (ntp.serverOptions ??= []).push(option);
      }
      if (!ntp.serverOptions?.length) delete ntp.serverOptions;
    },
  });
  r.register({
    pattern: /^(no )?ntp master(?: (\d+))?$/i,
    syntax: ['ntp master', 'ntp master <stratum>', 'no ntp master'],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      if (m[1] && !d.networkClock?.server) return;
      e.configureClock(d.id, {
        offsetMs: d.networkClock?.offsetMs ?? 0,
        server: !m[1],
        stratum: m[1] ? (d.networkClock?.stratum ?? 8) : Number(m[2] ?? 8),
      });
    },
  });
  r.register({
    pattern: /^clock timezone ([\w+-]{1,16}) (-?\d+)(?: (\d+))?$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      d.iosSystem ??= {};
      d.iosSystem.timezone = { name: m[1], hours: Number(m[2]), minutes: Number(m[3] ?? 0) };
    },
  });
  r.register({
    pattern: /^archive$/i,
    modes: ['config'],
    run: (_m, _e, d, c) => {
      d.iosSystem ??= {};
      d.iosSystem.archive ??= { path: 'flash:/archive', maximum: 14, writeMemory: false, copies: [] };
      c.mode = 'archive';
    },
  });
  r.register({
    pattern: /^path (\S+)$/i,
    modes: ['archive'],
    run: (m, _e, d) => {
      d.iosSystem!.archive!.path = m[1];
    },
  });
  r.register({
    pattern: /^maximum (\d+)$/i,
    modes: ['archive'],
    run: (m, _e, d) => {
      const a = d.iosSystem!.archive!;
      a.maximum = Number(m[1]);
      a.copies = a.copies.slice(-a.maximum);
    },
  });
  r.register({
    pattern: /^(no )?write-memory$/i,
    modes: ['archive'],
    run: (m, _e, d) => {
      d.iosSystem!.archive!.writeMemory = !m[1];
    },
  });
  r.register({
    pattern: /^archive config$/i,
    modes: ['privileged'],
    run: (_m, e, d) => 'Archived configuration: ' + archiveRunning(e, d, r),
  });
  r.register({
    pattern: /^show archive$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      d.iosSystem?.archive?.copies.map((c, i) => `${i + 1} ${c.name} at ${c.at} ms`).join('\n') ||
      'No archived configurations.',
  });
  r.register({
    pattern: /^show inventory$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      `NAME: "${d.hostname}", DESCR: "shLab virtual ${d.profile ?? d.type}"\nPID: ${d.profile ?? d.type}, VID: ${d.operatingSystem?.subset ?? 'educational'}, SN: ${d.id}\n` +
      d.interfaces
        .map((p) => `${p.name}: ${p.media}, ${p.speed} Mbps${p.transceiver ? ', ' + p.transceiver : ''}`)
        .join('\n'),
  });
  r.register({
    pattern: /^show environment$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      `Power: ${d.power ? 'ON' : 'OFF'}\nTemperature: ${d.system?.temperatureC === undefined ? 'unavailable' : Math.round(d.system.temperatureC)} C\nCPU: ${d.system?.cpuPercent === undefined ? 'unavailable' : Math.round(d.system.cpuPercent)}%\nMemory: ${d.system?.memoryKiB === undefined ? 'unavailable' : Math.round(d.system.memoryKiB)} KiB\nVirtual resource model; no physical sensor or ASIC is emulated.`,
  });
  r.register({
    pattern: /^show interfaces counters errors$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      'PORT RX TX ERRORS\n' + d.interfaces.map((p) => `${p.name} ${p.rx} ${p.tx} ${p.errors}`).join('\n'),
  });
  r.register({
    pattern: /^show ip cef(?: ([\d.]+))?$/i,
    modes: ALL_MODES,
    run: (m, e, d) =>
      'Virtual forwarding table (no hardware CEF ASIC)\n' +
      showRoutes(e, d) +
      (m[1] ? '\nDestination ' + m[1] : ''),
  });
  r.register({
    pattern: /^show interfaces (\S+) status$/i,
    modes: ALL_MODES,
    run: (m, e, d) => showInterfacesStatus(e, d, m[1]),
  });
}
export function iosSystemRunning(d: Device) {
  const t = d.iosSystem?.timezone,
    a = d.iosSystem?.archive;
  return [
    ...(d.iosSystem?.passwordEncryption ? ['service password-encryption'] : []),
    ...(t ? [`clock timezone ${t.name} ${t.hours} ${t.minutes}`] : []),
    ...(a
      ? [
          'archive',
          ' path ' + a.path,
          ' maximum ' + a.maximum,
          ...(a.writeMemory ? [' write-memory'] : []),
          'exit',
        ]
      : []),
  ];
}
