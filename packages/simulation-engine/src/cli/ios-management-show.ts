import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { ALL_MODES, type CommandRegistry } from './registry';
import { iosTimestamp } from './ios-time';
import { levelName } from './ios-management';
import { interfaceOperational } from '../protocols/layer3';
import { loggingBuffer } from '../protocols/syslog-buffer';

const ERRDISABLE_REASONS = [
  'arp-inspection',
  'bpduguard',
  'channel-misconfig',
  'dhcp-rate-limit',
  'link-flap',
  'loopback',
  'psecure-violation',
  'security-violation',
  'storm-control',
  'udld',
];
/** The device's syslog messages, oldest first, as IOS keeps them in the logging buffer. */
function bufferedMessages(d: Device) {
  return (d.syslogBuffer ?? []).flatMap((line) => {
    const match = /^(\d+(?:\.\d+)?) (.*)$/.exec(line);
    return match ? [iosTimestamp(Number(match[1])) + ': ' + match[2]] : [];
  });
}
function showLogging(d: Device) {
  const s = d.iosSystem?.logging,
    syslog = d.syslogClient,
    buffered = loggingBuffer(d),
    level = (value: number | false | undefined, fallback: number) =>
      value === false ? 'disabled' : 'level ' + levelName(value ?? fallback);
  const messages = bufferedMessages(d);
  const hosts = syslog?.enabled ? [syslog.server, ...(syslog.additional ?? [])] : [];
  return [
    'Syslog logging: enabled (0 messages dropped, 0 messages rate-limited, 0 flushes, 0 overruns, xml disabled, filtering disabled)',
    '',
    '    Console logging: ' +
      level(s?.console, 7) +
      ', ' +
      messages.length +
      ' messages logged, xml disabled,',
    '                     filtering disabled',
    '    Monitor logging: ' + level(s?.monitor, 7) + ', 0 messages logged, xml disabled,',
    '                     filtering disabled',
    '    Buffer logging:  ' +
      (buffered
        ? 'level ' + levelName(buffered.level) + ', ' + messages.length + ' messages logged'
        : 'disabled') +
      ', xml disabled,',
    '                    filtering disabled',
    '    Exception Logging: size (4096 bytes)',
    '    Count and timestamp logging messages: disabled',
    '    Persistent logging: disabled',
    '',
    'No active filter modules.',
    '',
    '    Trap logging: level ' +
      levelName(syslog?.severity ?? s?.trap ?? 6) +
      ', ' +
      messages.length +
      ' message lines logged',
    ...hosts.flatMap((host) => [
      '        Logging to ' + host + '  (udp port 514, audit disabled,',
      '              link up),',
      '              xml disabled, sequence number disabled',
      '              filtering disabled',
    ]),
    ...(s?.sourceInterface
      ? ['        Logging Source-Interface:       VRF Name:', '        ' + s.sourceInterface]
      : []),
    ...(buffered ? ['', 'Log Buffer (' + buffered.size + ' bytes):', '', ...messages] : []),
  ].join('\n');
}
function showSsh(d: Device) {
  const s = d.iosSystem,
    keys = !!s?.rsaModulus;
  if (!keys)
    return 'SSH Disabled - version 1.99\n%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).';
  const v2 = s?.ssh?.version === 2 || (s?.ssh?.version === undefined && s.rsaModulus! >= 768);
  return [
    'SSH Enabled - version ' + (s?.ssh?.version === 2 ? '2.0' : s?.ssh?.version === 1 ? '1.5' : '1.99'),
    'Authentication methods:publickey,keyboard-interactive,password',
    ...(v2
      ? [
          'Encryption Algorithms:aes128-ctr,aes192-ctr,aes256-ctr',
          'MAC Algorithms:hmac-sha2-256,hmac-sha2-512,hmac-sha1',
          'KEX Algorithms:diffie-hellman-group14-sha1',
        ]
      : []),
    `Authentication timeout: ${s?.ssh?.timeout ?? 120} secs; Authentication retries: ${s?.ssh?.retries ?? 3}`,
    'Minimum expected Diffie Hellman key size : 2048 bits',
    'IOS Keys in SECSH format(ssh-rsa, base64 encoded): ' +
      d.hostname +
      (s?.domainName ? '.' + s.domainName : '') +
      ' (' +
      s!.rsaModulus +
      ' bits)',
  ].join('\n');
}
function showErrdisableRecovery(e: SimulationEngine, d: Device) {
  const r = d.iosSystem?.errdisableRecovery,
    interval = r?.intervalS ?? 300;
  const pending = d.interfaces.filter((p) => p.errDisabled && r?.causes.includes(p.errDisabled.reason));
  return [
    'ErrDisable Reason            Timer Status',
    '-----------------            --------------',
    ...ERRDISABLE_REASONS.map(
      (reason) => reason.padEnd(29) + (r?.causes.includes(reason) ? 'Enabled' : 'Disabled')
    ),
    '',
    'Timer interval: ' + interval + ' seconds',
    '',
    'Interfaces that will be enabled at the next timeout:',
    '',
    ...(pending.length
      ? [
          'Interface       Errdisable reason       Time left(sec)',
          '---------       -----------------       --------------',
          ...pending.map(
            (p) =>
              p.name.padEnd(16) +
              p.errDisabled!.reason.padStart(17) +
              String(
                Math.max(0, Math.ceil((p.errDisabled!.at + interval * 1000 - e.state.clock) / 1000))
              ).padStart(21)
          ),
        ]
      : []),
  ].join('\n');
}
function showStormControl(e: SimulationEngine, d: Device, kind: 'broadcast' | 'multicast' | 'unicast') {
  const ports = d.interfaces.filter((p) => p.stormControl?.[kind] !== undefined);
  const interval = Math.floor(e.state.clock / 1000) * 1000;
  return [
    'Interface  Filter State   Upper        Lower        Current',
    '---------  -------------  -----------  -----------  ----------',
    ...ports.map((p) => {
      const s = p.stormControl!,
        level = s[kind]!,
        window = s.window?.at === interval ? s.window : undefined,
        current = window ? (window[kind] * 100) / Math.max(1, p.speed * 125000) : 0,
        state = !interfaceOperational(e.state, d, p)
          ? 'Link Down'
          : window?.filtered?.includes(kind)
            ? 'Blocking'
            : 'Forwarding';
      return (
        p.name.padEnd(11) +
        state.padEnd(15) +
        (level.toFixed(2) + '%').padStart(11) +
        (level.toFixed(2) + '%').padStart(13) +
        (current.toFixed(2) + '%').padStart(13)
      );
    }),
  ].join('\n');
}
function showMonitor(d: Device, id?: number) {
  const sessions = (d.iosSystem?.monitorSessions ?? []).filter((s) => id === undefined || s.id === id);
  if (!sessions.length)
    return id === undefined ? 'No SPAN configuration exists.' : '% Session ' + id + ' does not exist';
  return sessions
    .map((s) => {
      const of = (direction: 'rx' | 'tx' | 'both') =>
        s.sources.filter((x) => x.direction === direction).map((x) => x.port);
      const sources = (['both', 'rx', 'tx'] as const).flatMap((direction) =>
        of(direction).length
          ? [
              '    ' +
                { both: 'Both', rx: 'RX Only', tx: 'TX Only' }[direction].padEnd(21) +
                ': ' +
                of(direction).join(','),
            ]
          : []
      );
      return [
        'Session ' + s.id,
        '---------',
        'Type                     : Local Session',
        ...(sources.length ? ['Source Ports             :', ...sources] : []),
        ...(s.vlans?.length
          ? ['Source VLANs             :', '    Both                 : ' + s.vlans.join(',')]
          : []),
        'Destination Ports        : ' + (s.destination ?? ''),
        ...(s.destination
          ? ['    Encapsulation        : Native', '          Ingress        : Disabled']
          : []),
      ].join('\n');
    })
    .join('\n\n');
}
function showVtp(d: Device) {
  const v = d.iosSystem?.vtp,
    mode = v?.mode ?? 'server';
  return [
    'VTP Version capable             : 1 to 3',
    'VTP version running             : ' + (v?.version ?? 1),
    'VTP Domain Name                 : ' + (v?.domain ?? ''),
    'VTP Pruning Mode                : Disabled',
    'VTP Traps Generation            : Disabled',
    'Device ID                       : ' + (d.interfaces[0]?.mac ?? ''),
    'Configuration last modified by 0.0.0.0 at 0-0-00 00:00:00',
    '',
    'Feature VLAN:',
    '--------------',
    'VTP Operating Mode                : ' + mode[0].toUpperCase() + mode.slice(1),
    'Maximum VLANs supported locally   : 1005',
    'Number of existing VLANs          : ' + (d.vlans.length + 4),
    'Configuration Revision            : 0',
  ].join('\n');
}
function showSnmp(d: Device, what: string) {
  const s = d.iosSystem?.snmp;
  if (what === 'location') return s?.location ?? '';
  if (what === 'contact') return s?.contact ?? '';
  if (what === 'host')
    return (s?.hosts ?? [])
      .map(
        (h) =>
          `Notification host: ${h.address}\tudp-port: 162\ttype: ${h.informs ? 'inform' : 'trap'}\n` +
          `user: ${h.community}\tsecurity model: ${h.version === '3' ? 'v3 ' + (h.security ?? 'noauth') : 'v' + h.version}`
      )
      .join('\n\n');
  if (what === 'user')
    return (s?.users ?? [])
      .map((u) =>
        [
          'User name: ' + u.name,
          'Engine ID: 800000090300' + (d.interfaces[0]?.mac ?? '').replace(/:/g, '').toUpperCase(),
          'storage-type: nonvolatile\t active',
          'Authentication Protocol: ' + (u.auth ? u.auth.algorithm.toUpperCase() : 'None'),
          'Privacy Protocol: ' + (u.priv ? u.priv.algorithm.replace(' ', '').toUpperCase() : 'None'),
          'Group-name: ' + u.group,
        ].join('\n')
      )
      .join('\n\n');
  return (s?.groups ?? [])
    .map((g) =>
      [
        `groupname: ${g.name.padEnd(32)}security model:v3 ${g.security}`,
        'contextname: <no context specified>        storage-type: nonvolatile',
        `readview : ${(g.read ?? 'v1default').padEnd(32)}writeview: ${g.write ?? '<no writeview specified>'}`,
        'notifyview: <no notifyview specified>',
        'row status: active' + (g.access ? '\taccess-list: ' + g.access : ''),
      ].join('\n')
    )
    .join('\n\n');
}
export function registerIosManagementShow(r: CommandRegistry) {
  r.register({
    pattern: /^show logging$/i,
    syntax: 'show logging',
    modes: ALL_MODES,
    run: (_m, _e, d) => showLogging(d),
  });
  r.register({
    pattern: /^show ip ssh$/i,
    syntax: 'show ip ssh',
    modes: ALL_MODES,
    run: (_m, _e, d) => showSsh(d),
  });
  r.register({
    pattern: /^show errdisable recovery$/i,
    syntax: 'show errdisable recovery',
    modes: ALL_MODES,
    run: (_m, e, d) => showErrdisableRecovery(e, d),
  });
  r.register({
    pattern: /^show storm-control(?: (broadcast|multicast|unicast))?$/i,
    syntax: ['show storm-control', 'show storm-control multicast', 'show storm-control unicast'],
    modes: ALL_MODES,
    run: (m, e, d) => showStormControl(e, d, (m[1]?.toLowerCase() ?? 'broadcast') as 'broadcast'),
  });
  r.register({
    pattern: /^show monitor(?: session (\d+|all))?$/i,
    syntax: ['show monitor', 'show monitor session <id>'],
    modes: ALL_MODES,
    run: (m, _e, d) => showMonitor(d, m[1] && m[1] !== 'all' ? Number(m[1]) : undefined),
  });
  r.register({
    pattern: /^show vtp status$/i,
    syntax: 'show vtp status',
    modes: ALL_MODES,
    run: (_m, _e, d) => showVtp(d),
  });
  r.register({
    pattern: /^show snmp (location|contact|host|user|group)$/i,
    syntax: [
      'show snmp location',
      'show snmp contact',
      'show snmp host',
      'show snmp user',
      'show snmp group',
    ],
    modes: ALL_MODES,
    run: (m, _e, d) => showSnmp(d, m[1].toLowerCase()),
  });
}
