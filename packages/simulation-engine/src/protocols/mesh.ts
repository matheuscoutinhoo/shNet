import type { SimulationEngine } from '../core/engine';
import {
  LIMITS,
  frameSchema,
  interfaceSchema,
  type Action,
  type Device,
  type Frame,
  type Link,
  type Snapshot,
} from '../model';
import { meshConfigSchema } from './mesh-model';
import { wirelessConfig, configureWireless } from './wireless';
import { radioDistance, wirelessMetrics } from './wireless-radio';
import { hmacHex, sealRecord, openRecord } from './security-crypto';
const peer = (d: Device, remote: string) => d.mesh?.peers.find((p) => p.device === remote);
export function configureMesh(e: SimulationEngine, d: Device, input: unknown) {
  const c = meshConfigSchema.parse(input);
  if (d.type !== 'switch') throw new Error('Mesh exige AP/switch.');
  if (!d.wireless) configureWireless(e, d, { ...wirelessConfig(d), role: 'ap' });
  if (d.wireless?.role !== 'ap') throw new Error('Mesh exige papel AP.');
  const old = d.mesh;
  d.mesh = {
    ...c,
    token: e.id('mesh'),
    sequence: 0,
    tickAt: e.state.clock + 0.001,
    peers:
      old?.peers.map((p) => ({
        ...p,
        lastSeen: 0,
        sequence: 0,
        nonce: undefined,
        route: undefined,
        txSequence: 0,
        receivedSequences: [],
      })) ?? [],
    ...(c.root ? { route: { root: d.id, priority: c.priority, metric: 0, path: [d.id] } } : {}),
  };
  e.state.queue = e.state.queue.filter((q) => q.action.kind !== 'mesh-tick' || q.action.device !== d.id);
  e.schedule(0.001, { kind: 'mesh-tick', device: d.id, token: d.mesh.token });
  refreshMesh(e);
  e.emit('CONFIG_CHANGED', d.id, 'Mesh ' + c.meshId + ' configurado.');
}
function ensurePeer(e: SimulationEngine, d: Device, other: Device) {
  if (peer(d, other.id)) return;
  if (d.interfaces.length >= 48 || d.mesh!.peers.length >= 32) return;
  const id = e.id('mesh-port'),
    n = d.interfaces.length,
    p = interfaceSchema.parse({
      id,
      name: 'Mesh' + n,
      mac: d.interfaces[0].mac.slice(0, -2) + n.toString(16).padStart(2, '0'),
      media: 'wifi',
      meshPeer: other.id,
      adminUp: true,
      speed: 1000,
      duplex: 'full',
      mtu: 1500,
      mode: 'access',
      accessVlan: 1,
      nativeVlan: 1,
      allowedVlans: [1],
      description: 'Backhaul mesh',
      tx: 0,
      rx: 0,
      errors: 0,
      stpEdge: true,
    });
  d.interfaces.push(p);
  d.mesh!.peers.push({
    device: other.id,
    port: id,
    lastSeen: 0,
    sequence: 0,
    txSequence: 0,
    receivedSequences: [],
  });
}
export function refreshMesh(e: SimulationEngine) {
  const nodes = e.state.devices.filter((d) => d.mesh?.enabled && d.wireless?.role === 'ap');
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i],
        b = nodes[j];
      if (
        a.mesh!.meshId !== b.mesh!.meshId ||
        radioDistance(a, b) > Math.min(a.mesh!.maxDistance, b.mesh!.maxDistance)
      )
        continue;
      ensurePeer(e, a, b);
      ensurePeer(e, b, a);
      const pa = peer(a, b.id),
        pb = peer(b, a.id);
      if (!pa || !pb) continue;
      let link = e.state.links.find(
        (l) =>
          l.cable === 'mesh' &&
          [l.a, l.b].some((x) => x.device === a.id) &&
          [l.a, l.b].some((x) => x.device === b.id)
      );
      if (!link && e.state.links.length < 800) {
        link = {
          id: e.id('mesh-link'),
          a: { device: a.id, port: pa.port },
          b: { device: b.id, port: pb.port },
          cable: 'mesh',
          up: true,
          latency: 2,
          jitter: 0,
          loss: 0,
          distance: radioDistance(a, b),
        };
        e.state.links.push(link);
      }
      if (link) link.distance = radioDistance(a, b);
    }
}
function chooseRoute(e: SimulationEngine, d: Device) {
  const m = d.mesh!;
  if (m.root) {
    m.route = { root: d.id, priority: m.priority, metric: 0, path: [d.id] };
    delete m.parent;
    return;
  }
  const choices = m.peers
    .filter(
      (p) =>
        p.nonce &&
        p.route &&
        !p.route.path.includes(d.id) &&
        p.route.path.length < 16 &&
        e.state.clock - p.lastSeen <= 3500
    )
    .flatMap((p) => {
      const l = e.state.links.find(
        (l) => l.cable === 'mesh' && [l.a, l.b].some((end) => end.device === d.id && end.port === p.port)
      );
      if (!l) return [];
      const metrics = wirelessMetrics(e.state, l);
      if (!metrics.operational || metrics.distance > m.maxDistance) return [];
      return [{ peer: p, metric: p.route!.metric + 1 + metrics.loss * 10 }];
    })
    .sort(
      (a, b) =>
        a.peer.route!.priority - b.peer.route!.priority ||
        a.peer.route!.root.localeCompare(b.peer.route!.root) ||
        a.metric - b.metric ||
        a.peer.device.localeCompare(b.peer.device)
    );
  const selected = choices[0],
    before = m.parent;
  if (selected) {
    m.parent = selected.peer.device;
    m.route = {
      ...selected.peer.route!,
      metric: selected.metric,
      path: [...selected.peer.route!.path, d.id],
    };
  } else {
    delete m.parent;
    delete m.route;
  }
  if (before !== m.parent)
    e.emit(
      'WIFI_STATE',
      d.id,
      m.parent
        ? 'Mesh: caminho para ' + m.route!.root + ' via ' + m.parent + '.'
        : 'Mesh: sem caminho até uma raiz.'
    );
}
export function handleMeshTick(e: SimulationEngine, a: Extract<Action, { kind: 'mesh-tick' }>) {
  const d = e.device(a.device),
    m = d.mesh;
  if (!m || m.token !== a.token) return;
  refreshMesh(e);
  chooseRoute(e, d);
  if (m.enabled && d.power) {
    m.sequence++;
    for (const p of m.peers) {
      const header = {
        meshId: m.meshId,
        from: d.id,
        nonce: m.token,
        sequence: m.sequence,
        ...(m.route ? { route: m.route } : {}),
      };
      e.sendFrame(d.id, p.port, {
        src: d.interfaces.find((i) => i.id === p.port)!.mac,
        dst: e.device(p.device).interfaces.find((i) => i.meshPeer === d.id)!.mac,
        etherType: 'MESH',
        hops: LIMITS.l2Hops,
        meshHello: { ...header, authenticator: hmacHex(m.key, JSON.stringify(header)) },
      });
    }
  }
  m.tickAt = e.state.clock + 1000;
  e.schedule(1000, { kind: 'mesh-tick', device: d.id, token: m.token });
}
export function receiveMeshHello(e: SimulationEngine, d: Device, port: string, frame: Frame, from: string) {
  const m = d.mesh,
    p = peer(d, from),
    hello = frame.meshHello;
  if (!m || !p || p.port !== port || !hello || !m.enabled) return;
  const { authenticator, ...header } = hello;
  if (
    hello.meshId !== m.meshId ||
    hello.from !== from ||
    authenticator !== hmacHex(m.key, JSON.stringify(header)) ||
    (hello.route &&
      (hello.route.path.at(-1) !== from || new Set(hello.route.path).size !== hello.route.path.length))
  ) {
    e.drop(d, 'Mesh: anúncio sem autenticação/caminho válido.', port);
    return;
  }
  if (p.nonce === hello.nonce && hello.sequence <= p.sequence) return;
  if (p.nonce !== hello.nonce) {
    p.receivedSequences = [];
    p.txSequence = 0;
  }
  p.nonce = hello.nonce;
  p.sequence = hello.sequence;
  p.lastSeen = e.state.clock;
  p.route = hello.route;
  chooseRoute(e, d);
}
export function meshOperational(s: Snapshot, l: Link) {
  const a = s.devices.find((d) => d.id === l.a.device)!,
    b = s.devices.find((d) => d.id === l.b.device)!;
  if (
    !a.mesh?.enabled ||
    !b.mesh?.enabled ||
    !wirelessMetrics(s, l).operational ||
    radioDistance(a, b) > Math.min(a.mesh.maxDistance, b.mesh.maxDistance)
  )
    return false;
  return (
    a.mesh.route?.root === b.mesh.route?.root &&
    (a.mesh.parent === b.id || b.mesh.parent === a.id) &&
    !!peer(a, b.id)?.nonce &&
    !!peer(b, a.id)?.nonce
  );
}
function meshKey(d: Device, other: Device) {
  const sides = [
    { id: d.id, nonce: d.mesh!.token },
    { id: other.id, nonce: peer(d, other.id)!.nonce! },
  ].sort((a, b) => a.id.localeCompare(b.id));
  return hmacHex(d.mesh!.key, JSON.stringify(sides));
}
export function protectMesh(s: Snapshot, d: Device, l: Link, frame: Frame): Frame {
  const other = s.devices.find((v) => v.id === (l.a.device === d.id ? l.b.device : l.a.device))!,
    p = peer(d, other.id)!;
  const sequence = ++p.txSequence,
    direction = Number(d.id > other.id),
    key = meshKey(d, other),
    body = sealRecord(key, direction, sequence, JSON.stringify(frameSchema.parse(frame)), d.mesh!.meshId);
  return {
    src: d.interfaces.find((i) => i.meshPeer === other.id)!.mac,
    dst: other.interfaces.find((i) => i.meshPeer === d.id)!.mac,
    hops: frame.hops,
    etherType: '802.11-secure',
    secure: {
      token: d.mesh!.token,
      sequence,
      cipher: 'AES-GCM',
      innerBytes: frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes ?? 28,
      body: body.slice(0, -32),
      tag: body.slice(-32),
    },
  };
}
export function unprotectMesh(s: Snapshot, d: Device, l: Link, frame: Frame): Frame {
  const other = s.devices.find((v) => v.id === (l.a.device === d.id ? l.b.device : l.a.device))!,
    p = peer(d, other.id)!,
    record = frame.secure;
  if (
    !record ||
    record.cipher !== 'AES-GCM' ||
    record.token !== p.nonce ||
    p.receivedSequences.includes(record.sequence) ||
    record.sequence <= Math.max(0, ...p.receivedSequences) - 64
  )
    throw new Error('Mesh: sessão/ciphertext/replay inválido.');
  const body = openRecord(
      meshKey(d, other),
      Number(other.id > d.id),
      record.sequence,
      record.body + record.tag,
      d.mesh!.meshId
    ),
    inner = frameSchema.parse(JSON.parse(body));
  if (
    inner.secure ||
    inner.meshHello ||
    record.innerBytes !== (inner.packet?.bytes ?? inner.fragment?.bytes ?? inner.ipv6?.bytes ?? 28)
  )
    throw new Error('Mesh: conteúdo interno inválido.');
  p.receivedSequences = [...p.receivedSequences, record.sequence].sort((a, b) => a - b).slice(-64);
  return { ...inner, hops: frame.hops };
}
export function validateMesh(s: Snapshot) {
  const used = new Set<object>();
  for (const d of s.devices)
    if (d.mesh) {
      const m = d.mesh;
      if (d.wireless?.role !== 'ap' || new Set(m.peers.map((p) => p.device)).size !== m.peers.length)
        throw new Error('Mesh requer AP/peers distintos.');
      for (const p of m.peers)
        if (
          d.interfaces.find((i) => i.id === p.port)?.meshPeer !== p.device ||
          !s.devices.some((v) => v.id === p.device && v.mesh) ||
          p.lastSeen > s.clock ||
          new Set(p.receivedSequences).size !== p.receivedSequences.length
        )
          throw new Error('Peer mesh inválido.');
      if (
        (m.parent && !m.peers.some((p) => p.device === m.parent)) ||
        (m.route &&
          (m.route.path.at(-1) !== d.id ||
            m.route.path[0] !== m.route.root ||
            new Set(m.route.path).size !== m.route.path.length))
      )
        throw new Error('Caminho mesh inválido.');
      const timers = s.queue.filter((q) => q.action.kind === 'mesh-tick' && q.action.device === d.id);
      if (
        timers.length !== 1 ||
        timers[0].at !== m.tickAt ||
        timers[0].action.kind !== 'mesh-tick' ||
        timers[0].action.token !== m.token
      )
        throw new Error('Mesh sem timer.');
      used.add(timers[0].action);
    }
  for (const l of s.links.filter((l) => l.cable === 'mesh')) {
    const a = s.devices.find((d) => d.id === l.a.device),
      b = s.devices.find((d) => d.id === l.b.device);
    if (
      !a?.mesh ||
      !b?.mesh ||
      a.interfaces.find((p) => p.id === l.a.port)?.meshPeer !== b.id ||
      b.interfaces.find((p) => p.id === l.b.port)?.meshPeer !== a.id
    )
      throw new Error('Enlace mesh inválido.');
  }
  for (const q of s.queue)
    if (q.action.kind === 'mesh-tick' && !used.has(q.action)) throw new Error('Timer mesh órfão.');
}
