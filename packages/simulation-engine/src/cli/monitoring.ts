import type { Device } from '../model';
import { monitoring, scheduleMonitoring } from '../protocols/monitoring';
import { interfaceName } from './operational';
import { ALL_MODES, type CommandRegistry } from './registry';
export function registerMonitoring(r: CommandRegistry) {
  r.register({
    pattern: /^ip sla (\d+)$/i,
    modes: ['config'],
    run: (m, e, d, c) => {
      const s = monitoring(e, d),
        id = Number(m[1]);
      if (!s.operations.some((o) => o.id === id))
        s.operations.push({ id, frequencyMs: 60000, timeoutMs: 5000, scheduled: false, status: 'unknown' });
      c.mode = 'ip-sla';
      c.sla = id;
    },
  });
  r.register({
    pattern: /^icmp-echo ([\d.]+)(?: source-interface (\S+))?$/i,
    modes: ['ip-sla'],
    run: (m, _e, d, c) => {
      const op = d.monitoring!.operations.find((o) => o.id === c.sla)!;
      op.target = m[1];
      if (m[2]) {
        const p = d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(m[2]).toLowerCase());
        if (!p) throw new Error('Invalid source interface.');
        op.sourcePort = p.id;
      }
    },
  });
  r.register({
    pattern: /^(frequency|timeout) (\d+)$/i,
    modes: ['ip-sla'],
    run: (m, _e, d, c) => {
      const op = d.monitoring!.operations.find((o) => o.id === c.sla)!;
      if (m[1].toLowerCase() === 'frequency') op.frequencyMs = Number(m[2]) * 1000;
      else op.timeoutMs = Number(m[2]);
    },
  });
  r.register({
    pattern: /^ip sla schedule (\d+)(?: life forever)? start-time now$/i,
    modes: ['config'],
    run: (m, e, d) => {
      const op = d.monitoring?.operations.find((o) => o.id === Number(m[1]));
      if (!op?.target) throw new Error('Configure an ICMP echo operation first.');
      op.scheduled = true;
      op.nextAt = e.state.clock;
      scheduleMonitoring(e, d);
    },
  });
  r.register({
    pattern: /^track (\d+) ip sla (\d+) reachability$/i,
    modes: ['config'],
    run: (m, e, d) => {
      const s = monitoring(e, d),
        id = Number(m[1]);
      s.tracks = [
        ...s.tracks.filter((t) => t.id !== id),
        { id, kind: 'sla', operation: Number(m[2]), state: false, changedAt: e.state.clock },
      ];
      scheduleMonitoring(e, d);
    },
  });
  r.register({
    pattern: /^track (\d+) interface (\S+) line-protocol$/i,
    modes: ['config'],
    run: (m, e, d) => {
      const s = monitoring(e, d),
        id = Number(m[1]),
        p = d.interfaces.find((p) => p.name.toLowerCase() === interfaceName(m[2]).toLowerCase());
      if (!p) throw new Error('Invalid tracked interface.');
      s.tracks = [
        ...s.tracks.filter((t) => t.id !== id),
        { id, kind: 'interface', port: p.id, state: false, changedAt: e.state.clock },
      ];
      scheduleMonitoring(e, d);
    },
  });
  r.register({
    pattern: /^show (track|ip sla statistics)(?: (\d+))?$/i,
    modes: ALL_MODES,
    run: (m, _e, d) =>
      m[1].toLowerCase() === 'track'
        ? (d.monitoring?.tracks ?? [])
            .filter((t) => !m[2] || t.id === Number(m[2]))
            .map((t) => `Track ${t.id}: ${t.state ? 'Up' : 'Down'}, ${t.kind}, changed at ${Math.round(t.changedAt)} ms`)
            .join('\n')
        : (d.monitoring?.operations ?? [])
            .filter((o) => !m[2] || o.id === Number(m[2]))
            .map(
              // IOS reports whole milliseconds; sub-millisecond lab RTTs show as 1.
              (o) =>
                `Operation ${o.id}: ${o.status}, target ${o.target ?? 'unset'}, RTT ${o.rtt === undefined ? '-' : Math.max(1, Math.round(o.rtt))} ms`
            )
            .join('\n'),
  });
}
export function monitoringRunning(d: Device) {
  return [
    ...(d.monitoring?.operations ?? []).flatMap((o) => [
      'ip sla ' + o.id,
      ...(o.target
        ? [
            ' icmp-echo ' +
              o.target +
              (o.sourcePort
                ? ' source-interface ' + d.interfaces.find((p) => p.id === o.sourcePort)!.name
                : ''),
          ]
        : []),
      ' frequency ' + o.frequencyMs / 1000,
      ' timeout ' + o.timeoutMs,
      'exit',
      ...(o.scheduled ? ['ip sla schedule ' + o.id + ' life forever start-time now'] : []),
    ]),
    ...(d.monitoring?.tracks ?? []).map((t) =>
      t.kind === 'sla'
        ? `track ${t.id} ip sla ${t.operation} reachability`
        : `track ${t.id} interface ${d.interfaces.find((p) => p.id === t.port)!.name} line-protocol`
    ),
  ];
}
