import type { Device } from '../model';
import { ALL_MODES, CONFIG_MODES, currentPort, type CommandRegistry } from './registry';
export function registerLacpCommands(r: CommandRegistry) {
  r.register({
    pattern: /^channel-group (\d+) mode (active|passive)$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const member = currentPort(d, c),
        number = Number(m[1]),
        old = d.interfaces.find((p) => p.aggregate?.number === number);
      e.configureLacp(
        d.id,
        number,
        m[2].toLowerCase() as 'active' | 'passive',
        [...new Set([...(old?.aggregate?.members ?? []), member.id])],
        old?.aggregate?.minLinks ?? 1
      );
    },
  });
  r.register({
    pattern: /^no channel-group$/i,
    modes: ['interface'],
    run: (_m, e, d, c) => {
      const member = currentPort(d, c),
        port = d.interfaces.find((p) => p.id === member.channel);
      if (!port?.aggregate) throw new Error('Interface sem grupo.');
      const agg = port.aggregate,
        remaining = agg.members.filter((p) => p !== member.id);
      if (remaining.length) e.configureLacp(d.id, agg.number, agg.mode, remaining, agg.minLinks);
      else e.removeLacp(d.id, port.id);
    },
  });
  r.register({
    pattern: /^lacp min-links (\d+)$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const agg = currentPort(d, c).aggregate;
      if (!agg) throw new Error('Selecione Port-channel.');
      e.configureLacp(d.id, agg.number, agg.mode, agg.members, Number(m[1]));
    },
  });
  r.register({
    pattern: /^no port-channel (\d+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const p = d.interfaces.find((p) => p.aggregate?.number === Number(m[1]));
      if (!p) throw new Error('Grupo inexistente.');
      e.removeLacp(d.id, p.id);
    },
  });
  r.register({
    pattern: /^show (?:etherchannel summary|lacp neighbors)$/i,
    modes: ALL_MODES,
    run: (_m, e, d) => {
      e.refreshSpanningTree();
      return (
        d.interfaces
          .filter((p) => p.aggregate)
          .map(
            (p) =>
              `${p.name} ${p.aggregate!.mode} min-links=${p.aggregate!.minLinks}\n` +
              p
                .aggregate!.members.map(
                  (id) =>
                    `${d.interfaces.find((m) => m.id === id)!.name} ${p.aggregate!.selected.includes(id) ? 'collecting/distributing' : 'suspended'} partner=${p.aggregate!.received.find((r) => r.port === id)?.pdu.actor.system ?? '-'}`
                )
                .join('\n')
          )
          .join('\n') || 'Nenhum EtherChannel'
      );
    },
  });
}
export function lacpRunningConfig(d: Device) {
  return d.interfaces
    .filter((p) => p.aggregate)
    .flatMap((p) => [
      ...p.aggregate!.members.flatMap((id) => [
        'interface ' + d.interfaces.find((m) => m.id === id)!.name,
        ` channel-group ${p.aggregate!.number} mode ${p.aggregate!.mode}`,
        'exit',
      ]),
      'interface ' + p.name,
      ' lacp min-links ' + p.aggregate!.minLinks,
      'exit',
    ]);
}
