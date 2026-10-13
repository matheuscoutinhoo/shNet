import type { Device, Snapshot } from '../model';
import { stateSyncPending, stateSyncStatus } from '../protocols/state-sync';
import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';

export function stateSyncRunningConfig(s: Snapshot, d: Device) {
  const c = d.stateSync;
  return c
    ? [
        'ha state-sync configure ' +
          c.peer +
          ' ' +
          JSON.stringify({
            portA: c.port,
            portB: s.devices.find((p) => p.id === c.peer)!.stateSync!.port,
            mappings: c.portMap.map((p) => ({ a: p.local, b: p.remote })),
          }),
      ]
    : [];
}
export function registerStateSyncCommands(r: CommandRegistry) {
  r.register({
    pattern: /^show ha state-sync$/i,
    modes: ALL_MODES,
    run: (_m, e, d) => {
      const c = d.stateSync;
      if (!c) return 'Sincronização HA desativada; VRRP não replica sessões.';
      return [
        'HA: ' + stateSyncStatus(e.state, d),
        'Peer: ' + e.device(c.peer).hostname + ' · porta local: ' + c.port,
        'Pendentes: ' + stateSyncPending(e.state, d),
        'Enviadas: ' + c.sent + ' · recebidas: ' + c.received + ' · recusadas: ' + c.rejected,
        ...c.portMap.map((p) => p.local + ' → ' + p.remote),
        'Canal de estado simulado; sem codec proprietário. Inspeção de aplicação, hairpin e SIP ALG não são replicados.',
      ].join('\n');
    },
  });
  r.register({
    pattern: /^ha state-sync configure (\S+) (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const peer = e.state.devices.find((p) => p.id === m[1] || p.hostname === m[1]);
      if (!peer) throw new Error('Peer HA não encontrado.');
      e.configureStateSyncPair(d.id, peer.id, JSON.parse(m[2]));
    },
  });
  r.register({
    pattern: /^no ha state-sync$/i,
    modes: CONFIG_MODES,
    run: (_m, e, d) => e.disableStateSync(d.id),
  });
}
