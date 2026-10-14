import type { SimulationEngine } from './core/engine';
import { frameSchema, LIMITS, type Device, type NetworkEvent, type Packet, type Packet6 } from './model';
import type { Scenario } from './scenarios-model';
export interface ScenarioEvidence {
  cause: 'policy' | 'link' | 'transport' | 'response' | 'timeout' | 'unknown';
  events: { id: string; atMs: number; device: string; type: NetworkEvent['type']; reason: string }[];
  path: string[];
  hops?: { id: string; atMs: number; device: string; port?: string; direction: 'sent' | 'received' }[];
  truncated?: boolean;
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
  const traces = new Set(id ? [id] : []);
  const packetMatches = (p: Packet, depth = 0): boolean => {
    if (!id) return false;
    if (p.protocol === 'ICMP') return p.probeId === id;
    if (p.protocol === 'TCP') return Boolean(p.traceId && traces.has(p.traceId));
    if (p.protocol !== 'UDP') return false;
    const payload = p.payload;
    if (payload.protocol === 'VXLAN' && depth < 4) {
      try {
        const frame = frameSchema.parse(JSON.parse(payload.message.frame));
        return Boolean(
          (frame.packet && packetMatches(frame.packet, depth + 1)) ||
          (frame.ipv6 && packet6Matches(frame.ipv6))
        );
      } catch {
        return false;
      }
    }
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
      id &&
      (p.protocol === 'ICMPv6'
        ? p.probeId === id
        : p.protocol === 'TCP' && p.segment.traceId && traces.has(p.segment.traceId))
    );
  const events = [
    ...new Map(
      [...(e.state.diagnostics ?? []), ...e.state.events, ...(e.state.capture?.frames ?? [])].map((event) => [
        event.id,
        event,
      ])
    ).values(),
  ].sort((a, b) => a.time - b.time);
  const window = events.filter((event) => event.time >= at && event.time <= until);
  // Resolve server-side connection IDs from the same traced packet and exact tuple.
  // Never join a backend health check or an unrelated concurrent request by time alone.
  for (let hop = 0; hop < 8; hop++) {
    const size = traces.size;
    for (const event of window) {
      const packet =
        event.packet ??
        event.frame?.packet ??
        (event.frame?.ipv6?.protocol === 'TCP' ? event.frame.ipv6.segment : undefined);
      if (
        event.type !== 'FRAME_RECEIVED' ||
        packet?.protocol !== 'TCP' ||
        !packet.traceId ||
        !traces.has(packet.traceId)
      )
        continue;
      const target = e.state.devices.find((d) => d.id === event.device);
      for (const c of target?.tcpConnections ?? [])
        if (
          c.role === 'server' &&
          c.startedAt >= at &&
          c.startedAt <= event.time &&
          c.localIp === packet.dst &&
          c.remoteIp === packet.src &&
          c.localPort === packet.destinationPort &&
          c.remotePort === packet.sourcePort
        )
          traces.add(c.id);
    }
    for (const device of e.state.devices)
      for (const request of device.proxy?.requests ?? [])
        if (!request.health && request.front && traces.has(request.front)) traces.add(request.upstream);
    if (traces.size === size) break;
  }
  const related = window.filter((event) =>
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
  const path = [
    ...new Set(
      related
        .filter((event) => event.type === 'FRAME_RECEIVED' || event.type === 'FRAME_SENT')
        .map((event) => e.device(event.device).hostname)
    ),
  ];
  const hops = related.filter((event) => ['FRAME_SENT', 'FRAME_RECEIVED'].includes(event.type));
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
      reason: event.reason.slice(0, 500),
    })),
    path: path.slice(0, 64),
    hops: hops.slice(0, 128).map((event) => ({
      id: event.id,
      atMs: event.time - at,
      device: e.device(event.device).hostname,
      ...(event.port ? { port: event.port } : {}),
      direction: event.type === 'FRAME_SENT' ? 'sent' : 'received',
    })),
    truncated:
      failures.length > 16 ||
      hops.length > 128 ||
      path.length > 64 ||
      Boolean(e.state.capture?.dropped) ||
      (e.state.diagnostics?.length ?? 0) >= LIMITS.diagnostics,
  };
}
