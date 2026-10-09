import type { Device } from '../model';
import { vrrpConfigGroups } from '../protocols/vrrp';
import { vrrpMac } from '../protocols/vrrp-model';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';

export function registerVrrpCommands(registry: CommandRegistry) {
  registry.register({
    pattern: /^(no )?vrrp (\d+) track (interface|route) (\S+)(?: decrement (\d+))?$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const groups = vrrpConfigGroups(d),
        group = groups.find((g) => g.port === currentPort(d, c).id && g.vrid === Number(m[2]));
      if (!group) throw new Error('Configure o grupo VRRP antes do tracking.');
      const port =
        m[3].toLowerCase() === 'interface'
          ? d.interfaces.find((p) => p.name.toLowerCase() === m[4].toLowerCase())?.id
          : undefined;
      if (m[3].toLowerCase() === 'interface' && !port) throw new Error('Interface de tracking inexistente.');
      const route = m[3].toLowerCase() === 'route' ? m[4] : undefined;
      group.track = (group.track ?? []).filter((t) => t.port !== port || t.route !== route);
      if (!m[1]) group.track.push({ ...(port ? { port } : { route }), decrement: Number(m[5] ?? 30) });
      e.configureVrrp(d.id, { enabled: d.vrrp?.enabled ?? true, groups });
    },
  });
  registry.register({
    pattern: /^(no )?service vrrp$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) =>
      engine.configureVrrp(device.id, {
        enabled: !match[1],
        groups: vrrpConfigGroups(device),
      }),
  });
  registry.register({
    pattern: /^vrrp (\d+) ip ([\d.]+)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      const port = currentPort(device, context),
        vrid = Number(match[1]),
        groups = vrrpConfigGroups(device);
      const previous = groups.find((group) => group.port === port.id && group.vrid === vrid);
      const vip = match[2];
      engine.configureVrrp(device.id, {
        enabled: device.vrrp?.enabled ?? true,
        groups: [
          ...groups.filter((group) => group !== previous),
          {
            port: port.id,
            vrid,
            priority: vip === port.ip ? 255 : 100,
            preempt: true,
            advertMs: 1000,
            ...previous,
            vip,
          },
        ],
      });
    },
  });
  registry.register({
    pattern: /^(no )?vrrp (\d+)(?: (priority|advertisement-interval) (\d+)| (preempt))?$/i,
    modes: ['interface'],
    run: (match, engine, device, context) => {
      const port = currentPort(device, context),
        groups = vrrpConfigGroups(device);
      const group = groups.find((entry) => entry.port === port.id && entry.vrid === Number(match[2]));
      if (!group) throw new Error('Configure vrrp VRID ip VIP nesta interface.');
      if (!match[3] && !match[5]) {
        if (!match[1]) throw new Error('Use no vrrp VRID para remover o grupo.');
        groups.splice(groups.indexOf(group), 1);
      } else if (match[5]) group.preempt = !match[1];
      else {
        if (match[1]) throw new Error('Informe o novo valor sem no.');
        if (match[3].toLowerCase() === 'priority') group.priority = Number(match[4]);
        else group.advertMs = Number(match[4]);
      }
      engine.configureVrrp(device.id, { enabled: device.vrrp?.enabled ?? true, groups });
    },
  });
  registry.register({
    pattern: /^show vrrp$/i,
    modes: ALL_MODES,
    run: (_match, engine, device) => {
      engine.refreshVrrp();
      if (!device.vrrp) return 'VRRP não configurado.';
      return (
        `VRRPv3 IPv4 ${device.vrrp.enabled ? 'ativo' : 'inativo'}\n` +
        device.vrrp.groups
          .map(
            (group) =>
              `${device.interfaces.find((port) => port.id === group.port)!.name} VRID ${group.vrid} VIP ${group.vip} ${group.state}\n` +
              ` MAC ${vrrpMac(group.vrid)} · prioridade ${group.priority} (efetiva ${group.effectivePriority ?? group.priority}) · preempt ${group.preempt ? 'on' : 'off'} · anúncios ${group.advertMs} ms\n` +
              ` Ativo ${group.state === 'ACTIVE' ? 'local' : (group.activeIp ?? 'desconhecido')} · timer ${((group.downAt ?? group.advertAt ?? engine.state.clock) - engine.state.clock).toFixed(3)} ms · TX/RX ${group.sent}/${group.received}`
          )
          .join('\n')
      );
    },
  });
}
export function vrrpRunningConfig(device: Device) {
  return device.vrrp
    ? [
        ...device.vrrp.groups.flatMap((group) => [
          'interface ' + device.interfaces.find((port) => port.id === group.port)!.name,
          ` vrrp ${group.vrid} ip ${group.vip}`,
          ` vrrp ${group.vrid} priority ${group.priority}`,
          ` vrrp ${group.vrid} advertisement-interval ${group.advertMs}`,
          ` ${group.preempt ? '' : 'no '}vrrp ${group.vrid} preempt`,
          ...(group.track ?? []).map(
            (track) =>
              ` vrrp ${group.vrid} track ${track.port ? 'interface ' + device.interfaces.find((p) => p.id === track.port)!.name : 'route ' + track.route} decrement ${track.decrement}`
          ),
          'exit',
        ]),
        `${device.vrrp.enabled ? '' : 'no '}service vrrp`,
      ]
    : [];
}
