import type { SimulationEngine } from '../core/engine';
import { interfaceOperational, withOperationalMemo } from './layer3';
import { longInterfaceName } from './interface-name';

/**
 * IOS logs %LINK-3-UPDOWN and %LINEPROTO-5-UPDOWN whenever a physical port changes state for any
 * reason: a cable is connected or removed, the peer powers off or shuts its port, a fault cuts
 * the link. Administrative changes are logged by the interface command itself (setPort). The last
 * logged state lives on the interface, so a restored lab continues exactly like the original; a
 * port without one (a lab saved before) records its current state without logging.
 */
export function logLineProtocolChanges(e: SimulationEngine) {
  withOperationalMemo(() => {
    for (const d of e.state.devices) {
      if (d.type !== 'router' && d.type !== 'switch') continue;
      for (const p of d.interfaces) {
        if (p.logical || p.loopback || p.tunnel || p.vxlan || p.iosTunnel || p.media === 'console') continue;
        // A device that is off keeps its ports down: they come up again, logged, when it boots.
        const up = d.power && p.adminUp && interfaceOperational(e.state, d, p);
        const previous = p.lineProtocol;
        if (previous === up) continue;
        p.lineProtocol = up;
        if (previous === undefined || !d.power || !p.adminUp) continue;
        const name = longInterfaceName(p.name);
        e.emit(
          up ? 'LINK_UP' : 'LINK_DOWN',
          d.id,
          `%LINK-3-UPDOWN: Interface ${name}, changed state to ${up ? 'up' : 'down'}`,
          { port: p.id }
        );
        e.emit(
          up ? 'LINK_UP' : 'LINK_DOWN',
          d.id,
          `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to ${up ? 'up' : 'down'}`,
          { port: p.id }
        );
      }
    }
  });
}
/** Records a state already logged by an administrative change, so it is not logged twice. */
export function noteLineProtocol(e: SimulationEngine, device: string, port: string, up: boolean) {
  const p = e.device(device).interfaces.find((x) => x.id === port);
  if (p) p.lineProtocol = up;
}
