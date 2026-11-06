import { accountTacacs } from '../protocols/tacacs';
import type { Device } from '../model';
import { aaaServerConfig } from '../protocols/aaa';
import { dot1xConfig, supplicantConfig } from '../protocols/dot1x';
import { resolveRoute } from '../protocols/ipv4';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
import { parseConfigJson, printSecretsJson } from './secrets';
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
    pattern: /^authentication port-control (auto|force-authorized|force-unauthorized)$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c),
        control = m[1].toLowerCase() as 'auto' | 'force-authorized' | 'force-unauthorized';
      if (d.type !== 'switch' || p.mode !== 'access')
        throw new Error('Port control requires an access switchport.');
      if (control === 'auto' && !p.dot1x) {
        const a = d.aaaClient,
          route = a && resolveRoute(d, a.server);
        if (a?.method !== 'radius' || !route)
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
      .filter((p) => p.dot1x || p.supplicant || p.authenticationControl)
      .flatMap((p) => [
        'interface ' + p.name,
        ...(p.dot1x ? [' dot1x configure ' + printSecretsJson(d, dot1xConfig(p))] : []),
        ...(p.supplicant ? [' supplicant configure ' + printSecretsJson(d, supplicantConfig(p))] : []),
        ...(p.authenticationControl ? [' authentication port-control ' + p.authenticationControl] : []),
        'exit',
      ]),
  ];
}
