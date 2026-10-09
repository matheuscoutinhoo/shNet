import type { Device } from '../model';
import { remoteConfig } from '../protocols/remote';
import { telemetryConfig } from '../protocols/telemetry';
import { ntpConfig } from '../protocols/ntp';
import { redactNetworkSecrets } from './aaa';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';
export function registerRemoteCommands(r: CommandRegistry) {
  r.register({
    pattern: /^management configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureRemote(d.id, JSON.parse(m[1])),
  });
  r.register({
    pattern: /^management request (\{.+\})$/i,
    modes: ALL_MODES,
    run: (m, e, d) => 'RPC [' + e.requestRemote(d.id, JSON.parse(m[1])) + '] pending.',
  });
  r.register({
    pattern: /^automation run (\{.+\})$/i,
    modes: ALL_MODES,
    run: (m, e, d) => 'JOB [' + e.runAutomation(d.id, JSON.parse(m[1])) + '] running.',
  });
  r.register({
    pattern: /^automation clear$/i,
    modes: CONFIG_MODES,
    run: (_m, _e, d) => {
      d.automationJobs = d.automationJobs?.filter((j) => j.status === 'running');
    },
  });
  for (const item of ['telemetry', 'collector', 'ntp', 'clock'])
    r.register({
      pattern: new RegExp('^' + item + ' configure (\\{.+\\})$', 'i'),
      modes: CONFIG_MODES,
      run: (m, e, d) => {
        const input = JSON.parse(m[1]);
        if (item === 'telemetry') e.configureTelemetry(d.id, input);
        else if (item === 'collector') e.configureCollector(d.id, input);
        else if (item === 'ntp') e.configureNtp(d.id, input);
        else e.configureClock(d.id, input);
      },
    });
  r.register({
    pattern: /^show (management|automation|telemetry|ntp)$/i,
    modes: ALL_MODES,
    run: (m, _e, d) =>
      redactNetworkSecrets(
        JSON.stringify(
          m[1].toLowerCase() === 'management'
            ? { server: d.remoteManagement, queries: d.remoteQueries }
            : m[1].toLowerCase() === 'automation'
              ? d.automationJobs
              : m[1].toLowerCase() === 'ntp'
                ? { clock: d.networkClock, ntp: d.ntp }
                : { publisher: d.telemetry, collector: d.telemetryCollector },
          null,
          2
        )
      ),
  });
}
export function remoteRunningConfig(d: Device) {
  return [
    ...(d.remoteManagement ? ['management configure ' + JSON.stringify(remoteConfig(d))] : []),
    ...(d.telemetry ? ['telemetry configure ' + JSON.stringify(telemetryConfig(d))] : []),
    ...(d.telemetryCollector
      ? [
          'collector configure ' +
            JSON.stringify({ enabled: d.telemetryCollector.enabled, key: d.telemetryCollector.key }),
        ]
      : []),
    ...(d.networkClock ? ['clock configure ' + JSON.stringify(d.networkClock)] : []),
    ...(d.ntp ? ['ntp configure ' + JSON.stringify(ntpConfig(d))] : []),
  ].map(redactNetworkSecrets);
}
