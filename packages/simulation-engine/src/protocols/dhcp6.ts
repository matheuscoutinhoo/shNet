import type { SimulationEngine } from '../core/engine';
import type { Action, Device, NetworkInterface, Packet6, Snapshot } from '../model';
import {
  dhcp6ClientConfigSchema,
  dhcp6Duid,
  dhcp6ServerConfigSchema,
  type Dhcp6Message,
  type Dhcp6RelayMessage,
} from './dhcp6-model';
import { ipv6Number, ipv6String, linkLocal6, network6, sameSubnet6, unicast6 } from './ipv6-address';
import { interfaceOperational } from './layer3';
import { usable6 } from './ipv6-routing';
import { sendDatagram6 } from './udp6';
import { forwardDhcp6, replyDhcp6Relay, validateDhcp6Relay } from './dhcp6-relay';
import { source6 } from './ipv6-routing';

function poolsValid(d: Device, pools: NonNullable<Device['dhcp6Server']>['pools']) {
  if (new Set(pools.map((p) => p.name)).size !== pools.length) throw new Error('Pool DHCPv6 duplicado.');
  for (const pool of pools) {
    const p = d.interfaces.find((p) => p.id === pool.port);
    if (!p?.ipv6) throw new Error('Pool DHCPv6 exige interface IPv6.');
    if (
      pool.relayLink &&
      (!unicast6(pool.relayLink.network) ||
        linkLocal6(pool.relayLink.network) ||
        network6(pool.relayLink.network, pool.relayLink.prefix) !== pool.relayLink.network)
    )
      throw new Error('Prefixo do enlace remoto DHCPv6 inválido.');
    if (pool.addresses) {
      const { start, end } = pool.addresses,
        size = ipv6Number(end) - ipv6Number(start) + 1n;
      if (
        !unicast6(start) ||
        !unicast6(end) ||
        linkLocal6(start) ||
        size < 1n ||
        size > 256n ||
        !(pool.relayLink
          ? sameSubnet6(start, pool.relayLink.network, pool.relayLink.prefix) &&
            sameSubnet6(end, pool.relayLink.network, pool.relayLink.prefix)
          : p.ipv6.addresses.some(
              (a) =>
                a.origin !== 'link-local' &&
                sameSubnet6(start, a.ip, a.prefix) &&
                sameSubnet6(end, a.ip, a.prefix)
            ))
      )
        throw new Error('Pool DHCPv6: intervalo unicast on-link de até 256 endereços.');
    }
    const pd = pool.delegation;
    if (
      pd &&
      (!unicast6(pd.network) ||
        linkLocal6(pd.network) ||
        network6(pd.network, pd.prefix) !== pd.network ||
        pd.delegatedLength <= pd.prefix ||
        BigInt(pd.maxLeases) > 1n << BigInt(pd.delegatedLength - pd.prefix))
    )
      throw new Error('Pool de delegação DHCPv6 inválido.');
    if (pool.dns.some((ip) => !unicast6(ip) || linkLocal6(ip)))
      throw new Error('DNS DHCPv6 exige endereço global/ULA unicast.');
  }
}
function peersValid(peers: string[] | undefined) {
  if (peers?.some((ip) => !unicast6(ip) || linkLocal6(ip)) || new Set(peers).size !== (peers?.length ?? 0))
    throw new Error('Peers de relay DHCPv6 devem ser globais/ULA únicos.');
}
export function configureDhcp6Server(e: SimulationEngine, d: Device, input: unknown) {
  if (!['server', 'router', 'switch'].includes(d.type)) throw new Error('Servidor DHCPv6 incompatível.');
  const c = dhcp6ServerConfigSchema.parse(input);
  poolsValid(d, c.pools);
  peersValid(c.relayPeers);
  d.routes6 = d.routes6?.filter((r) => !r.dhcp6Lease);
  d.dhcp6Server = { ...c, duid: dhcp6Duid(d.interfaces[0].mac), leases: [], declined: [] };
  e.emit('CONFIG_CHANGED', d.id, 'Servidor DHCPv6 configurado; leases anteriores removidos.');
}
function removeLeaseAddress(d: Device, p: NetworkInterface) {
  const c = p.dhcp6;
  if (!c) return;
  if (p.ipv6) p.ipv6.addresses = p.ipv6.addresses.filter((a) => a.origin !== 'dhcp6');
  const downstream = d.interfaces.find((v) => v.id === c.delegatePort);
  if (downstream?.ipv6 && c.delegatedPrefix) {
    downstream.ipv6.addresses = downstream.ipv6.addresses.filter(
      (a) => a.origin !== 'delegated' || network6(a.ip, a.prefix) !== c.delegatedPrefix
    );
    if (downstream.ipv6.ra)
      downstream.ipv6.ra.prefixes = downstream.ipv6.ra.prefixes.filter(
        (r) => r.network !== c.delegatedPrefix
      );
  }
  delete c.address;
  delete c.delegatedPrefix;
  delete c.prefixLength;
  delete c.validUntil;
  delete c.preferredUntil;
  delete c.t1At;
  delete c.t2At;
  c.dns = [];
}
export function configureDhcp6Client(e: SimulationEngine, d: Device, p: NetworkInterface, input: unknown) {
  if (input === undefined) {
    if (p.dhcp6) releaseDhcp6(e, d, p);
    e.state.queue = e.state.queue.filter(
      ({ action: a }) => a.kind !== 'dhcp6-tick' || a.device !== d.id || a.port !== p.id
    );
    delete p.dhcp6;
    return;
  }
  const config = dhcp6ClientConfigSchema.parse(input),
    downstream = d.interfaces.find((v) => v.id === config.delegatePort);
  if (!p.ipv6) throw new Error('Habilite IPv6 antes do cliente DHCPv6.');
  if (
    config.delegatePort &&
    (!config.requestPrefix ||
      !d.ipv6Routing ||
      !downstream?.ipv6 ||
      downstream.id === p.id ||
      downstream.vrf !== p.vrf)
  )
    throw new Error('Delegação exige interface IPv6 distinta na mesma VRF e encaminhamento ligado.');
  if (config.requestPrefix && !['router', 'switch'].includes(d.type))
    throw new Error('Delegação exige roteador/switch L3.');
  removeLeaseAddress(d, p);
  e.state.queue = e.state.queue.filter(
    ({ action: a }) => a.kind !== 'dhcp6-tick' || a.device !== d.id || a.port !== p.id
  );
  const iaid = Number.parseInt(p.mac.replaceAll(':', '').slice(-8), 16);
  p.dhcp6 = {
    ...config,
    duid: dhcp6Duid(p.mac),
    iaid,
    token: e.id('dhcp6'),
    tickAt: e.state.clock + 0.001,
    transactionId: e.state.sequence % 0xffffff,
    attempts: 0,
    nextAt: e.state.clock,
    state: config.enabled ? 'INIT' : 'DISABLED',
    dns: [],
  };
  if (config.enabled) p.ipv6.auto = true;
  e.schedule(0.001, { kind: 'dhcp6-tick', device: d.id, port: p.id, token: p.dhcp6.token });
  e.emit('CONFIG_CHANGED', d.id, 'Cliente DHCPv6 ' + (config.enabled ? 'ativado' : 'desativado') + '.', {
    port: p.id,
  });
}
function message(p: NetworkInterface, type: Dhcp6Message['type']): Dhcp6Message {
  const c = p.dhcp6!;
  return {
    type,
    transactionId: c.transactionId,
    clientId: c.duid,
    iaid: c.iaid,
    requestAddress: c.requestAddress,
    requestPrefix: c.requestPrefix,
    ...(c.rapidCommit ? { rapidCommit: true } : {}),
    ...(c.serverId ? { serverId: c.serverId } : {}),
    ...(c.address ? { address: c.address } : {}),
    ...(c.delegatedPrefix ? { delegatedPrefix: c.delegatedPrefix, prefixLength: c.prefixLength } : {}),
  };
}
function sendClient(e: SimulationEngine, d: Device, p: NetworkInterface, type: Dhcp6Message['type']) {
  const c = p.dhcp6!,
    src = usable6(p).find((a) => a.origin === 'link-local')?.ip;
  if (!src) return;
  const multicast = ['SOLICIT', 'REBIND', 'INFORMATION-REQUEST'].includes(type),
    dst = multicast ? 'ff02::1:2' : c.serverIp;
  if (!dst) return;
  const m = message(p, type);
  if (multicast) delete m.serverId;
  sendDatagram6(e, d, p, src, dst, {
    sourcePort: 546,
    destinationPort: 547,
    payload: { protocol: 'DHCPv6', message: m },
  });
  e.emit('DHCP_REQUEST', d.id, 'DHCPv6 ' + type + ' (IAID ' + c.iaid + ').', { port: p.id });
}
export function releaseDhcp6(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const c = p.dhcp6;
  if (!c) throw new Error('Cliente DHCPv6 inexistente.');
  if (c.validUntil !== undefined) {
    c.transactionId = (c.transactionId + 1) % 0xffffff;
    sendClient(e, d, p, 'RELEASE');
  }
  removeLeaseAddress(d, p);
  c.state = 'DISABLED';
  c.enabled = false;
  e.emit('DHCP_RELEASE', d.id, 'Concessão DHCPv6 liberada.', { port: p.id });
}
export function expireDhcp6Server(e: SimulationEngine, d: Device) {
  const s = d.dhcp6Server;
  if (!s) return;
  const old = s.leases.length;
  s.leases = s.leases.filter((l) => l.expiresAt > e.state.clock);
  d.routes6 = d.routes6?.filter((r) => !r.dhcp6Lease || s.leases.some((l) => l.id === r.dhcp6Lease));
  s.declined = s.declined.filter((a) => a.until > e.state.clock);
  if (old !== s.leases.length) e.emit('DHCP_LEASE_EXPIRED', d.id, 'Concessões DHCPv6 expiradas removidas.');
}
function start(e: SimulationEngine, p: NetworkInterface, state: 'SOLICITING' | 'RENEWING' | 'REBINDING') {
  const c = p.dhcp6!;
  c.state = state;
  c.transactionId = (c.transactionId + 1) % 0xffffff;
  c.attempts = 0;
  c.nextAt = e.state.clock;
  if (state === 'SOLICITING') {
    delete c.serverId;
    delete c.serverIp;
  }
}
export function handleDhcp6Tick(e: SimulationEngine, a: Extract<Action, { kind: 'dhcp6-tick' }>) {
  const d = e.device(a.device),
    p = d.interfaces.find((p) => p.id === a.port),
    c = p?.dhcp6;
  if (!p || !c || c.token !== a.token || c.tickAt !== e.state.clock) return;
  if (c.enabled && interfaceOperational(e.state, d, p) && usable6(p).some((a) => a.origin === 'link-local')) {
    if (c.address && p.ipv6?.addresses.some((a) => a.ip === c.address && a.state === 'duplicate')) {
      sendClient(e, d, p, 'DECLINE');
      removeLeaseAddress(d, p);
      start(e, p, 'SOLICITING');
    }
    if (c.validUntil !== undefined && c.validUntil <= e.state.clock) {
      removeLeaseAddress(d, p);
      start(e, p, 'SOLICITING');
      e.emit('DHCP_EXPIRED', d.id, 'DHCPv6: validade esgotada.', { port: p.id });
    }
    if (c.state === 'INIT') start(e, p, 'SOLICITING');
    if (c.state === 'BOUND' && c.t1At !== undefined && c.t1At <= e.state.clock) start(e, p, 'RENEWING');
    if (c.state === 'RENEWING' && c.t2At !== undefined && c.t2At <= e.state.clock) start(e, p, 'REBINDING');
    if (
      ['SOLICITING', 'REQUESTING', 'RENEWING', 'REBINDING'].includes(c.state) &&
      c.nextAt <= e.state.clock
    ) {
      if (c.attempts >= 6 && ['SOLICITING', 'REQUESTING'].includes(c.state)) {
        c.state = 'FAILED';
        removeLeaseAddress(d, p);
        e.emit('DHCP_FAILED', d.id, 'DHCPv6 sem resposta após seis tentativas.', { port: p.id });
      } else {
        const type =
          c.state === 'SOLICITING'
            ? 'SOLICIT'
            : c.state === 'REQUESTING'
              ? 'REQUEST'
              : c.state === 'RENEWING'
                ? 'RENEW'
                : 'REBIND';
        c.attempts = Math.min(8, c.attempts + 1);
        c.nextAt = e.state.clock + Math.min(16000, 1000 * 2 ** (c.attempts - 1));
        sendClient(e, d, p, type);
      }
    }
  } else if (c.enabled && c.validUntil !== undefined && c.validUntil <= e.state.clock) {
    removeLeaseAddress(d, p);
    c.state = 'INIT';
  }
  c.tickAt = e.state.clock + 1000;
  e.schedule(1000, { ...a, token: c.token });
}
function receiveServer(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  packet: Extract<Packet6, { protocol: 'UDP' }>,
  m: Dhcp6Message,
  relay?: Dhcp6RelayMessage
) {
  const s = d.dhcp6Server;
  if (
    !s?.enabled ||
    packet.datagram.sourcePort !== (relay ? 547 : 546) ||
    packet.datagram.destinationPort !== 547 ||
    (!relay && !linkLocal6(packet.src)) ||
    !unicast6(packet.src) ||
    (m.serverId && m.serverId !== s.duid) ||
    (relay && !s.relayPeers?.includes(packet.src))
  )
    return;
  const remote = relay?.hops.at(-1)?.linkAddress;
  const pool = s.pools
    .filter(
      (v) =>
        v.port === p.id &&
        (remote
          ? !!v.relayLink && sameSubnet6(remote, v.relayLink.network, v.relayLink.prefix)
          : !v.relayLink)
    )
    .sort((a, b) => (b.relayLink?.prefix ?? 0) - (a.relayLink?.prefix ?? 0))[0];
  if (!pool) return;
  expireDhcp6Server(e, d);
  let lease = s.leases.find(
    (l) => l.port === p.id && l.pool === pool.name && l.clientId === m.clientId && l.iaid === m.iaid
  );
  let status: Dhcp6Message['status'] = 'Success';
  const requireServer = ['REQUEST', 'RENEW', 'RELEASE', 'DECLINE'].includes(m.type);
  if (requireServer && m.serverId !== s.duid) return;
  if (m.type === 'RELEASE' || m.type === 'DECLINE') {
    if (!lease) status = 'NoBinding';
    else {
      if (m.type === 'DECLINE' && m.address === lease.address && lease.address) {
        s.declined.push({ address: lease.address, until: e.state.clock + 600000 });
        if (s.declined.length > 256) s.declined.shift();
      }
      s.leases = s.leases.filter((l) => l !== lease);
      d.routes6 = d.routes6?.filter((r) => r.dhcp6Lease !== lease!.id);
      lease = undefined;
    }
  } else if (m.type === 'RENEW' && !lease) status = 'NoBinding';
  else if (!['SOLICIT', 'REQUEST', 'RENEW', 'REBIND', 'INFORMATION-REQUEST'].includes(m.type)) return;
  else if (m.type !== 'INFORMATION-REQUEST') {
    if (!lease) {
      let address: string | undefined, delegatedPrefix: string | undefined;
      if (m.requestAddress && pool.addresses) {
        for (let n = ipv6Number(pool.addresses.start); n <= ipv6Number(pool.addresses.end); n++) {
          const candidate = ipv6String(n);
          if (
            !s.leases.some((l) => l.address === candidate) &&
            !s.declined.some((v) => v.address === candidate) &&
            !d.interfaces.some((v) => v.ipv6?.addresses.some((a) => a.ip === candidate))
          ) {
            address = candidate;
            break;
          }
        }
      }
      if (m.requestPrefix && pool.delegation) {
        const pd = pool.delegation;
        for (let i = 0; i < pd.maxLeases; i++) {
          const candidate = ipv6String(
            ipv6Number(pd.network) + (BigInt(i) << BigInt(128 - pd.delegatedLength))
          );
          if (!s.leases.some((l) => l.delegatedPrefix === candidate)) {
            delegatedPrefix = candidate;
            break;
          }
        }
      }
      if (m.requestAddress && !address) status = 'NoAddrsAvail';
      else if (m.requestPrefix && !delegatedPrefix) status = 'NoPrefixAvail';
      else if (s.leases.length >= 256) status = 'NoAddrsAvail';
      else {
        lease = {
          id: e.id('dhcp6-lease'),
          pool: pool.name,
          port: p.id,
          clientId: m.clientId,
          iaid: m.iaid,
          ...(address ? { address } : {}),
          ...(delegatedPrefix ? { delegatedPrefix, prefixLength: pool.delegation!.delegatedLength } : {}),
          state: 'offered',
          expiresAt: e.state.clock + 30000,
        };
        s.leases.push(lease);
      }
    }
    if (
      lease &&
      m.type === 'REQUEST' &&
      ((m.address && m.address !== lease.address) ||
        (m.delegatedPrefix && m.delegatedPrefix !== lease.delegatedPrefix))
    ) {
      status = 'NotOnLink';
      lease = undefined;
    }
  }
  const commit = m.type !== 'SOLICIT' || !!(m.rapidCommit && s.rapidCommit),
    type: Dhcp6Message['type'] = m.type === 'SOLICIT' && !commit ? 'ADVERTISE' : 'REPLY';
  if (lease && status === 'Success' && commit) {
    lease.state = 'bound';
    lease.expiresAt = e.state.clock + pool.validMs;
    lease.clientIp = packet.src;
    if (lease.delegatedPrefix) {
      const others = d.routes6?.filter((r) => r.dhcp6Lease !== lease!.id) ?? [];
      if (others.length >= 256) {
        status = 'NoPrefixAvail';
        s.leases = s.leases.filter((l) => l !== lease);
        lease = undefined;
      } else
        d.routes6 = [
          ...others,
          {
            network: lease.delegatedPrefix,
            prefix: lease.prefixLength!,
            nextHop: packet.src,
            port: p.id,
            metric: 1,
            dhcp6Lease: lease.id,
            ...(p.vrf ? { vrf: p.vrf } : {}),
          },
        ];
    }
  }
  const src = relay ? source6(p, packet.src) : usable6(p).find((a) => a.origin === 'link-local')?.ip;
  if (!src) return;
  const response: Dhcp6Message = {
    ...m,
    type,
    serverId: s.duid,
    status,
    dns: pool.dns,
    ...(lease && status === 'Success'
      ? {
          address: lease.address,
          delegatedPrefix: lease.delegatedPrefix,
          prefixLength: lease.prefixLength,
          preferredMs: pool.preferredMs,
          validMs: pool.validMs,
          t1Ms: pool.t1Ms,
          t2Ms: pool.t2Ms,
        }
      : {}),
    ...(m.type === 'SOLICIT' && commit ? { rapidCommit: true } : {}),
  };
  sendDatagram6(e, d, p, src, packet.src, {
    sourcePort: 547,
    destinationPort: relay ? 547 : 546,
    payload: relay
      ? { protocol: 'DHCPv6-RELAY', relay: { ...relay, type: 'RELAY-REPL', message: response } }
      : { protocol: 'DHCPv6', message: response },
  });
  e.emit(type === 'ADVERTISE' ? 'DHCP_OFFER' : 'DHCP_ACK', d.id, 'DHCPv6 ' + type + ': ' + status + '.', {
    port: p.id,
  });
}
function bind(e: SimulationEngine, d: Device, p: NetworkInterface, m: Dhcp6Message, serverIp: string) {
  const c = p.dhcp6!,
    v = p.ipv6!;
  if (
    !m.serverId ||
    !m.validMs ||
    !m.preferredMs ||
    !m.t1Ms ||
    !m.t2Ms ||
    m.t1Ms >= m.t2Ms ||
    m.t2Ms >= m.validMs ||
    m.preferredMs > m.validMs ||
    (c.requestAddress && (!m.address || !unicast6(m.address) || linkLocal6(m.address))) ||
    (c.requestPrefix &&
      (!m.delegatedPrefix ||
        !m.prefixLength ||
        network6(m.delegatedPrefix, m.prefixLength) !== m.delegatedPrefix))
  )
    return;
  const same = c.address === m.address,
    old = v.addresses.find((a) => a.origin === 'dhcp6' && a.ip === m.address);
  const oldDownstream = d.interfaces
    .find((v) => v.id === c.delegatePort)
    ?.ipv6?.addresses.find(
      (a) =>
        a.origin === 'delegated' &&
        c.delegatedPrefix === m.delegatedPrefix &&
        network6(a.ip, a.prefix) === m.delegatedPrefix
    );
  removeLeaseAddress(d, p);
  c.serverId = m.serverId;
  c.serverIp = serverIp;
  c.address = m.address;
  c.delegatedPrefix = m.delegatedPrefix;
  c.prefixLength = m.prefixLength;
  c.validUntil = e.state.clock + m.validMs;
  c.preferredUntil = e.state.clock + m.preferredMs;
  c.t1At = e.state.clock + m.t1Ms;
  c.t2At = e.state.clock + m.t2Ms;
  c.dns = m.dns ?? [];
  c.state = 'BOUND';
  c.attempts = 0;
  if (m.address)
    v.addresses.push({
      ip: m.address,
      prefix: 128,
      origin: 'dhcp6',
      onLink: false,
      state: same && old ? old.state : 'tentative',
      ...(same && old?.dadAt !== undefined ? { dadAt: old.dadAt } : {}),
      validUntil: c.validUntil,
      preferredUntil: c.preferredUntil,
    });
  const downstream = d.interfaces.find((v) => v.id === c.delegatePort);
  if (downstream?.ipv6 && m.delegatedPrefix && m.prefixLength) {
    const ip = ipv6String(ipv6Number(m.delegatedPrefix) + 1n);
    downstream.ipv6.addresses.push({
      ip,
      prefix: m.prefixLength,
      origin: 'delegated',
      onLink: true,
      state: oldDownstream?.state ?? 'tentative',
      ...(oldDownstream?.dadAt !== undefined ? { dadAt: oldDownstream.dadAt } : {}),
      validUntil: c.validUntil,
      preferredUntil: c.preferredUntil,
    });
    downstream.ipv6.ra ??= { intervalMs: 3000, lifetimeMs: 9000, prefixes: [] };
    if (downstream.ipv6.ra.prefixes.length < 8)
      downstream.ipv6.ra.prefixes.push({
        network: m.delegatedPrefix,
        prefix: m.prefixLength,
        onLink: true,
        autonomous: m.prefixLength === 64,
        validMs: m.validMs,
        preferredMs: m.preferredMs,
      });
  }
  e.emit(
    'DHCP_BOUND',
    d.id,
    'DHCPv6 BOUND: ' +
      (m.address ?? '') +
      (m.delegatedPrefix ? ' prefixo ' + m.delegatedPrefix + '/' + m.prefixLength : ''),
    { port: p.id }
  );
}
export function receiveDhcp6(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  packet: Extract<Packet6, { protocol: 'UDP' }>
) {
  const payload = packet.datagram.payload;
  if (payload.protocol === 'DHCPv6-RELAY') {
    const relay = payload.relay;
    if (relay.type === 'RELAY-REPL') replyDhcp6Relay(e, d, p, packet, relay);
    else if (!forwardDhcp6(e, d, p, packet, relay.message, relay))
      receiveServer(e, d, p, packet, relay.message, relay);
    return;
  }
  if (payload.protocol !== 'DHCPv6') return;
  const m = payload.message;
  if (packet.datagram.destinationPort === 547) {
    if (forwardDhcp6(e, d, p, packet, m)) return;
    receiveServer(e, d, p, packet, m);
    return;
  }
  const c = p.dhcp6;
  if (
    !c?.enabled ||
    packet.datagram.destinationPort !== 546 ||
    packet.datagram.sourcePort !== 547 ||
    !linkLocal6(packet.src) ||
    m.clientId !== c.duid ||
    m.iaid !== c.iaid ||
    m.transactionId !== c.transactionId ||
    !m.serverId ||
    (['REQUESTING', 'RENEWING'].includes(c.state) && (m.serverId !== c.serverId || packet.src !== c.serverIp))
  )
    return;
  if (m.type === 'ADVERTISE' && c.state === 'SOLICITING' && m.status === 'Success') {
    c.serverId = m.serverId;
    c.serverIp = packet.src;
    c.address = m.address;
    c.delegatedPrefix = m.delegatedPrefix;
    c.prefixLength = m.prefixLength;
    c.state = 'REQUESTING';
    c.attempts = 0;
    c.nextAt = e.state.clock;
    sendClient(e, d, p, 'REQUEST');
    c.attempts = 1;
    c.nextAt = e.state.clock + 1000;
  } else if (m.type === 'REPLY' && ['REQUESTING', 'RENEWING', 'REBINDING', 'SOLICITING'].includes(c.state)) {
    if (c.state === 'SOLICITING' && (!c.rapidCommit || !m.rapidCommit)) return;
    if (m.status !== 'Success') {
      removeLeaseAddress(d, p);
      start(e, p, 'SOLICITING');
      return;
    }
    bind(e, d, p, m, packet.src);
  }
}
export function validateDhcp6(s: Snapshot) {
  validateDhcp6Relay(s);
  const used = new Set<Action>();
  for (const d of s.devices) {
    if (d.dhcp6Server) {
      const server = d.dhcp6Server;
      poolsValid(d, server.pools);
      peersValid(server.relayPeers);
      if (
        !['router', 'switch', 'server'].includes(d.type) ||
        new Set(server.leases.map((l) => l.id)).size !== server.leases.length
      )
        throw new Error('Servidor/lease DHCPv6 inválido.');
      const addresses = new Set<string>(),
        prefixes = new Set<string>(),
        clients = new Set<string>();
      for (const l of server.leases) {
        const pool = server.pools.find((p) => p.name === l.pool && p.port === l.port),
          key = l.pool + '/' + l.port + '/' + l.clientId + '/' + l.iaid;
        if (
          !pool ||
          clients.has(key) ||
          (!l.address && !l.delegatedPrefix) ||
          (l.address &&
            (!pool.addresses ||
              addresses.has(l.address) ||
              ipv6Number(l.address) < ipv6Number(pool.addresses.start) ||
              ipv6Number(l.address) > ipv6Number(pool.addresses.end))) ||
          (l.delegatedPrefix &&
            (!pool.delegation ||
              prefixes.has(l.delegatedPrefix) ||
              l.prefixLength !== pool.delegation.delegatedLength ||
              !sameSubnet6(l.delegatedPrefix, pool.delegation.network, pool.delegation.prefix)))
        )
          throw new Error('Concessão DHCPv6 inconsistente.');
        clients.add(key);
        if (l.address) addresses.add(l.address);
        if (l.delegatedPrefix) prefixes.add(l.delegatedPrefix);
      }
    }
    for (const p of d.interfaces) {
      const c = p.dhcp6;
      if (!c) continue;
      const q = s.queue.filter(
        ({ action: a }) => a.kind === 'dhcp6-tick' && a.device === d.id && a.port === p.id
      );
      if (
        !p.ipv6 ||
        q.length !== 1 ||
        q[0].at !== c.tickAt ||
        q[0].action.kind !== 'dhcp6-tick' ||
        q[0].action.token !== c.token ||
        c.tickAt < s.clock ||
        (c.delegatePort && !d.interfaces.some((v) => v.id === c.delegatePort && v.ipv6 && v.vrf === p.vrf))
      )
        throw new Error('Cliente/timer DHCPv6 inconsistente.');
      if (
        c.state === 'BOUND' &&
        (!c.serverId ||
          !c.serverIp ||
          c.validUntil === undefined ||
          c.t1At === undefined ||
          c.t2At === undefined ||
          c.t1At >= c.t2At ||
          c.t2At >= c.validUntil)
      )
        throw new Error('Concessão/timers DHCPv6 do cliente inválidos.');
      used.add(q[0].action);
    }
  }
  for (const q of s.queue)
    if (q.action.kind === 'dhcp6-tick' && !used.has(q.action)) throw new Error('Timer DHCPv6 órfão.');
}
