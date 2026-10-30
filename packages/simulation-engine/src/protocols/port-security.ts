import type { Device, Frame, NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
export function permitPortSecurity(e: SimulationEngine, d: Device, p: NetworkInterface, f: Frame) {
  const c = p.portSecurity;
  if (!c?.enabled) return true;
  if (c.macs.includes(f.src) || c.learned.includes(f.src)) return true;
  if (c.macs.length + c.learned.length < c.maximum) {
    (c.sticky ? c.macs : c.learned).push(f.src);
    return true;
  }
  c.violations++;
  if (c.violation === 'shutdown') {
    p.errDisabled = { reason: 'psecure-violation', at: e.state.clock };
    d.macTable = d.macTable.filter((m) => m.port !== p.id);
  }
  if (c.violation !== 'protect')
    e.emit(
      'CONFIG_CHANGED',
      d.id,
      `${p.name}: port-security violation by source MAC ${f.src}; ${c.violation}.`,
      { port: p.id }
    );
  e.drop(d, 'Port security: secure source MAC limit exceeded.', p.id, f);
  return false;
}
