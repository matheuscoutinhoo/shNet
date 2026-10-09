import type { Action, Snapshot } from '../model';
import { linkLocal6, multicast6, network6, slaacAddress6, unicast6 } from './ipv6-address';
import { requireVrf } from './layer3';
export function validateIpv6(s: Snapshot) {
  const used = new Set<Action>();
  for (const d of s.devices) {
    if (d.ipv6Routing && !['router', 'switch'].includes(d.type))
      throw new Error('Encaminhamento IPv6 exige roteador/switch L3.');
    for (const p of d.interfaces) {
      const v = p.ipv6;
      if (!v) continue;
      if (
        p.channel ||
        p.mtu < 1280 ||
        (d.type === 'switch' && p.mode !== 'routed') ||
        (v.ra && !['router', 'switch'].includes(d.type))
      )
        throw new Error('Interface IPv6 incompatível.');
      const timers = s.queue.filter(
        (q) => q.action.kind === 'ipv6-tick' && q.action.device === d.id && q.action.port === p.id
      );
      if (
        timers.length !== 1 ||
        timers[0].at !== v.tickAt ||
        v.tickAt < s.clock ||
        (timers[0].action as Extract<Action, { kind: 'ipv6-tick' }>).token !== v.token
      )
        throw new Error('Timer IPv6 inconsistente.');
      used.add(timers[0].action);
      if (
        new Set(v.addresses.map((a) => a.ip)).size !== v.addresses.length ||
        v.addresses.filter((a) => a.origin === 'link-local').length !== 1
      )
        throw new Error('Endereços IPv6 duplicados ou link-local ausente.');
      for (const a of v.addresses) {
        if (
          !unicast6(a.ip) ||
          (a.origin === 'link-local'
            ? a.ip !== slaacAddress6('fe80::', p.mac) || a.prefix !== 64
            : linkLocal6(a.ip)) ||
          (a.dadAt !== undefined && (a.state !== 'tentative' || a.dadAt > s.clock)) ||
          (a.origin === 'slaac' &&
            (a.prefix !== 64 ||
              !v.auto ||
              a.validUntil === undefined ||
              a.preferredUntil === undefined ||
              a.preferredUntil > a.validUntil)) ||
          (['link-local', 'static'].includes(a.origin) &&
            (a.validUntil !== undefined || a.preferredUntil !== undefined)) ||
          (['dhcp6', 'delegated'].includes(a.origin) &&
            (a.validUntil === undefined || a.preferredUntil === undefined || a.preferredUntil > a.validUntil))
        )
          throw new Error('Estado IPv6/DAD/SLAAC inválido.');
      }
      if (
        new Set(v.routers.map((r) => r.ip)).size !== v.routers.length ||
        v.routers.some((r) => !linkLocal6(r.ip)) ||
        (v.routers.length && !v.auto)
      )
        throw new Error('Gateway RA inválido.');
      if (
        v.onLinkPrefixes?.some(
          (r) => network6(r.network, r.prefix) !== r.network || !unicast6(r.network) || linkLocal6(r.network)
        )
      )
        throw new Error('Prefixo IPv6 on-link inválido.');
      if (
        v.ra?.prefixes.some(
          (r) => network6(r.network, r.prefix) !== r.network || !unicast6(r.network) || linkLocal6(r.network)
        )
      )
        throw new Error('Prefixo RA inválido.');
    }
    const neighborKeys = new Set<string>();
    for (const n of d.neighbors6 ?? []) {
      const key = n.port + '/' + n.ip;
      if (!d.interfaces.some((p) => p.id === n.port && p.ipv6) || !unicast6(n.ip) || neighborKeys.has(key))
        throw new Error('Vizinho NDP inválido.');
      neighborKeys.add(key);
      if (['DELAY', 'PROBE'].includes(n.state ?? '') && n.probeAt === undefined)
        throw new Error('Vizinho NDP sem prazo de confirmação.');
    }
    const keys = new Set<string>();
    for (const r of d.resolutions6 ?? []) {
      const key = r.port + '/' + r.ip,
        p = d.interfaces.find((p) => p.id === r.port);
      const timers = s.queue.filter(
        (q) =>
          q.action.kind === 'ndp-timer' &&
          q.action.device === d.id &&
          q.action.port === r.port &&
          q.action.ip === r.ip
      );
      if (
        keys.has(key) ||
        !p?.ipv6 ||
        !unicast6(r.ip) ||
        !p.ipv6.addresses.some((a) => a.ip === r.source) ||
        !d.pending6?.some((n) => n.port === r.port && n.nextHop === r.ip) ||
        timers.length !== 1 ||
        timers[0].at !== r.nextAt ||
        r.nextAt < s.clock ||
        (timers[0].action as Extract<Action, { kind: 'ndp-timer' }>).token !== r.token
      )
        throw new Error('Resolução NDP/timer inválidos.');
      keys.add(key);
      used.add(timers[0].action);
    }
    for (const n of d.pending6 ?? [])
      if (!keys.has(n.port + '/' + n.nextHop)) throw new Error('Pacote IPv6 pendente sem resolução NDP.');
    const routes = new Set<string>();
    for (const r of d.routes6 ?? []) {
      requireVrf(d, r.vrf);
      const p = d.interfaces.find((p) => p.id === r.port);
      const key = JSON.stringify([r.network, r.prefix, r.port, r.vrf]);
      if (
        (r.dhcp6RelayLease &&
          !p?.dhcp6Relay?.leases.some(
            (l) =>
              l.id === r.dhcp6RelayLease &&
              l.network === r.network &&
              l.prefix === r.prefix &&
              l.nextHop === r.nextHop
          )) ||
        (r.dhcp6Lease &&
          !d.dhcp6Server?.leases.some(
            (l) =>
              l.id === r.dhcp6Lease &&
              l.state === 'bound' &&
              l.port === r.port &&
              l.delegatedPrefix === r.network &&
              l.prefixLength === r.prefix &&
              l.clientIp === r.nextHop
          )) ||
        !p?.ipv6 ||
        p.vrf !== r.vrf ||
        routes.has(key) ||
        network6(r.network, r.prefix) !== r.network ||
        multicast6(r.network) ||
        (r.nextHop !== '::' && !unicast6(r.nextHop))
      )
        throw new Error('Rota IPv6 inválida.');
      routes.add(key);
    }
  }
  const ids = new Set<string>();
  for (const p of s.probes6 ?? []) {
    const d = s.devices.find((d) => d.id === p.device);
    if (
      !d ||
      ids.has(p.id) ||
      !d.interfaces.some((v) => v.id === p.port) ||
      p.start > s.clock ||
      !unicast6(p.target)
    )
      throw new Error('Probe IPv6 inválido.');
    requireVrf(d, p.vrf);
    ids.add(p.id);
    const timers = s.queue.filter((q) => q.action.kind === 'probe6-timeout' && q.action.probeId === p.id);
    if (
      (p.status === 'pending' && timers.length !== 1) ||
      timers.length > 1 ||
      timers.some(
        (q) =>
          q.at !== p.start + 30000 ||
          (q.action as Extract<Action, { kind: 'probe6-timeout' }>).device !== p.device
      )
    )
      throw new Error('Timer de probe IPv6 inválido.');
    for (const timer of timers) used.add(timer.action);
  }
  for (const q of s.queue)
    if (['ipv6-tick', 'ndp-timer', 'probe6-timeout'].includes(q.action.kind) && !used.has(q.action))
      throw new Error('Timer IPv6 órfão.');
}
