import type { SimulationEngine } from '../core/engine';
import type { Action, Device, UdpPacket, Snapshot } from '../model';
import { clockConfigSchema, ntpConfigSchema } from './telemetry-model';
import { resolveRoute } from './ipv4';
import { isUnicast } from './dhcp-config';
export const networkTime = (e: SimulationEngine, d: Device) =>
  e.state.clock + (d.networkClock?.offsetMs ?? 0);
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
  if (
    s.enabled &&
    d.power &&
    !s.pending &&
    (s.lastSync === undefined || !s.synchronized || e.state.clock - s.lastSync >= s.intervalMs)
  ) {
    const server = s.servers[s.index],
      route = resolveRoute(d, server);
    if (route?.port.ip) {
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
        source: route.port.ip,
        port,
        originate: networkTime(e, d),
        at: e.state.clock,
      };
      e.sendIp(d.id, {
        protocol: 'UDP',
        src: route.port.ip,
        dst: server,
        sourcePort: port,
        destinationPort: 123,
        ttl: 64,
        bytes: 76,
        payload: {
          protocol: 'NTP',
          message: { mode: 'client', id: s.pending.id, originate: s.pending.originate },
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
  if (p.payload.protocol !== 'NTP' || !isUnicast(p.src) || !isUnicast(p.dst) || p.bytes !== 76 || !p.ttl)
    return;
  const m = p.payload.message;
  if (m.mode === 'client') {
    if (p.destinationPort !== 123 || !d.networkClock?.server || (d.ntp?.enabled && !d.ntp.synchronized)) {
      e.drop(d, 'NTP: servidor indisponível/não sincronizado.');
      return;
    }
    const stratum = d.ntp?.enabled ? d.ntp.stratum : d.networkClock.stratum;
    if (stratum > 15) return;
    const now = networkTime(e, d);
    e.sendIp(d.id, {
      protocol: 'UDP',
      src: p.dst,
      dst: p.src,
      sourcePort: 123,
      destinationPort: p.sourcePort,
      ttl: 64,
      bytes: 76,
      payload: {
        protocol: 'NTP',
        message: { mode: 'server', id: m.id, originate: m.originate, receive: now, transmit: now, stratum },
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
    if (!n) continue;
    const timers = s.queue.filter((q) => q.action.kind === 'ntp-tick' && q.action.device === d.id);
    if (
      !d.networkClock ||
      n.index >= n.servers.length ||
      new Set(n.servers).size !== n.servers.length ||
      n.servers.some((ip) => !isUnicast(ip) || d.interfaces.some((p) => p.ip === ip)) ||
      n.samples.some((x) => x.at > s.clock) ||
      (n.lastSync !== undefined && n.lastSync > s.clock) ||
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
    if (a.kind === 'ntp-tick' && !s.devices.some((d) => d.id === a.device && d.ntp))
      throw new Error('Timer NTP órfão.');
  }
}

export function stampNtp(e: SimulationEngine, d: Device, p: UdpPacket) {
  if (p.payload.protocol !== 'NTP' || !d.interfaces.some((i) => i.ip === p.src)) return;
  const m = p.payload.message;
  if (m.mode === 'client' && d.ntp?.pending?.id === m.id) {
    m.originate = networkTime(e, d);
    d.ntp.pending.originate = m.originate;
  }
  if (m.mode === 'server' && d.networkClock?.server) m.transmit = networkTime(e, d);
}
