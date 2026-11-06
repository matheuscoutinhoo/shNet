import { accountTacacs } from '../protocols/tacacs';
import type { Device, NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import { aaaServerConfig } from '../protocols/aaa';
import { dot1xConfig, supplicantConfig } from '../protocols/dot1x';
import { resolveRoute } from '../protocols/ipv4';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
import { parseConfigJson, printSecretsJson } from './secrets';
const iosDot1xMethods = (d: Device) => d.iosSystem?.aaa?.authentication.some((x) => x.kind === 'dot1x');
/** IOS re-authenticates only with "authentication periodic" (3600 s unless a timer is set). */
function reauthMs(p: NetworkInterface) {
  const seconds = p.authenticationPeriodic && typeof p.reauthenticate === 'number' ? p.reauthenticate : 3600;
  return Math.min(3600000, Math.max(5000, seconds * 1000));
}
/** IOS runs 802.1X on a port with "authentication port-control auto" and "dot1x pae authenticator". */
function syncIosDot1x(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const wanted = p.authenticationControl === 'auto' && p.dot1xPae === 'authenticator';
  if (wanted && !p.dot1x) e.configureDot1x(d.id, p.id, { enabled: true, aaa: true, reauthMs: reauthMs(p) });
  else if (!wanted && p.dot1x?.aaa) e.removeDot1x(d.id, p.id);
}
export function redactNetworkSecrets(text: string) {
  return text
    .replace(/^(console \S+) .+$/i, '$1 [redacted]')
    .replace(/^((?:do )?enable(?: algorithm-type (?:sha256|scrypt))? secret)(?: .*)?$/i, '$1 [redacted]')
    .replace(/("(?:key|password)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/((?:wifi connect|wireless (?:ap|client)) .+? key)(?: [07])? \S+/i, '$1 [redacted]')
    .replace(/^(aaa login \S+) \S+$/i, '$1 [redacted]')
    .replace(/^((?:do )?neighbor \S+ password)(?: [07])? .+$/i, '$1 [redacted]')
    .replace(/^((?:do )?ip ospf message-digest-key \d+ md5)(?: [07])? .+$/i, '$1 [redacted]')
    .replace(/^((?:do )?key-string)(?: [07])? .+$/i, '$1 [redacted]');
}
export function registerAaaCommands(r: CommandRegistry) {
  r.register({
    pattern: /^(no )?dot1x system-auth-control$/i,
    modes: CONFIG_MODES,
    run: (m, _e, d) => {
      if (d.type !== 'switch') throw new Error('802.1X system control requires a switch.');
      d.dot1xSystemAuthControl = !m[1];
    },
  });
  r.register({
    pattern: /^(no )?authentication port-control(?: (auto|force-authorized|force-unauthorized))?$/i,
    syntax: [
      'authentication port-control auto',
      'authentication port-control force-authorized',
      'authentication port-control force-unauthorized',
    ],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c);
      if (m[1]) {
        delete p.authenticationControl;
        syncIosDot1x(e, d, p);
        return;
      }
      if (!m[2]) throw new Error('Specify auto, force-authorized or force-unauthorized.');
      const control = m[2].toLowerCase() as 'auto' | 'force-authorized' | 'force-unauthorized';
      if (d.type !== 'switch' || p.mode !== 'access')
        throw new Error('Port control requires an access switchport.');
      // Simulator AAA client (JSON) without an IOS dot1x method list: bind to it right away.
      const legacy = d.aaaClient && !iosDot1xMethods(d);
      if (control === 'auto' && !p.dot1x && legacy) {
        const a = d.aaaClient!,
          route = resolveRoute(d, a.server);
        if (a.method !== 'radius' || !route)
          throw new Error('Configure a reachable RADIUS AAA client first.');
        e.configureDot1x(d.id, p.id, {
          enabled: true,
          server: a.server,
          key: a.key,
          underlay: route.port.id,
          reauthMs: 60000,
        });
      }
      p.authenticationControl = control;
      syncIosDot1x(e, d, p);
    },
  });
  r.register({
    // "dot1x port-control auto" is the pre-IBNS form of port-control auto plus the authenticator role.
    pattern:
      /^(no )?dot1x (pae authenticator|port-control(?: (auto|force-authorized|force-unauthorized))?)$/i,
    syntax: ['dot1x pae authenticator', 'dot1x port-control auto'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c);
      if (d.type !== 'switch' || p.mode !== 'access')
        throw new Error('802.1X requires an access switchport.');
      const pae = m[2].toLowerCase() === 'pae authenticator';
      if (m[1]) {
        if (pae) delete p.dot1xPae;
        else delete p.authenticationControl;
      } else {
        if (!pae && !m[3]) throw new Error('Specify auto, force-authorized or force-unauthorized.');
        if (pae || m[3].toLowerCase() === 'auto') p.dot1xPae = 'authenticator';
        if (!pae) p.authenticationControl = m[3].toLowerCase() as 'auto';
      }
      syncIosDot1x(e, d, p);
    },
  });
  r.register({
    pattern: /^(no )?authentication (periodic|timer reauthenticate(?: (\d+|server))?)$/i,
    syntax: ['authentication periodic', 'authentication timer reauthenticate <seconds>'],
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c);
      if (m[2].toLowerCase() === 'periodic') {
        if (m[1]) delete p.authenticationPeriodic;
        else p.authenticationPeriodic = true;
      } else if (m[1]) delete p.reauthenticate;
      else if (!m[3]) throw new Error('Specify the interval in seconds or "server".');
      else p.reauthenticate = m[3].toLowerCase() === 'server' ? 'server' : Number(m[3]);
      if (p.dot1x?.aaa) e.configureDot1x(d.id, p.id, { enabled: true, aaa: true, reauthMs: reauthMs(p) });
    },
  });
  r.register({
    pattern: /^firewall application configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureInspection(d.id, parseConfigJson(m[1])),
  });
  r.register({
    pattern: /^aaa server configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureAaaServer(d.id, parseConfigJson(m[1])),
  });
  r.register({
    pattern: /^aaa client configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureAaaClient(d.id, parseConfigJson(m[1])),
  });
  r.register({
    pattern: /^dot1x configure (\{.+\})$/i,
    modes: ['interface'],
    run: (m, e, d, c) => e.configureDot1x(d.id, currentPort(d, c).id, parseConfigJson(m[1])),
  });
  r.register({
    pattern: /^supplicant configure (\{.+\})$/i,
    modes: ['interface'],
    run: (m, e, d, c) => e.configureSupplicant(d.id, currentPort(d, c).id, parseConfigJson(m[1])),
  });
  r.register({
    pattern: /^no (dot1x|supplicant)$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c);
      if (m[1].toLowerCase() === 'dot1x') e.configureDot1x(d.id, p.id, { ...dot1xConfig(p), enabled: false });
      else e.configureSupplicant(d.id, p.id, { ...supplicantConfig(p), enabled: false });
    },
  });
  r.register({
    pattern: /^aaa login (\S+) (\S+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => 'AAA [' + e.loginNetwork(d.id, m[1], m[2]) + '] pending; use show aaa.',
  });
  r.register({
    pattern: /^aaa logout$/i,
    modes: ALL_MODES,
    run: (_m, e, d) => {
      accountTacacs(e, d);
      delete d.networkAuth;
    },
  });
  r.register({
    pattern: /^show (aaa|dot1x)$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      redactNetworkSecrets(
        JSON.stringify(
          {
            server: d.aaaServer,
            client: d.aaaClient,
            login: d.networkAuth,
            queries: d.aaaQueries,
            ports: d.interfaces
              .filter((p) => p.dot1x || p.supplicant)
              .map((p) => ({ name: p.name, vlan: p.accessVlan, dot1x: p.dot1x, supplicant: p.supplicant })),
          },
          null,
          2
        )
      ),
  });
}
export function aaaRunningConfig(d: Device) {
  return [
    ...(d.dot1xSystemAuthControl !== undefined
      ? [(d.dot1xSystemAuthControl ? '' : 'no ') + 'dot1x system-auth-control']
      : []),
    ...(d.aaaServer ? ['aaa server configure ' + printSecretsJson(d, aaaServerConfig(d))] : []),
    ...(d.aaaClient ? ['aaa client configure ' + printSecretsJson(d, d.aaaClient)] : []),
    // The 802.1X definition precedes port-control so replay does not derive a new one.
    ...d.interfaces
      .filter((p) => p.dot1x || p.supplicant || p.authenticationControl || p.dot1xPae)
      .flatMap((p) => [
        'interface ' + p.name,
        ...(p.dot1x && !p.dot1x.aaa ? [' dot1x configure ' + printSecretsJson(d, dot1xConfig(p))] : []),
        ...(p.supplicant ? [' supplicant configure ' + printSecretsJson(d, supplicantConfig(p))] : []),
        ...(p.authenticationPeriodic ? [' authentication periodic'] : []),
        ...(p.reauthenticate !== undefined
          ? [' authentication timer reauthenticate ' + p.reauthenticate]
          : []),
        ...(p.authenticationControl ? [' authentication port-control ' + p.authenticationControl] : []),
        ...(p.dot1xPae ? [' dot1x pae ' + p.dot1xPae] : []),
        'exit',
      ]),
  ];
}
