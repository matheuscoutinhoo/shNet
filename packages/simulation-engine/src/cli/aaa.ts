import { accountTacacs } from '../protocols/tacacs';
import type { Device } from '../model';
import { aaaServerConfig } from '../protocols/aaa';
import { dot1xConfig, supplicantConfig } from '../protocols/dot1x';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
export function redactNetworkSecrets(text: string) {
  return text
    .replace(/("(?:key|password)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/^(aaa login \S+) \S+$/i, '$1 [redacted]');
}
export function registerAaaCommands(r: CommandRegistry) {
  r.register({
    pattern: /^firewall application configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureInspection(d.id, JSON.parse(m[1])),
  });
  r.register({
    pattern: /^aaa server configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureAaaServer(d.id, JSON.parse(m[1])),
  });
  r.register({
    pattern: /^aaa client configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureAaaClient(d.id, JSON.parse(m[1])),
  });
  r.register({
    pattern: /^dot1x configure (\{.+\})$/i,
    modes: ['interface'],
    run: (m, e, d, c) => e.configureDot1x(d.id, currentPort(d, c).id, JSON.parse(m[1])),
  });
  r.register({
    pattern: /^supplicant configure (\{.+\})$/i,
    modes: ['interface'],
    run: (m, e, d, c) => e.configureSupplicant(d.id, currentPort(d, c).id, JSON.parse(m[1])),
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
    ...(d.aaaServer ? ['aaa server configure ' + JSON.stringify(aaaServerConfig(d))] : []),
    ...(d.aaaClient ? ['aaa client configure ' + JSON.stringify(d.aaaClient)] : []),
    ...d.interfaces.flatMap((p) => [
      ...(p.dot1x
        ? ['interface ' + p.name, ' dot1x configure ' + JSON.stringify(dot1xConfig(p)), 'exit']
        : []),
      ...(p.supplicant
        ? ['interface ' + p.name, ' supplicant configure ' + JSON.stringify(supplicantConfig(p)), 'exit']
        : []),
    ]),
  ].map(redactNetworkSecrets);
}
