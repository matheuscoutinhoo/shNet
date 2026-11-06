import type { SimulationEngine } from '../core/engine';
import type { Action, Device, UdpPacket, Snapshot } from '../model';
import { clockConfigSchema, ntpConfigSchema } from './telemetry-model';
import { resolveRoute } from './ipv4';
import { isUnicast } from './dhcp-config';
import { checkDevice, deviceTimers, validatedDevice } from '../core/validation-scope';
import { hmacHex } from './security-crypto';
import { sourceInterfaceAddress } from './source-interface';
export const networkTime = (e: SimulationEngine, d: Device) =>
  e.state.clock + (d.networkClock?.offsetMs ?? 0);
const NTP_BYTES = 76,
  NTP_AUTH_BYTES = 96;
const ntpServerOptions = (d: Device, server: string) =>
  d.iosSystem?.ntp?.serverOptions?.find((o) => o.address === server);
const ntpKey = (d: Device, id?: number) =>
  id === undefined ? undefined : d.iosSystem?.ntp?.keys?.find((k) => k.id === id)?.key;
/** MAC of an NTP packet (keyed digest over the exchange and the packet mode). */
const ntpMac = (key: string, mode: 'client' | 'server', id: string) =>
  hmacHex(key, mode + ':' + id).slice(0, 32);
export function configureClock(e: SimulationEngine, d: Device, input: unknown) {
  const c = clockConfigSchema.parse(input);
  d.networkClock = c;
  if (d.ntp) {
    d.ntp.synchronized = false;
    delete d.ntp.pending;
  }
  e.emit('CONFIG_CHANGED', d.id, 'Relógio de rede configurado; offset ' + c.offsetMs + ' ms.');
}
export function ntpConfig(d: Device) {
  if (!d.ntp) throw new Error('NTP ausente.');
  const { enabled, servers, intervalMs } = d.ntp;
  return { enabled, servers, intervalMs };
}
export function configureNtp(e: SimulationEngine, d: Device, input: unknown) {
  const c = ntpConfigSchema.parse(input);
  if (
    new Set(c.servers).size !== c.servers.length ||
    c.servers.some((ip) => !isUnicast(ip) || d.interfaces.some((p) => p.ip === ip))
  )
    throw new Error('Servidores NTP inválidos.');
  d.networkClock ??= { offsetMs: 0, server: false, stratum: 1 };
  e.state.queue = e.state.queue.filter((q) => q.action.kind !== 'ntp-tick' || q.action.device !== d.id);
  d.ntp = {
    ...c,
    token: e.id('ntp'),
    tickAt: e.state.clock + 0.001,
    index: 0,
    synchronized: false,
    stratum: 16,
    samples: [],
    failures: 0,
  };
  e.schedule(0.001, { kind: 'ntp-tick', device: d.id, token: d.ntp.token });
  e.emit('CONFIG_CHANGED', d.id, 'Cliente NTP configurado.');
}
export function handleNtp(e: SimulationEngine, a: Extract<Action, { kind: 'ntp-tick' }>) {
  const d = e.device(a.device),
    s = d.ntp;
  if (!s || s.token !== a.token || s.tickAt !== e.state.clock) return;
  if (s.pending && e.state.clock - s.pending.at >= 3000) {
    delete s.pending;
    s.failures++;
    s.synchronized = false;
    s.stratum = 16;
    s.index = (s.index + 1) % s.servers.length;
    e.emit('NTP_STATE', d.id, 'Servidor sem resposta; próximo peer NTP.');
  }
  // Like IOS, the client polls once per poll interval whether or not it is synchronized: a round
  // tries each configured server once (failing over on timeout), then waits for the next interval.
  const due = !s.synchronized || s.lastSync === undefined || e.state.clock - s.lastSync >= s.intervalMs;
  if (due && (s.roundAt === undefined || e.state.clock - s.roundAt >= s.intervalMs)) {
    s.roundAt = e.state.clock;
    s.roundTried = 0;
    // "ntp server X prefer": each round starts with the preferred server.
    const preferred = s.servers.indexOf(d.iosSystem?.ntp?.prefer ?? '');
    if (preferred >= 0 && !s.pending) s.index = preferred;
  }
  if (s.enabled && d.power && !s.pending && due && (s.roundTried ?? 0) < s.servers.length) {
    s.roundTried = (s.roundTried ?? 0) + 1;
    const server = s.servers[s.index],
      route = resolveRoute(d, server),
      options = ntpServerOptions(d, server),
      source =
        sourceInterfaceAddress(e.state, d, options?.source ?? d.iosSystem?.ntp?.sourceInterface) ??
        route?.port.ip;
    if (route && source) {
      let port = 52000;
      while (
        d.aaaQueries?.some((q) => q.status === 'pending' && q.sourcePort === port) ||
        d.dnsQueries?.some((q) => q.status === 'pending' && q.sourcePort === port) ||
        d.snmpQueries?.some((q) => q.status === 'pending' && q.sourcePort === port)
      )
        port++;
      s.pending = {
        id: e.id('ntp-request'),
        server,
        source,
        port,
        originate: networkTime(e, d),
        at: e.state.clock,
      };
      const key = ntpKey(d, options?.key);
      e.sendIp(d.id, {
        protocol: 'UDP',
        src: source,
        dst: server,
        sourcePort: port,
        destinationPort: 123,
        ttl: 64,
        // 48-byte NTP header, plus key ID and 16-byte digest when authenticated.
        bytes: key ? NTP_AUTH_BYTES : NTP_BYTES,
        payload: {
          protocol: 'NTP',
          message: {
            mode: 'client',
            id: s.pending.id,
            originate: s.pending.originate,
            ...(key ? { keyId: options!.key, mac: ntpMac(key, 'client', s.pending.id) } : {}),
          },
        },
      });
      e.emit('NTP_SENT', d.id, 'Consulta NTP a ' + server + '; timestamp marcado na transmissão.');
    } else {
      s.failures++;
      s.synchronized = false;
      s.index = (s.index + 1) % s.servers.length;
      e.drop(d, 'NTP: sem rota/IPv4 para o peer.');
    }
  }
  s.tickAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'ntp-tick', device: d.id, token: s.token });
}
export function receiveNtp(e: SimulationEngine, d: Device, p: UdpPacket) {
  if (p.payload.protocol !== 'NTP' || !isUnicast(p.src) || !isUnicast(p.dst) || !p.ttl) return;
  const m = p.payload.message;
  if (p.bytes !== (m.mac ? NTP_AUTH_BYTES : NTP_BYTES)) return;
  if (m.mode === 'client') {
    // IOS answers NTP clients once it is synchronized itself, or as "ntp master" when it has no
    // synchronized upstream (the master clock is the fallback reference).
    const synced = !!d.ntp?.enabled && d.ntp.synchronized,
      master = !!d.networkClock?.server;
    if (p.destinationPort !== 123 || (!synced && !master)) {
      e.drop(d, 'NTP: servidor indisponível/não sincronizado.');
      return;
    }
    const stratum = synced ? d.ntp!.stratum : d.networkClock!.stratum;
    if (stratum > 15) return;
    const now = networkTime(e, d),
      // A request MAC that verifies with the same key ID is answered with an authenticated reply.
      key = ntpKey(d, m.keyId),
      authentic = !!key && m.mac === ntpMac(key, 'client', m.id);
    e.sendIp(d.id, {
      protocol: 'UDP',
      src: p.dst,
      dst: p.src,
      sourcePort: 123,
      destinationPort: p.sourcePort,
      ttl: 64,
      bytes: authentic ? NTP_AUTH_BYTES : NTP_BYTES,
      payload: {
        protocol: 'NTP',
        message: {
          mode: 'server',
          id: m.id,
          originate: m.originate,
          receive: now,
          transmit: now,
          stratum,
          ...(authentic ? { keyId: m.keyId, mac: ntpMac(key, 'server', m.id) } : {}),
        },
      },
    });
    return;
  }
  const s = d.ntp,
    q = s?.pending;
  if (
    !s?.enabled ||
    !q ||
    q.id !== m.id ||
    q.server !== p.src ||
    q.source !== p.dst ||
    q.port !== p.destinationPort ||
    p.sourcePort !== 123 ||
    q.originate !== m.originate ||
    m.transmit < m.receive
  ) {
    e.drop(d, 'NTP: resposta sem pedido/timestamps correspondentes.');
    return;
  }
  // "ntp authenticate": only a reply signed with the configured, trusted key can be a sync source.
  const auth = d.iosSystem?.ntp;
  if (auth?.authenticate) {
    const keyId = ntpServerOptions(d, p.src)?.key,
      key = ntpKey(d, keyId);
    if (
      !key ||
      !auth.trustedKeys?.includes(keyId!) ||
      m.keyId !== keyId ||
      m.mac !== ntpMac(key, 'server', m.id)
    ) {
      e.drop(d, 'NTP: authentication failed for server ' + p.src + '; it cannot be a sync source.');
      return;
    }
  }
  const t4 = networkTime(e, d),
    delay = t4 - m.originate - (m.transmit - m.receive),
    offset = (m.receive - m.originate + (m.transmit - t4)) / 2;
  if (delay < 0 || !Number.isFinite(offset) || Math.abs((d.networkClock?.offsetMs ?? 0) + offset) > 3600000) {
    e.drop(d, 'NTP: timestamps/offset inválidos.');
    return;
  }
  d.networkClock!.offsetMs += offset;
  s.samples.push({ server: p.src, at: e.state.clock, offsetMs: offset, delayMs: delay });
  s.samples = s.samples.slice(-32);
  s.stratum = Math.min(16, m.stratum + 1);
  s.synchronized = s.stratum < 16;
  s.lastSync = e.state.clock;
  delete s.pending;
  e.emit(
    'NTP_STATE',
    d.id,
    'Offset corrigido ' +
      offset.toFixed(3) +
      ' ms; RTT ' +
      delay.toFixed(3) +
      ' ms; stratum ' +
      s.stratum +
      '.'
  );
}
export function validateNtp(s: Snapshot) {
  for (const d of s.devices) {
    const n = d.ntp;
    if (!n || !checkDevice(d.id)) continue;
    const timers = deviceTimers(s, d.id, 'ntp-tick');
    if (
      !d.networkClock ||
      n.index >= n.servers.length ||
      new Set(n.servers).size !== n.servers.length ||
      n.servers.some((ip) => !isUnicast(ip) || d.interfaces.some((p) => p.ip === ip)) ||
      n.samples.some((x) => x.at > s.clock) ||
      (n.lastSync !== undefined && n.lastSync > s.clock) ||
      (n.roundAt !== undefined && n.roundAt > s.clock) ||
      (n.roundTried ?? 0) > n.servers.length ||
      (n.synchronized && (!n.lastSync || n.stratum >= 16 || !n.samples.length)) ||
      (n.pending &&
        (!n.enabled ||
          n.pending.at > s.clock ||
          !n.servers.includes(n.pending.server) ||
          !isUnicast(n.pending.source))) ||
      timers.length !== 1 ||
      timers[0].at !== n.tickAt ||
      timers[0].action.kind !== 'ntp-tick' ||
      timers[0].action.token !== n.token
    )
      throw new Error('Estado/timer NTP inválido.');
  }
  for (const q of s.queue) {
    const a = q.action;
    if (a.kind === 'ntp-tick' && !validatedDevice(s, a.device)?.ntp) throw new Error('Timer NTP órfão.');
  }
}

export function stampNtp(e: SimulationEngine, d: Device, p: UdpPacket) {
  if (p.payload.protocol !== 'NTP' || !d.interfaces.some((i) => i.ip === p.src)) return;
  const m = p.payload.message;
  if (m.mode === 'client' && d.ntp?.pending?.id === m.id) {
    m.originate = networkTime(e, d);
    d.ntp.pending.originate = m.originate;
  }
  if (m.mode === 'server') m.transmit = networkTime(e, d);
}
