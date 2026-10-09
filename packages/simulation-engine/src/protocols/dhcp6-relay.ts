import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Packet6, Snapshot } from '../model';
import { dhcp6RelayConfigSchema, type Dhcp6Message, type Dhcp6RelayMessage } from './dhcp6-model';
import { linkLocal6, unicast6, network6 } from './ipv6-address';
import { resolveRoute6, source6, usable6 } from './ipv6-routing';
import { sendDatagram6 } from './udp6';
export function configureDhcp6Relay(e: SimulationEngine, d: Device, p: NetworkInterface, input: unknown) {
  const c = dhcp6RelayConfigSchema.parse(input),
    before = p.dhcp6Relay;
  p.dhcp6Relay = { ...c, pending: [], leases: [], forwarded: 0, replied: 0 };
  try {
    validateDhcp6Relay(e.state);
  } catch (error) {
    p.dhcp6Relay = before;
    throw error;
  }
  d.routes6 = d.routes6?.filter(
    (route) => !before?.leases.some((lease) => lease.id === route.dhcp6RelayLease)
  );
  e.emit('CONFIG_CHANGED', d.id, 'Relay DHCPv6 configurado em ' + p.name + '.', { port: p.id });
}
export function validateDhcp6Relay(s: Snapshot) {
  for (const d of s.devices)
    for (const p of d.interfaces) {
      const r = p.dhcp6Relay;
      if (!r) continue;
      if (
        !['router', 'switch'].includes(d.type) ||
        !p.ipv6 ||
        p.mode !== 'routed' ||
        (r.enabled && !d.ipv6Routing) ||
        r.servers.some((ip) => !unicast6(ip) || linkLocal6(ip)) ||
        new Set(r.servers).size !== r.servers.length
      )
        throw new Error('Relay DHCPv6 exige roteamento IPv6, interface L3 e servidores globais/ULA únicos.');
      if (
        r.pending.some(
          (entry) =>
            entry.hops[0].interfaceId !== p.id ||
            !p.ipv6!.addresses.some((a) => a.ip === entry.hops[0].linkAddress)
        )
      )
        throw new Error('Relay DHCPv6: requisição pendente sem interface de origem.');
      if (
        new Set(r.leases.map((l) => l.id)).size !== r.leases.length ||
        r.leases.some(
          (l) =>
            !unicast6(l.network) ||
            linkLocal6(l.network) ||
            network6(l.network, l.prefix) !== l.network ||
            !unicast6(l.nextHop)
        )
      )
        throw new Error('Relay DHCPv6: delegação inválida.');
    }
}
export function expireDhcp6Relay(e: SimulationEngine, d: Device) {
  for (const p of d.interfaces) {
    const r = p.dhcp6Relay;
    if (!r) continue;
    const old = r.leases.filter((l) => l.expiresAt <= e.state.clock);
    r.leases = r.leases.filter((l) => l.expiresAt > e.state.clock);
    r.pending = r.pending.filter((l) => l.expiresAt > e.state.clock);
    d.routes6 = d.routes6?.filter((route) => !old.some((l) => l.id === route.dhcp6RelayLease));
  }
}
export function forwardDhcp6(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  packet: Extract<Packet6, { protocol: 'UDP' }>,
  message: Dhcp6Message,
  inner?: Dhcp6RelayMessage
) {
  const r = p.dhcp6Relay;
  if (!r?.enabled) return false;
  if (
    packet.datagram.destinationPort !== 547 ||
    packet.datagram.sourcePort !== (inner ? 547 : 546) ||
    !unicast6(packet.src) ||
    ['ADVERTISE', 'REPLY'].includes(message.type) ||
    (inner && inner.hops.length >= 8)
  ) {
    e.drop(d, 'Relay DHCPv6: origem, porta ou limite de hops inválido.', p.id);
    return true;
  }
  const link = usable6(p).find((a) => !linkLocal6(a.ip))?.ip;
  if (!link) {
    e.drop(d, 'Relay DHCPv6: aguarde DAD de endereço global/ULA no enlace.', p.id);
    return true;
  }
  const hops = [
    {
      hopCount: inner ? inner.hops[0].hopCount + 1 : 0,
      linkAddress: link,
      peerAddress: packet.src,
      interfaceId: p.id,
    },
    ...(inner?.hops ?? []),
  ];
  r.pending = r.pending.filter(
    (entry) =>
      entry.expiresAt > e.state.clock &&
      !(
        entry.clientId === message.clientId &&
        entry.iaid === message.iaid &&
        entry.transactionId === message.transactionId &&
        entry.peerAddress === packet.src
      )
  );
  if (r.pending.length >= 128) {
    e.drop(d, 'Relay DHCPv6: limite de correlações pendentes.', p.id);
    return true;
  }
  r.pending.push({
    transactionId: message.transactionId,
    clientId: message.clientId,
    iaid: message.iaid,
    peerAddress: packet.src,
    expiresAt: e.state.clock + 30000,
    hops,
  });
  for (const server of r.servers) {
    const route = resolveRoute6(d, server, e.state.clock, p.vrf),
      src = route && source6(route.port, server);
    if (!route || !src) {
      e.drop(d, 'Relay DHCPv6: sem rota para ' + server, p.id);
      continue;
    }
    sendDatagram6(e, d, route.port, src, server, {
      sourcePort: 547,
      destinationPort: 547,
      payload: { protocol: 'DHCPv6-RELAY', relay: { type: 'RELAY-FORW', hops, message } },
    });
    r.forwarded++;
  }
  e.emit('DHCP_REQUEST', d.id, 'DHCPv6 RELAY-FORW; link ' + link + '; hops ' + hops.length + '.', {
    port: p.id,
  });
  return true;
}
export function replyDhcp6Relay(
  e: SimulationEngine,
  d: Device,
  ingress: NetworkInterface,
  packet: Extract<Packet6, { protocol: 'UDP' }>,
  relay: Dhcp6RelayMessage
) {
  const hop = relay.hops[0],
    p = d.interfaces.find((p) => p.id === hop.interfaceId && p.vrf === ingress.vrf),
    r = p?.dhcp6Relay;
  if (
    !p ||
    !r?.enabled ||
    packet.datagram.sourcePort !== 547 ||
    packet.datagram.destinationPort !== 547 ||
    !r.servers.includes(packet.src) ||
    !['ADVERTISE', 'REPLY'].includes(relay.message.type)
  )
    return;
  r.pending = r.pending.filter((entry) => entry.expiresAt > e.state.clock);
  const pending = r.pending.find(
    (entry) =>
      entry.transactionId === relay.message.transactionId &&
      entry.clientId === relay.message.clientId &&
      entry.iaid === relay.message.iaid &&
      JSON.stringify(entry.hops) === JSON.stringify(relay.hops)
  );
  if (!pending) {
    e.drop(d, 'Relay DHCPv6: resposta sem correlação ou interface adulterada.', ingress.id);
    return;
  }
  const nested = relay.hops.length > 1,
    src = usable6(p).find((a) => (nested ? !linkLocal6(a.ip) : linkLocal6(a.ip)))?.ip;
  if (!src) return;
  const m = relay.message;
  if (m.type === 'REPLY' && m.status === 'Success') {
    const old = r.leases.filter((l) => l.clientId === m.clientId && l.iaid === m.iaid);
    r.leases = r.leases.filter((l) => !old.includes(l));
    d.routes6 = d.routes6?.filter((route) => !old.some((l) => l.id === route.dhcp6RelayLease));
    if (
      m.delegatedPrefix &&
      m.prefixLength &&
      m.validMs &&
      r.leases.length < 128 &&
      (d.routes6?.length ?? 0) < 256 &&
      unicast6(m.delegatedPrefix) &&
      network6(m.delegatedPrefix, m.prefixLength) === m.delegatedPrefix
    ) {
      const lease = {
        id: old[0]?.id ?? e.id('relay-pd'),
        clientId: m.clientId,
        iaid: m.iaid,
        network: m.delegatedPrefix,
        prefix: m.prefixLength,
        nextHop: hop.peerAddress,
        expiresAt: e.state.clock + m.validMs,
      };
      r.leases.push(lease);
      (d.routes6 ??= []).push({
        network: lease.network,
        prefix: lease.prefix,
        nextHop: lease.nextHop,
        port: p.id,
        metric: 1,
        dhcp6RelayLease: lease.id,
        ...(p.vrf ? { vrf: p.vrf } : {}),
      });
    }
  }
  sendDatagram6(e, d, p, src, hop.peerAddress, {
    sourcePort: 547,
    destinationPort: nested ? 547 : 546,
    payload: nested
      ? { protocol: 'DHCPv6-RELAY', relay: { ...relay, hops: relay.hops.slice(1) } }
      : { protocol: 'DHCPv6', message: relay.message },
  });
  r.replied++;
  e.emit('DHCP_ACK', d.id, 'DHCPv6 RELAY-REPL encaminhado ao enlace de origem.', { port: p.id });
}
