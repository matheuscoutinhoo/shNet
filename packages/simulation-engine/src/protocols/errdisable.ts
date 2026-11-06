import type { SimulationEngine } from '../core/engine';
import type { Action, Device, NetworkInterface } from '../model';

type Recovery = Extract<Action, { kind: 'errdisable-recovery' }>;
/**
 * "errdisable recovery cause X" / "interval N": a port err-disabled for a covered reason comes
 * back after the interval, as IOS does. Each err-disable occurrence gets one timer.
 */
export function scheduleErrdisableRecovery(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const recovery = d.iosSystem?.errdisableRecovery,
    cause = p.errDisabled;
  if (!recovery || !cause || !recovery.causes.includes(cause.reason)) return;
  const pending = e.state.queue.some(
    ({ action: a }) =>
      a.kind === 'errdisable-recovery' && a.device === d.id && a.port === p.id && a.since === cause.at
  );
  if (!pending)
    e.scheduleAt(cause.at + recovery.intervalS * 1000, {
      kind: 'errdisable-recovery',
      device: d.id,
      port: p.id,
      since: cause.at,
    });
}
export function handleErrdisableRecovery(e: SimulationEngine, a: Recovery) {
  const d = e.state.devices.find((x) => x.id === a.device),
    p = d?.interfaces.find((x) => x.id === a.port);
  // Stale when the port was recovered by hand, err-disabled again, or the cause is no longer covered.
  if (!d || !p?.errDisabled || p.errDisabled.at !== a.since) return;
  if (!d.iosSystem?.errdisableRecovery?.causes.includes(p.errDisabled.reason)) return;
  const reason = p.errDisabled.reason;
  delete p.errDisabled;
  e.emit(
    'LINK_UP',
    d.id,
    `%PM-4-ERR_RECOVER: Attempting to recover from ${reason} err-disable state on ${p.name}`,
    { port: p.id }
  );
  e.refreshSpanningTree();
}
