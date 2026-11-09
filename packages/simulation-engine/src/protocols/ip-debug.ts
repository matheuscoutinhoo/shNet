import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Packet } from '../model';
import { debugLog } from './syslog-buffer';
import { longInterfaceName } from './interface-name';

/** "debug ip packet" / "debug ip icmp" output, in IOS wording, for traffic the router handles itself. */
const UNREACHABLE: Record<number, string> = {
  0: 'net',
  1: 'host',
  3: 'port',
  4: 'frag. needed and DF set',
};
export function debugReceived(e: SimulationEngine, d: Device, port: NetworkInterface, packet: Packet) {
  const clock = e.state.clock;
  debugLog(
    d,
    clock,
    'ip packet',
    `IP: s=${packet.src} (${longInterfaceName(port.name)}), d=${packet.dst}, len ${packet.bytes}, rcvd 3`
  );
  if (packet.protocol !== 'ICMP') return;
  if (packet.kind === 'echo-reply')
    debugLog(
      d,
      clock,
      'ip icmp',
      `ICMP: echo reply rcvd, src ${packet.src}, dst ${packet.dst}, topology BASE, dscp 0 topoid 0`
    );
  else if (packet.kind === 'time-exceeded')
    debugLog(d, clock, 'ip icmp', `ICMP: time exceeded rcvd from ${packet.src}`);
  else if (packet.kind === 'unreachable')
    debugLog(
      d,
      clock,
      'ip icmp',
      `ICMP: dst (${packet.error?.quote.dst ?? packet.dst}) ${UNREACHABLE[packet.error?.code ?? 1] ?? 'host'} unreachable rcv from ${packet.src}`
    );
}
export function debugEchoReply(e: SimulationEngine, d: Device, request: Packet) {
  debugLog(
    d,
    e.state.clock,
    'ip icmp',
    `ICMP: echo reply sent, src ${request.dst}, dst ${request.src}, topology BASE, dscp 0 topoid 0`
  );
}
export function debugSent(e: SimulationEngine, d: Device, port: NetworkInterface, packet: Packet) {
  debugLog(
    d,
    e.state.clock,
    'ip packet',
    `IP: s=${packet.src} (local), d=${packet.dst} (${longInterfaceName(port.name)}), len ${packet.bytes}, sending`
  );
}
export function debugUnroutable(e: SimulationEngine, d: Device, packet: Packet, ingress?: NetworkInterface) {
  debugLog(
    d,
    e.state.clock,
    'ip packet',
    `IP: s=${packet.src} (${ingress ? longInterfaceName(ingress.name) : 'local'}), d=${packet.dst}, len ${packet.bytes}, unroutable`
  );
}
export function debugIcmpError(
  e: SimulationEngine,
  d: Device,
  kind: 'time-exceeded' | 'unreachable',
  code: number,
  original: Packet
) {
  debugLog(
    d,
    e.state.clock,
    'ip icmp',
    kind === 'time-exceeded'
      ? `ICMP: time exceeded (time to live) sent to ${original.src} (dest was ${original.dst})`
      : `ICMP: dst (${original.dst}) ${UNREACHABLE[code] ?? 'host'} unreachable sent to ${original.src}`
  );
}
