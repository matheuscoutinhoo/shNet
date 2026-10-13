import type { SimulationEngine } from './core/engine';
import type { Device, NetworkEvent, Packet, Packet6 } from './model';
import type { Scenario } from './scenarios-model';
export interface ScenarioEvidence {
  cause: 'policy' | 'link' | 'transport' | 'response' | 'timeout' | 'unknown';
  events: { id: string; atMs: number; device: string; type: NetworkEvent['type']; reason: string }[];
  path: string[];
}
export function scenarioEvidence(
  e: SimulationEngine,
  d: Device,
  f: Scenario['flows'][number],
  id: string | undefined,
  at: number,
  until: number,
  received: boolean
): ScenarioEvidence {
  const packetMatches = (p: Packet) => {
    if (!id) return false;
    if (p.protocol === 'ICMP') return p.probeId === id;
    if (p.protocol === 'TCP') return p.traceId === id;
    if (p.protocol !== 'UDP') return false;
    const payload = p.payload;
    if (payload.protocol === 'DNS')
      return payload.message.transactionId === d.dnsQueries?.find((q) => q.id === id)?.transactionId;
    if (payload.protocol === 'SNMP')
      return payload.message.requestId === d.snmpQueries?.find((q) => q.id === id)?.requestId;
    if (payload.protocol === 'DHCP') return payload.message.transactionId === id;
    if (payload.protocol === 'SYSLOG') return payload.message.id === id;
    if (payload.protocol === 'NTP')
      return (
        (p.src === f.target && d.interfaces.some((i) => i.ip === p.dst)) ||
        (p.dst === f.target && d.interfaces.some((i) => i.ip === p.src))
      );
    return false;
  };
  const packet6Matches = (p: Packet6) =>
    Boolean(
      id && (p.protocol === 'ICMPv6' ? p.probeId === id : p.protocol === 'TCP' && p.segment.traceId === id)
    );
  const events = [
    ...new Map(
      [...(e.state.diagnostics ?? []), ...e.state.events, ...(e.state.capture?.frames ?? [])].map((event) => [
        event.id,
        event,
      ])
    ).values(),
  ].sort((a, b) => a.time - b.time);
  const related = events.filter(
    (event) =>
      event.time >= at &&
      event.time <= until &&
      Boolean(
        (event.packet && packetMatches(event.packet)) ||
        (event.frame?.packet && packetMatches(event.frame.packet)) ||
        (event.frame?.ipv6 && packet6Matches(event.frame.ipv6))
      )
  );
  const failures = related.filter((event) =>
    ['ACL_DENY', 'FIREWALL_DENY', 'PACKET_DROPPED', 'TCP_RESET'].includes(event.type)
  );
  const policy = failures.some((event) => event.type === 'ACL_DENY' || event.type === 'FIREWALL_DENY');
  const link = failures.some((event) => /MTU|STP|link|Interface|Wi-Fi/i.test(event.reason));
  return {
    cause: policy
      ? 'policy'
      : link
        ? 'link'
        : failures.some((event) => event.type === 'TCP_RESET')
          ? 'transport'
          : received
            ? 'response'
            : id
              ? 'timeout'
              : 'unknown',
    events: failures.slice(0, 16).map((event) => ({
      id: event.id,
      atMs: event.time - at,
      device: e.device(event.device).hostname,
      type: event.type,
      reason: event.reason,
    })),
    path: [
      ...new Set(
        related
          .filter((event) => event.type === 'FRAME_RECEIVED' || event.type === 'FRAME_SENT')
          .map((event) => e.device(event.device).hostname)
      ),
    ].slice(0, 64),
  };
}
