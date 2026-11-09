import type { Device, Frame, NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import { scheduleErrdisableRecovery } from './errdisable';
import { dottedMac, longInterfaceName } from './interface-name';

type PortSecurity = NonNullable<NetworkInterface['portSecurity']>;
/** Dynamic secure MACs leave after the aging time: since learned (absolute) or last seen (inactivity). */
function age(c: PortSecurity, now: number) {
  if (!c.aging || !c.ages?.length) return;
  const limit = c.aging.minutes * 60000,
    expired = new Set(c.ages.filter((a) => now - a.at >= limit).map((a) => a.mac));
  if (!expired.size) return;
  c.learned = c.learned.filter((mac) => !expired.has(mac));
  c.ages = c.ages.filter((a) => !expired.has(a.mac));
}
export function permitPortSecurity(e: SimulationEngine, d: Device, p: NetworkInterface, f: Frame) {
  const c = p.portSecurity;
  if (!c?.enabled) return true;
  const now = e.state.clock;
  age(c, now);
  c.lastSource = dottedMac(f.src) + ':' + (f.vlan ?? p.accessVlan);
  if (c.macs.includes(f.src) || c.stickyMacs.includes(f.src)) return true;
  if (c.learned.includes(f.src)) {
    if (c.aging?.type === 'inactivity')
      c.ages = [...(c.ages ?? []).filter((a) => a.mac !== f.src), { mac: f.src, at: now }];
    return true;
  }
  if (c.macs.length + c.stickyMacs.length + c.learned.length < c.maximum) {
    if (c.sticky) c.stickyMacs.push(f.src);
    else {
      c.learned.push(f.src);
      if (c.aging) c.ages = [...(c.ages ?? []), { mac: f.src, at: now }];
    }
    return true;
  }
  c.violations++;
  const violation = `%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${dottedMac(f.src)} on port ${longInterfaceName(p.name)}.`;
  if (c.violation === 'shutdown') {
    p.errDisabled = { reason: 'psecure-violation', at: now };
    d.macTable = d.macTable.filter((m) => m.port !== p.id);
    scheduleErrdisableRecovery(e, d, p);
    e.emit(
      'LINK_DOWN',
      d.id,
      `%PM-4-ERR_DISABLE: psecure-violation error detected on ${p.name}, putting ${p.name} in err-disable state`,
      { port: p.id }
    );
  }
  if (c.violation !== 'protect') e.emit('CONFIG_CHANGED', d.id, violation, { port: p.id });
  e.drop(d, 'Port security: secure source MAC limit exceeded.', p.id, f);
  if (c.violation === 'shutdown') e.refreshSpanningTree();
  return false;
}
