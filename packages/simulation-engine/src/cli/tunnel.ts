import type { Device } from '../model';
import { sdwanConfig } from '../protocols/sdwan';
import { tunnelConfig, tunnelMetrics } from '../protocols/tunnel';
import { sdwanPolicySchema } from '../protocols/tunnel-model';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';
import { parseConfigJson, printSecret, printSecretsJson, readSecret } from './secrets';
export function registerTunnelCommands(r: CommandRegistry) {
  r.register({
    pattern: /^no tunnel (\d+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.tunnel?.number === Number(m[1]));
      if (!p) throw new Error('Túnel inexistente.');
      e.removeLogicalInterface(d.id, p.id);
    },
  });
  r.register({
    pattern: /^tunnel configure (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      e.configureTunnel(d.id, parseConfigJson(m[1]));
    },
  });
  r.register({
    pattern: /^(no )?service tunnel (\d+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.tunnel?.number === Number(m[2]));
      if (!p) throw new Error('Túnel inexistente.');
      e.configureTunnel(d.id, { ...tunnelConfig(p), enabled: !m[1] });
    },
  });
  r.register({
    pattern: /^sdwan site (\S+)(?: controller (\S+) underlay (\S+) key (?:([07]) )?(\S+))?$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) =>
      e.configureSdwan(d.id, {
        ...sdwanConfig(d),
        enabled: true,
        site: m[1],
        controller: m[2],
        underlay: m[3],
        key: m[5] === undefined ? undefined : readSecret(m[4], m[5]),
      }),
  });
  r.register({
    pattern: /^sdwan policy (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const p = sdwanPolicySchema.parse(parseConfigJson(m[1])),
        c = sdwanConfig(d);
      e.configureSdwan(d.id, { ...c, policies: [...c.policies.filter((old) => old.name !== p.name), p] });
    },
  });
  r.register({
    pattern: /^no sdwan policy (\S+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const c = sdwanConfig(d);
      e.configureSdwan(d.id, { ...c, policies: c.policies.filter((p) => p.name !== m[1]) });
    },
  });
  r.register({
    pattern: /^(no )?service sdwan$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureSdwan(d.id, { ...sdwanConfig(d), enabled: !m[1] }),
  });
  r.register({
    pattern: /^sdwan controller (\{.+\})$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => e.configureSdwanController(d.id, parseConfigJson(m[1])),
  });
  r.register({
    pattern: /^show (tunnels|sdwan)$/i,
    modes: ALL_MODES,
    run: (m, _e, d) =>
      m[1].toLowerCase() === 'tunnels'
        ? d.interfaces
            .filter((p) => p.tunnel)
            .map((p) => {
              const t = p.tunnel!,
                v = tunnelMetrics(p);
              return `${p.name} ${t.mode} ${t.transport} ${t.status} peer=${t.remote} RTT=${Number.isFinite(v.rtt) ? v.rtt.toFixed(3) : '-'}ms loss=${v.loss.toFixed(1)}% tx/rx=${t.sent}/${t.received}\n${t.remotePrefixes.map((r) => r.network + '/' + r.prefix).join(' ')}`;
            })
            .join('\n')
        : JSON.stringify(
            {
              site: d.sdwan?.site,
              lastController: d.sdwan?.lastController,
              policies: d.sdwan?.receivedPolicies.length ? d.sdwan.receivedPolicies : d.sdwan?.policies,
              selected: d.sdwan?.selected,
              controllerSites: d.sdwanController?.sites,
            },
            null,
            2
          ),
  });
}
export function tunnelRunningConfig(d: Device) {
  return [
    ...d.interfaces
      .filter((p) => p.tunnel)
      .map((p) => 'tunnel configure ' + printSecretsJson(d, tunnelConfig(p))),
    ...(d.sdwan
      ? [
          'sdwan site ' +
            d.sdwan.site +
            (d.sdwan.controller && d.sdwan.underlay && d.sdwan.key
              ? ` controller ${d.sdwan.controller} underlay ${d.sdwan.underlay} key ${printSecret(d, d.sdwan.key)}`
              : ''),
          ...d.sdwan.policies.map((p) => 'sdwan policy ' + JSON.stringify(p)),
          ...(!d.sdwan.enabled ? ['no service sdwan'] : []),
        ]
      : []),
    ...(d.sdwanController ? ['sdwan controller ' + printSecretsJson(d, d.sdwanController)] : []),
  ];
}
