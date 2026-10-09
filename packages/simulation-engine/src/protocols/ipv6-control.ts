import type { SimulationEngine } from '../core/engine';
import type { Action, Device, Frame, NetworkInterface } from '../model';
import { ipv6ConfigSchema } from './ipv6-model';
import { linkLocal6, network6, sameSubnet6, slaacAddress6, solicitedNode6, unicast6 } from './ipv6-address';
import { frame6, learnNeighbor6, clearIpv6Port, refreshNud6 } from './ipv6-wire';
import { expireDhcp6Server, configureDhcp6Client } from './dhcp6';
import { expireDhcp6Relay } from './dhcp6-relay';
import { closeTcp } from './tcp';
import { interfaceOperational } from './layer3';
import { usable6 } from './ipv6-routing';

export function ipv6Config(p: NetworkInterface) {
  return {
    auto: p.ipv6?.auto ?? false,
    addresses:
      p.ipv6?.addresses.filter((a) => a.origin === 'static').map(({ ip, prefix }) => ({ ip, prefix })) ?? [],
    ...(p.ipv6?.ra ? { ra: structuredClone(p.ipv6.ra) } : {}),
    ...(p.ipv6?.aclIn ? { aclIn: structuredClone(p.ipv6.aclIn) } : {}),
    ...(p.ipv6?.aclOut ? { aclOut: structuredClone(p.ipv6.aclOut) } : {}),
  };
}
export function configureIpv6(e: SimulationEngine, d: Device, p: NetworkInterface, input: unknown) {
  if (input === undefined) {
    if (p.dhcp6Relay?.enabled) throw new Error('Desative o relay DHCPv6 antes de remover IPv6.');
    if (
      d.dhcp6Server?.pools.some((v) => v.port === p.id) ||
      d.interfaces.some((v) => v.dhcp6?.delegatePort === p.id)
    )
      throw new Error('Remova os pools/delegação DHCPv6 da interface primeiro.');
    if (d.routes6?.some((r) => r.port === p.id && !r.dhcp6Lease))
      throw new Error('Remova as rotas IPv6 da interface primeiro.');
    if (p.dhcp6) configureDhcp6Client(e, d, p, undefined);
    clearIpv6Port(e, d, p);
    delete p.ipv6;
    return;
  }
  const c = ipv6ConfigSchema.parse(input);
  if (p.channel || p.mtu < 1280 || (d.type === 'switch' && p.mode !== 'routed'))
    throw new Error('IPv6 exige MTU >= 1280 e interface L3 fora de membros LACP.');
  if (c.ra && d.type !== 'router' && d.type !== 'switch') throw new Error('RA exige roteador ou switch L3.');
  if (
    c.addresses.some((a) => !unicast6(a.ip) || linkLocal6(a.ip)) ||
    new Set(c.addresses.map((a) => a.ip)).size !== c.addresses.length
  )
    throw new Error('Configure endereços globais/ULA unicast únicos. Link-local é automático.');
  for (const a of c.addresses)
    if (
      d.interfaces.some(
        (other) =>
          other.id !== p.id && other.vrf === p.vrf && other.ipv6?.addresses.some((v) => v.ip === a.ip)
      )
    )
      throw new Error('IPv6 duplicado na mesma VRF do equipamento.');
  if (
    c.ra?.prefixes.some(
      (a) => network6(a.network, a.prefix) !== a.network || !unicast6(a.network) || linkLocal6(a.network)
    )
  )
    throw new Error('Prefixo RA inválido.');
  for (const pool of d.dhcp6Server?.pools.filter((v) => v.port === p.id) ?? [])
    if (
      pool.addresses &&
      !pool.relayLink &&
      !c.addresses.some(
        (a) =>
          sameSubnet6(pool.addresses!.start, a.ip, a.prefix) &&
          sameSubnet6(pool.addresses!.end, a.ip, a.prefix)
      )
    )
      throw new Error('O novo endereço deve manter o intervalo DHCPv6 on-link.');
  clearIpv6Port(e, d, p);
  if (p.dhcp6Relay) p.dhcp6Relay.pending = [];
  p.ipv6 = {
    ...c,
    addresses: [
      {
        ip: slaacAddress6('fe80::', p.mac),
        prefix: 64,
        origin: 'link-local',
        state: 'tentative',
        onLink: true,
      },
      ...c.addresses.map((a) => ({
        ...a,
        origin: 'static' as const,
        state: 'tentative' as const,
        onLink: true,
      })),
    ],
    routers: [],
    token: e.id('ipv6'),
    tickAt: e.state.clock + 0.001,
    raAt: e.state.clock,
    rsAt: e.state.clock,
    rsAttempts: 0,
  };
  e.schedule(0.001, { kind: 'ipv6-tick', device: d.id, port: p.id, token: p.ipv6.token });
  e.emit('CONFIG_CHANGED', d.id, 'IPv6 configurado em ' + p.name + '; DAD pendente.', { port: p.id });
  if (p.dhcp6) {
    const { enabled, requestAddress, requestPrefix, rapidCommit, delegatePort } = p.dhcp6;
    configureDhcp6Client(e, d, p, { enabled, requestAddress, requestPrefix, rapidCommit, delegatePort });
  }
}
export function handleIpv6Tick(e: SimulationEngine, a: Extract<Action, { kind: 'ipv6-tick' }>) {
  const d = e.device(a.device),
    p = d.interfaces.find((p) => p.id === a.port),
    s = p?.ipv6;
  if (!p || !s || s.token !== a.token || s.tickAt !== e.state.clock) return;
  const up = interfaceOperational(e.state, d, p);
  expireDhcp6Server(e, d);
  expireDhcp6Relay(e, d);
  refreshNud6(e, d, p);
  const oldIps = new Set(s.addresses.map((a) => a.ip));
  s.addresses = s.addresses.filter((v) => v.validUntil === undefined || v.validUntil > e.state.clock);
  for (const c of d.tcpConnections ?? [])
    if (oldIps.has(c.localIp) && !s.addresses.some((a) => a.ip === c.localIp)) closeTcp(e, d, c.id, true);
  if (d.resolutions6?.some((r) => r.port === p.id && !s.addresses.some((v) => v.ip === r.source)))
    clearIpv6Port(e, d, p);
  s.routers = s.routers.filter((r) => r.expiresAt > e.state.clock);
  if (s.onLinkPrefixes) s.onLinkPrefixes = s.onLinkPrefixes.filter((r) => r.expiresAt > e.state.clock);
  for (const v of s.addresses) {
    if (v.state === 'preferred' && v.preferredUntil !== undefined && v.preferredUntil <= e.state.clock)
      v.state = 'deprecated';
    if (v.state !== 'tentative') continue;
    if (!up) {
      delete v.dadAt;
      continue;
    }
    if (v.dadAt === undefined) {
      v.dadAt = e.state.clock;
      frame6(e, d, p, {
        src: '::',
        dst: solicitedNode6(v.ip),
        hopLimit: 255,
        protocol: 'ICMPv6',
        kind: 'ns',
        target: v.ip,
        bytes: 64,
      });
    } else if (e.state.clock - v.dadAt >= 1000) {
      v.state =
        v.preferredUntil !== undefined && v.preferredUntil <= e.state.clock ? 'deprecated' : 'preferred';
      delete v.dadAt;
      e.emit('IPV6_ADDRESS', d.id, 'DAD concluído: ' + v.ip + '/' + v.prefix + '.', { port: p.id });
    }
  }
  const ll = usable6(p).find((v) => v.origin === 'link-local')?.ip;
  if (up && ll) {
    if (s.auto && !s.routers.length && s.rsAttempts < 3 && s.rsAt <= e.state.clock) {
      frame6(e, d, p, {
        src: ll,
        dst: 'ff02::2',
        hopLimit: 255,
        protocol: 'ICMPv6',
        kind: 'rs',
        mac: p.mac,
        bytes: 56,
      });
      s.rsAttempts++;
      s.rsAt = e.state.clock + 4000;
    }
    if (s.ra && d.ipv6Routing && s.raAt <= e.state.clock) advertise6(e, d, p);
  }
  s.tickAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'ipv6-tick', device: d.id, port: p.id, token: s.token });
}
function advertise6(e: SimulationEngine, d: Device, p: NetworkInterface) {
  const s = p.ipv6!,
    ll = usable6(p).find((a) => a.origin === 'link-local');
  if (!s.ra || !ll || !d.ipv6Routing) return;
  frame6(e, d, p, {
    src: ll.ip,
    dst: 'ff02::1',
    hopLimit: 255,
    protocol: 'ICMPv6',
    kind: 'ra',
    mac: p.mac,
    lifetimeMs: s.ra.lifetimeMs,
    prefixes: structuredClone(s.ra.prefixes),
    bytes: 64 + s.ra.prefixes.length * 32,
  });
  s.raAt = e.state.clock + s.ra.intervalMs;
}
export function receiveNdp(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame) {
  const packet = frame.ipv6!,
    s = p.ipv6!;
  if (!['ns', 'na', 'rs', 'ra'].includes(packet.kind)) return false;
  e.emit('NDP_RECEIVED', d.id, 'ICMPv6 ' + packet.kind.toUpperCase() + ' de ' + packet.src + '.', {
    port: p.id,
    frame,
  });
  if (packet.hopLimit !== 255 || (packet.mac && packet.mac !== frame.src) || frame.src === p.mac) {
    e.drop(d, 'NDP: Hop Limit/opção MAC inválidos.', p.id, frame);
    return true;
  }
  const own = s.addresses.find((a) => a.ip === packet.target);
  if (packet.kind === 'ns') {
    if (
      !own ||
      own.state === 'duplicate' ||
      ![own.ip, solicitedNode6(own.ip)].includes(packet.dst) ||
      !unicast6(own.ip)
    )
      return true;
    if (packet.src === '::' && (packet.mac || packet.dst !== solicitedNode6(own.ip))) return true;
    if (own.state === 'tentative') {
      own.state = 'duplicate';
      delete own.dadAt;
      e.emit('IPV6_ADDRESS', d.id, 'DAD: endereço duplicado ' + own.ip + '.', { port: p.id });
      return true;
    }
    if (packet.src !== '::' && packet.mac && unicast6(packet.src))
      learnNeighbor6(e, d, p, packet.src, frame.src);
    const dad = packet.src === '::';
    frame6(
      e,
      d,
      p,
      {
        src: own.ip,
        dst: dad ? 'ff02::1' : packet.src,
        hopLimit: 255,
        protocol: 'ICMPv6',
        kind: 'na',
        target: own.ip,
        mac: p.mac,
        solicited: !dad,
        override: true,
        router: d.ipv6Routing === true,
        bytes: 72,
      },
      dad ? undefined : frame.src
    );
  } else if (packet.kind === 'na') {
    if (!unicast6(packet.target!) || !unicast6(packet.src) || (packet.solicited && packet.dst === 'ff02::1'))
      return true;
    if (own?.state === 'tentative') {
      own.state = 'duplicate';
      delete own.dadAt;
      e.emit('IPV6_ADDRESS', d.id, 'DAD: endereço duplicado ' + own.ip + '.', { port: p.id });
    }
    const pending = d.resolutions6?.find(
      (r) => r.port === p.id && r.ip === packet.target && r.source === packet.dst
    );
    const known = d.neighbors6?.find((n) => n.port === p.id && n.ip === packet.target);
    if ((pending || known) && (packet.dst === 'ff02::1' || usable6(p).some((a) => a.ip === packet.dst)))
      learnNeighbor6(e, d, p, packet.target!, frame.src, !!packet.solicited, packet.override, packet.router);
  } else if (packet.kind === 'rs') {
    if (
      packet.dst !== 'ff02::2' ||
      (packet.src !== '::' && !linkLocal6(packet.src)) ||
      (packet.src === '::' && packet.mac)
    )
      return true;
    if (packet.src !== '::' && packet.mac) learnNeighbor6(e, d, p, packet.src, frame.src);
    advertise6(e, d, p);
  } else if (
    s.auto &&
    linkLocal6(packet.src) &&
    (packet.dst === 'ff02::1' || usable6(p).some((v) => v.ip === packet.dst))
  ) {
    if (packet.mac) learnNeighbor6(e, d, p, packet.src, frame.src);
    s.routers = s.routers.filter((r) => r.ip !== packet.src);
    if (packet.lifetimeMs! > 0 && s.routers.length < 8)
      s.routers.push({ ip: packet.src, expiresAt: e.state.clock + packet.lifetimeMs! });
    for (const prefix of packet.prefixes!) {
      if (
        prefix.onLink &&
        unicast6(prefix.network) &&
        !linkLocal6(prefix.network) &&
        network6(prefix.network, prefix.prefix) === prefix.network
      ) {
        s.onLinkPrefixes = (s.onLinkPrefixes ?? []).filter(
          (r) => r.network !== prefix.network || r.prefix !== prefix.prefix
        );
        if (prefix.validMs > 0 && s.onLinkPrefixes.length < 32)
          s.onLinkPrefixes.push({
            network: prefix.network,
            prefix: prefix.prefix,
            expiresAt: e.state.clock + prefix.validMs,
          });
      }
      if (
        !prefix.autonomous ||
        prefix.prefix !== 64 ||
        !unicast6(prefix.network) ||
        linkLocal6(prefix.network) ||
        network6(prefix.network, prefix.prefix) !== prefix.network
      )
        continue;
      const ip = slaacAddress6(prefix.network, p.mac),
        old = s.addresses.find((v) => v.ip === ip);
      // RFC 4862 protects an existing SLAAC lifetime against unauthenticated short advertisements.
      const valid =
        old?.validUntil === undefined ||
        prefix.validMs > 7200000 ||
        prefix.validMs > old.validUntil - e.state.clock
          ? prefix.validMs
          : Math.min(7200000, old.validUntil - e.state.clock);
      if (!old && prefix.validMs === 0) continue;
      if (old?.origin === 'slaac') {
        old.validUntil = e.state.clock + valid;
        old.preferredUntil = e.state.clock + prefix.preferredMs;
        old.onLink = prefix.onLink;
        if (old.state === 'deprecated' && prefix.preferredMs > 0) old.state = 'preferred';
      } else if (!old && s.addresses.length < 32)
        s.addresses.push({
          ip,
          prefix: 64,
          origin: 'slaac',
          state: 'tentative',
          onLink: prefix.onLink,
          validUntil: e.state.clock + prefix.validMs,
          preferredUntil: e.state.clock + prefix.preferredMs,
        });
    }
    e.emit('IPV6_ROUTE', d.id, 'RA: gateway ' + packet.src + ' e prefixos atualizados.', { port: p.id });
  }
  return true;
}
