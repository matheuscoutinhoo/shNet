import type { Link, NetworkEvent } from '@shlab/engine';

export type EventTone = 'traffic' | 'control' | 'success' | 'drop' | 'config';
export type ActivityKind = 'transmit' | 'receive' | 'control' | 'success' | 'drop' | 'config';

export interface CanvasActivity {
  eventId: string;
  tone: EventTone;
  kind: ActivityKind;
  reason: string;
  port?: string;
  expiresAt: number;
  manualStep: boolean;
  packet?: {
    eventId: string;
    tone: EventTone;
    reverse: boolean;
    control: boolean;
    radioControl: boolean;
    expiresAt: number;
  };
}

export interface CanvasActivities {
  devices: Map<string, CanvasActivity>;
  links: Map<string, CanvasActivity>;
}

export const CANVAS_ACTIVITY_LIMITS = { events: 256, devices: 96, links: 64, lifetime: 1400 } as const;

/** Presentation follows emitted events; it never creates or advances network traffic. */
export function eventTone(event: NetworkEvent): EventTone {
  const packet = event.frame?.packet;
  const ipv6 = event.frame?.ipv6;
  const udp = packet?.protocol === 'UDP' ? packet : undefined;
  const dhcp6 =
    ipv6?.protocol === 'UDP' && ['DHCPv6', 'DHCPv6-RELAY'].includes(ipv6.datagram.payload.protocol);
  const tunnelControl = udp?.payload.protocol === 'TUNNEL' && udp.payload.message.kind !== 'data';
  // CAPWAP records are opaque: use the typed payload plus its explicit control/data channel.
  const capwapControl =
    udp?.payload.protocol === 'CAPWAP' &&
    [udp.sourcePort, udp.destinationPort].includes(5246) &&
    ![udp.sourcePort, udp.destinationPort].includes(5247);
  if (
    /(?:DENY|DROPPED|_DROP|TIMEOUT|FAILED|EXHAUSTED|REJECTED|_RESET)$/.test(event.type) ||
    ['LINK_DOWN', 'DHCP_NAK', 'DHCP_DECLINE'].includes(event.type)
  )
    return 'drop';
  if (
    [
      'PING_SUCCESS',
      'DHCP_BOUND',
      'DNS_ANSWER',
      'DNS_CACHE_HIT',
      'IP_REASSEMBLED',
      'SNMP_ANSWER',
      'REMOTE_COMMIT',
      'APPLICATION_DATA',
    ].includes(event.type)
  )
    return 'success';
  if (event.type === 'CONFIG_CHANGED' || event.type === 'LINK_UP') return 'config';
  if (
    event.frame?.bpdu ||
    event.frame?.lacp ||
    event.frame?.eapol ||
    event.frame?.wifi ||
    event.frame?.meshHello ||
    event.frame?.arp ||
    ['OSPF', 'VRRP'].includes(packet?.protocol ?? '') ||
    dhcp6 ||
    tunnelControl ||
    capwapControl ||
    (packet?.protocol === 'UDP' &&
      ['RIP', 'DHCP', 'RADIUS', 'EAP-RADIUS', 'SDWAN', 'NTP'].includes(packet.payload.protocol)) ||
    ['ns', 'na', 'rs', 'ra'].includes(event.frame?.ipv6?.kind ?? '') ||
    /^(?:ARP|NDP|BPDU|STP|LACP|WIFI|DOT1X|AAA|DHCP|OSPF|BGP|VRRP|RIP|ROUTE|EVPN|NTP|SDWAN)_/.test(event.type)
  )
    return 'control';
  return 'traffic';
}

export function emptyCanvasActivities(): CanvasActivities {
  return { devices: new Map(), links: new Map() };
}

function putBounded(map: Map<string, CanvasActivity>, id: string, activity: CanvasActivity, limit: number) {
  map.delete(id);
  map.set(id, activity);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** Inspect only the newest bounded slice, even if an imported history is much larger. */
export function newCanvasEvents(events: readonly NetworkEvent[], afterId: string | undefined) {
  const start = Math.max(0, events.length - CANVAS_ACTIVITY_LIMITS.events);
  if (!afterId) return events.slice(start);
  let cursor = events.length - 1;
  while (cursor >= start && events[cursor].id !== afterId) cursor--;
  return events.slice(Math.max(start, cursor + 1));
}

export function pruneCanvasActivities(activities: CanvasActivities, now: number): CanvasActivities {
  const prune = (map: Map<string, CanvasActivity>) =>
    new Map(
      [...map]
        .filter(([, activity]) => activity.expiresAt > now)
        .map(
          ([id, activity]) =>
            [
              id,
              activity.packet && activity.packet.expiresAt <= now
                ? { ...activity, packet: undefined }
                : activity,
            ] as const
        )
    );
  return {
    devices: prune(activities.devices),
    links: prune(activities.links),
  };
}

export function collectCanvasActivities(
  previous: CanvasActivities,
  events: readonly NetworkEvent[],
  links: readonly Link[],
  now: number,
  manualStep: boolean
): CanvasActivities {
  const next = pruneCanvasActivities(previous, now);
  const byId = new Map(links.map((link) => [link.id, link]));
  const byPort = new Map<string, Link | undefined>();
  for (const link of links) {
    for (const end of [link.a, link.b]) {
      const key = end.device + ':' + end.port;
      // Shared radio ports do not identify one peer: keep ambiguous drops on the device.
      byPort.set(key, byPort.has(key) ? undefined : link);
    }
  }
  for (const event of events.slice(-CANVAS_ACTIVITY_LIMITS.events)) {
    const tone = eventTone(event);
    const kind: ActivityKind =
      tone === 'traffic' ? (/(?:SENT|ENQUEUE|ENCAP)$/.test(event.type) ? 'transmit' : 'receive') : tone;
    const activity: CanvasActivity = {
      eventId: event.id,
      tone,
      kind,
      reason: event.reason,
      port: event.port,
      expiresAt: now + CANVAS_ACTIVITY_LIMITS.lifetime,
      manualStep,
    };
    putBounded(next.devices, event.device, activity, CANVAS_ACTIVITY_LIMITS.devices);
    const link = event.link
      ? byId.get(event.link)
      : event.port && byPort.get(event.device + ':' + event.port);
    if (!link) continue;
    // A frame can be animated only after an actual transmission on this exact link.
    // Drops remove the marker; ACL/QoS rejection before sending never looks delivered.
    const old = next.links.get(link.id);
    if (event.type === 'FRAME_SENT' && event.frame) {
      activity.packet = {
        eventId: event.id,
        tone,
        expiresAt: activity.expiresAt,
        reverse: event.device === link.b.device,
        control: !!(
          event.frame?.bpdu ||
          event.frame?.eapol ||
          event.frame?.lacp ||
          event.frame?.wifi ||
          event.frame?.meshHello
        ),
        radioControl: !!(event.frame?.wifi || event.frame?.meshHello),
      };
    } else if (tone !== 'drop' && tone !== 'config') activity.packet = old?.packet;
    putBounded(next.links, link.id, activity, CANVAS_ACTIVITY_LIMITS.links);
  }
  return next;
}
