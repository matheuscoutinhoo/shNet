import type { SimulationEngine } from '../core/engine';
import { BROADCAST, type Device, type Frame, type NetworkInterface } from '../model';
import { qosFrameBytes } from './qos-classify';
import { scheduleErrdisableRecovery } from './errdisable';

type StormClass = 'broadcast' | 'multicast' | 'unicast';
const stormClass = (f: Frame): StormClass =>
  f.dst === BROADCAST ? 'broadcast' : parseInt(f.dst.slice(0, 2), 16) & 1 ? 'multicast' : 'unicast';
/**
 * "storm-control {broadcast|multicast|unicast} level N": ingress traffic of a class is measured
 * over one-second intervals; once it exceeds N% of the port bandwidth the rest of that class is
 * discarded until the interval ends. "storm-control action shutdown" err-disables the port and
 * "action trap" reports the storm.
 */
export function permitStormControl(e: SimulationEngine, d: Device, p: NetworkInterface, f: Frame) {
  const s = p.stormControl;
  if (!s) return true;
  const kind = stormClass(f),
    level = s[kind];
  if (level === undefined) return true;
  const interval = Math.floor(e.state.clock / 1000) * 1000;
  if (s.window?.at !== interval) s.window = { at: interval, broadcast: 0, multicast: 0, unicast: 0 };
  const window = s.window,
    bytes = qosFrameBytes(f),
    limit = (level / 100) * p.speed * 125000;
  if (!window.filtered?.includes(kind) && window[kind] + bytes <= limit) {
    window[kind] += bytes;
    return true;
  }
  if (!window.filtered?.includes(kind)) {
    window.filtered = [...(window.filtered ?? []), kind];
    if (s.action === 'shutdown') {
      p.errDisabled = { reason: 'storm-control', at: e.state.clock };
      d.macTable = d.macTable.filter((entry) => entry.port !== p.id);
      scheduleErrdisableRecovery(e, d, p);
      e.emit(
        'LINK_DOWN',
        d.id,
        `%PM-4-ERR_DISABLE: storm-control error detected on ${p.name}, putting ${p.name} in err-disable state`,
        { port: p.id, frame: f }
      );
      e.refreshSpanningTree();
    } else
      e.emit(
        'CONFIG_CHANGED',
        d.id,
        `%STORM_CONTROL-3-FILTERED: A packet storm was detected on ${p.name}. A packet filter action has been applied on the interface.`,
        { port: p.id, frame: f }
      );
  }
  e.drop(d, `Storm control: ${kind} traffic above ${level.toFixed(2)}% on ${p.name}.`, p.id, f);
  return false;
}
