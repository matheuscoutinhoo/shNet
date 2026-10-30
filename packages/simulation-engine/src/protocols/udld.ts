import type { SimulationEngine } from '../core/engine';
import type { Device, NetworkInterface, Frame, Snapshot } from '../model';
import { interfaceOperational } from './layer3';
const destination = '01:00:0c:cc:cc:cc';
function transmit(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  opcode: 'probe' | 'echo' | 'flush' = 'probe'
) {
  const s = p.udld!;
  e.sendFrame(d.id, p.id, {
    src: p.mac,
    dst: destination,
    etherType: 'UDLD',
    hops: 1,
    udld: {
      device: d.id,
      port: p.id,
      opcode,
      intervalMs: s.intervalMs,
      echoes: s.peers
        .filter((n) => n.expiresAt > e.state.clock)
        .map((n) => ({ device: n.device, port: n.port })),
    },
  });
}
export function configureUdld(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  mode?: 'normal' | 'aggressive'
) {
  if (
    !['router', 'switch'].includes(d.type) ||
    p.logical ||
    p.aggregate ||
    p.tunnel ||
    p.bond ||
    p.vxlan ||
    ['wifi', 'serial', 'console', 'mesh'].includes(p.media)
  )
    throw new Error('UDLD requires a physical Ethernet interface.');
  if (p.udld && interfaceOperational(e.state, d, p)) transmit(e, d, p, 'flush');
  e.state.queue = e.state.queue.filter(
    (q) => q.action.kind !== 'udld-tick' || q.action.device !== d.id || q.action.port !== p.id
  );
  if (!mode) {
    delete p.udld;
    return;
  }
  p.udld = {
    mode,
    intervalMs: p.udld?.intervalMs ?? 15000,
    token: e.id('udld'),
    nextAt: e.state.clock,
    state: 'unknown',
    established: false,
    attempts: 0,
    peers: [],
    tickAt: e.state.clock + 0.001,
  };
  e.schedule(0.001, { kind: 'udld-tick', device: d.id, port: p.id, token: p.udld.token });
}
export function receiveUdld(e: SimulationEngine, d: Device, p: NetworkInterface, f: Frame) {
  const s = p.udld,
    m = f.udld;
  if (!s || !m || f.dst !== destination || f.vlan !== undefined || !interfaceOperational(e.state, d, p))
    return;
  if (m.device === d.id) {
    p.errDisabled = { reason: 'udld', at: e.state.clock };
    s.state = 'disabled';
    e.refreshSpanningTree();
    return;
  }
  const old = s.peers.find((n) => n.device === m.device && n.port === m.port);
  s.peers = s.peers.filter((n) => n !== old);
  if (m.opcode === 'flush') {
    s.state = 'unknown';
    s.established = false;
    delete s.retryAt;
    s.nextAt = e.state.clock;
    return;
  }
  if (s.peers.length === 8) {
    e.drop(d, 'UDLD: neighbor capacity exceeded.', p.id, f);
    return;
  }
  const echoed = m.echoes.some((n) => n.device === d.id && n.port === p.id);
  s.peers.push({ device: m.device, port: m.port, expiresAt: e.state.clock + 3 * m.intervalMs, echoed });
  if (echoed) {
    s.state = 'bidirectional';
    s.established = true;
    delete s.retryAt;
    s.attempts = 0;
  } else if (s.established) {
    s.state = 'unidirectional';
    s.retryAt ??= e.state.clock;
    s.nextAt = Math.min(s.nextAt, e.state.clock + 1000);
  }
  if (!old) transmit(e, d, p, 'echo');
}
export function udldTick(e: SimulationEngine, d: Device, p: NetworkInterface, token: string) {
  const s = p.udld;
  if (!s || s.token !== token) return;
  delete s.tickAt;
  if (!interfaceOperational(e.state, d, p)) {
    s.peers = [];
    s.established = false;
    delete s.retryAt;
    s.attempts = 0;
    s.state = p.errDisabled?.reason === 'udld' ? 'disabled' : 'unknown';
    s.nextAt = e.state.clock;
  } else {
    const lost = s.peers.some((n) => n.expiresAt <= e.state.clock);
    s.peers = s.peers.filter((n) => n.expiresAt > e.state.clock);
    if (lost && s.established) {
      s.state = 'unknown';
      if (s.mode === 'aggressive') {
        s.retryAt ??= e.state.clock;
        s.nextAt = e.state.clock;
      }
    }
    if (s.retryAt !== undefined && e.state.clock >= s.retryAt + 8000) {
      s.state = 'disabled';
      p.errDisabled = { reason: 'udld', at: e.state.clock };
      e.emit('CONFIG_CHANGED', d.id, 'UDLD detected a unidirectional link; interface error-disabled.', {
        port: p.id,
      });
      e.refreshSpanningTree();
    } else if (e.state.clock >= s.nextAt) {
      transmit(e, d, p, s.retryAt === undefined ? 'probe' : 'echo');
      if (s.retryAt !== undefined) s.attempts = Math.min(8, s.attempts + 1);
      s.nextAt = e.state.clock + (s.retryAt !== undefined || !s.established ? 1000 : s.intervalMs);
    }
  }
  s.tickAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'udld-tick', device: d.id, port: p.id, token: s.token });
}
export function validateUdld(s: Snapshot) {
  for (const d of s.devices)
    for (const p of d.interfaces) {
      const u = p.udld;
      if (!u) continue;
      const timers = s.queue.filter(
        (q) => q.action.kind === 'udld-tick' && q.action.device === d.id && q.action.port === p.id
      );
      if (
        timers.length !== 1 ||
        timers[0].at !== u.tickAt ||
        timers[0].action.kind !== 'udld-tick' ||
        timers[0].action.token !== u.token ||
        new Set(u.peers.map((n) => n.device + ':' + n.port)).size !== u.peers.length
      )
        throw new Error('Invalid UDLD state or timer.');
    }
}
