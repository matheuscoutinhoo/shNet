import type { Action, Device, Snapshot } from '../model';
import type { SimulationEngine } from '../core/engine';
import { random } from '../core/queue';
import { cableMetrics, linkOperational } from '../links/physical';
import { canonicalScenarioJson } from '../canonical-json';
import { applyDatabaseHa, detachDatabaseHa } from './database-ha';
import {
  createQuorumNode,
  proposeQuorum,
  receiveQuorum,
  tickQuorum,
  validateQuorumState,
  quorumBase,
  quorumLastIndex,
  quorumEntryAt,
  quorumDataAt,
  compactQuorum,
  type QuorumCommand,
  type QuorumMessage,
  type QuorumResult,
} from './quorum';
type QuorumAction = Extract<Action, { kind: 'quorum-tick' | 'quorum-deliver' }>;
const tickMs = 50;

function channel(s: Snapshot, d: Device, peerId: string) {
  const port = d.quorum?.ports[peerId],
    peer = s.devices.find((p) => p.id === peerId);
  const remote = peer?.quorum?.ports[d.id];
  if (!port || !remote) return;
  const link = s.links.find(
    (l) =>
      [l.a, l.b].some((p) => p.device === d.id && p.port === port) &&
      [l.a, l.b].some((p) => p.device === peerId && p.port === remote)
  );
  return link && { link, port, peer: peer! };
}
function install(e: SimulationEngine, d: Device, result: QuorumResult) {
  const old = d.quorum!.node;
  d.quorum!.node = result.state;
  if (old.role !== result.state.role || old.term !== result.state.term)
    e.emit('CONFIG_CHANGED', d.id, `Quorum: ${result.state.role}, termo ${result.state.term}.`);
  if (result.state.commit > old.commit)
    e.emit('HA_SYNC_RECEIVED', d.id, `Quorum: commit ${result.state.commit} confirmado.`);
  applyDatabaseHa(e, d);
  for (const message of result.messages) send(e, d, message);
}
function send(e: SimulationEngine, d: Device, message: QuorumMessage) {
  const c = channel(e.state, d, message.to);
  if (!c || !linkOperational(e.state, c.link)) return;
  // Bounded network queues. Drops cause timeout/retry, never a synthetic ACK.
  if (
    e.state.queue.filter((q) => q.action.kind === 'quorum-deliver' && q.action.message.from === d.id)
      .length >= 8
  )
    return;
  const port = d.interfaces.find((p) => p.id === c.port)!;
  port.tx++;
  e.emit('HA_SYNC_SENT', d.id, `Quorum ${message.kind}, termo ${message.term}.`, {
    peer: c.peer.id,
    port: port.id,
    link: c.link.id,
  });
  if (random(e.state) < c.link.loss) return;
  const bytes = new TextEncoder().encode(JSON.stringify(message)).length;
  e.schedule(
    Math.max(
      0.001,
      cableMetrics(c.link).latency +
        (random(e.state) * 2 - 1) * c.link.jitter +
        (bytes * 8) / (port.speed * 1000)
    ),
    {
      kind: 'quorum-deliver',
      device: c.peer.id,
      token: c.peer.quorum!.token,
      link: c.link.id,
      message,
    }
  );
}
function dedicated(d: Device, portId: string) {
  const p = d.interfaces.find((p) => p.id === portId);
  return (
    p &&
    p.media === 'rj45' &&
    !p.logical &&
    !p.ip &&
    !p.ipv6 &&
    !p.dhcp &&
    !p.dhcp6 &&
    !p.aggregate &&
    !p.bond &&
    !p.tunnel &&
    !p.vxlan &&
    !p.loopback &&
    !p.channel &&
    p.mode === 'routed' &&
    !p.vrf &&
    !p.aclIn &&
    !p.aclOut &&
    !p.natRole &&
    !p.dot1x &&
    !p.supplicant &&
    !p.dhcpRelay?.length &&
    d.stateSync?.port !== p.id &&
    d.dhcpHa?.port !== p.id &&
    !d.interfaces.some((i) => i.aggregate?.members.includes(p.id) || i.bond?.members.includes(p.id))
  );
}
export function configureQuorumLab(e: SimulationEngine, memberIds: string[]) {
  if (![3, 5].includes(memberIds.length) || new Set(memberIds).size !== memberIds.length)
    throw new Error('Quorum exige três ou cinco servidores distintos.');
  const members = memberIds.map((id) => e.device(id));
  if (members.some((d) => d.type !== 'server' || d.quorum))
    throw new Error('Selecione servidores sem outro grupo de quorum.');
  const ports = new Map<string, Record<string, string>>();
  for (const d of members) {
    const mapping: Record<string, string> = {};
    for (const peer of members.filter((p) => p.id !== d.id)) {
      const link = e.state.links.find(
        (l) =>
          [l.a, l.b].some((p) => p.device === d.id) &&
          [l.a, l.b].some((p) => p.device === peer.id) &&
          [l.a, l.b].every((p) => dedicated(e.device(p.device), p.port))
      );
      if (!link) throw new Error('Conecte cada par de servidores por portas RJ45 dedicadas sem IP.');
      mapping[peer.id] = [link.a, link.b].find((p) => p.device === d.id)!.port;
    }
    ports.set(d.id, mapping);
  }
  const cluster = e.id('quorum');
  for (const d of members) {
    const node = createQuorumNode({
      cluster,
      self: d.id,
      members: [...memberIds],
      seed: Math.floor(random(e.state) * 0xffffffff),
    });
    // Timers are absolute virtual milliseconds, including creation after time 0.
    node.now = Math.floor(e.state.clock);
    node.electionAt += node.now;
    d.quorum = { token: e.id('quorum-token'), node, ports: ports.get(d.id)! };
    e.schedule(tickMs, { kind: 'quorum-tick', device: d.id, token: d.quorum.token });
  }
  e.emit(
    'CONFIG_CHANGED',
    members[0].id,
    'Laboratório de quorum configurado; três/cinco réplicas completas.'
  );
}
export function removeQuorumLab(e: SimulationEngine, d: Device) {
  const cluster = d.quorum?.node.cluster;
  if (!cluster) return;
  const ids = new Set(e.state.devices.filter((p) => p.quorum?.node.cluster === cluster).map((p) => p.id));
  for (const p of e.state.devices)
    if (ids.has(p.id)) {
      detachDatabaseHa(e, p);
      delete p.quorum;
    }
  e.state.queue = e.state.queue.filter(
    (q) =>
      !((q.action.kind === 'quorum-tick' || q.action.kind === 'quorum-deliver') && ids.has(q.action.device))
  );
  e.emit('CONFIG_CHANGED', d.id, 'Grupo de quorum removido de todos os membros.');
  e.refreshVrrp();
}
export function proposeQuorumLab(e: SimulationEngine, d: Device, command: QuorumCommand) {
  if (!d.power || !d.quorum) throw new Error('Servidor de quorum indisponível.');
  if ((command.kind === 'database') !== !!d.databaseHa)
    throw new Error('Operação incompatível com o vínculo SQL deste grupo.');
  const result = proposeQuorum(d.quorum.node, command);
  install(e, d, result);
  return { term: result.state.term, index: result.index };
}
export function compactQuorumLab(e: SimulationEngine, d: Device) {
  if (!d.power || !d.quorum) throw new Error('Servidor de quorum indisponível.');
  const node = compactQuorum(d.quorum.node);
  install(e, d, { state: node, messages: [] });
  e.emit(
    'HA_SYNC_RECEIVED',
    d.id,
    `Checkpoint local no índice ${node.snapshot!.index}; dados confirmados preservados.`
  );
}
export function handleQuorumLab(e: SimulationEngine, action: QuorumAction) {
  const d = e.state.devices.find((p) => p.id === action.device);
  if (!d?.quorum || d.quorum.token !== action.token) return;
  if (action.kind === 'quorum-tick') {
    if (d.power) install(e, d, tickQuorum(d.quorum.node, Math.floor(e.state.clock)));
    e.schedule(tickMs, action);
  } else {
    const c = channel(e.state, d, action.message.from);
    if (!d.power || !c || c.link.id !== action.link || !linkOperational(e.state, c.link)) return;
    d.interfaces.find((p) => p.id === c.port)!.rx++;
    install(e, d, receiveQuorum(d.quorum.node, action.message, Math.floor(e.state.clock)));
  }
}
export function validateQuorumLab(s: Snapshot) {
  for (const d of s.devices) {
    if (!d.quorum) continue;
    const n = validateQuorumState(d.quorum.node);
    if (d.type !== 'server' || n.self !== d.id || n.now > s.clock)
      throw new Error('Identidade/relógio de quorum inválido.');
    const peers = n.members.filter((p) => p !== d.id);
    if (
      n.receiving &&
      (s.devices.find((p) => p.id === n.receiving!.from)?.quorum?.node.term ?? -1) < n.receiving.term
    )
      throw new Error('Transferência de checkpoint incompatível com a origem.');
    if (
      Object.keys(d.quorum.ports).length !== peers.length ||
      new Set(Object.values(d.quorum.ports)).size !== peers.length
    )
      throw new Error('Portas de quorum inválidas.');
    for (const peerId of peers) {
      const peer = s.devices.find((p) => p.id === peerId);
      if (
        !dedicated(d, d.quorum.ports[peerId]) ||
        !peer?.quorum ||
        peer.quorum.node.cluster !== n.cluster ||
        [...peer.quorum.node.members].sort().join('|') !== [...n.members].sort().join('|')
      )
        throw new Error('Membros ou portas de quorum incompatíveis.');
      const common = Math.min(n.commit, peer.quorum.node.commit);
      const overlap = Math.max(quorumBase(n), quorumBase(peer.quorum.node));
      if (
        common >= overlap &&
        ((quorumEntryAt(n, common)?.term ?? n.snapshot?.term ?? 0) !==
          (quorumEntryAt(peer.quorum.node, common)?.term ?? peer.quorum.node.snapshot?.term ?? 0) ||
          canonicalScenarioJson(quorumDataAt(n, common)) !==
            canonicalScenarioJson(quorumDataAt(peer.quorum.node, common)) ||
          canonicalScenarioJson(n.log.slice(overlap - quorumBase(n), common - quorumBase(n))) !==
            canonicalScenarioJson(
              peer.quorum.node.log.slice(
                overlap - quorumBase(peer.quorum.node),
                common - quorumBase(peer.quorum.node)
              )
            ))
      )
        throw new Error('Históricos confirmados de quorum divergentes.');
    }
    if (
      s.queue.filter(
        (q) =>
          q.action.kind === 'quorum-tick' && q.action.device === d.id && q.action.token === d.quorum!.token
      ).length !== 1
    )
      throw new Error('Quorum exige exatamente um timer por membro.');
    if (
      s.queue.filter((q) => q.action.kind === 'quorum-deliver' && q.action.message.from === d.id).length > 8
    )
      throw new Error('Fila de quorum excede oito mensagens por emissor.');
  }
  for (const q of s.queue) {
    const a = q.action;
    if (a.kind !== 'quorum-tick' && a.kind !== 'quorum-deliver') continue;
    const d = s.devices.find((p) => p.id === a.device);
    if (!d?.quorum || d.quorum.token !== a.token) throw new Error('Evento de quorum órfão.');
    if (a.kind === 'quorum-tick' && q.at > s.clock + tickMs)
      throw new Error('Timer de quorum fora do intervalo.');
    if (a.kind === 'quorum-deliver') {
      const c = channel(s, d, a.message.from);
      if (!c || c.link.id !== a.link || a.message.to !== d.id || a.message.cluster !== d.quorum.node.cluster)
        throw new Error('Entrega de quorum fora do canal.');
      const source = c.peer.quorum!.node;
      if (
        a.message.term > source.term ||
        (a.message.term === source.term &&
          a.message.kind === 'voted' &&
          a.message.granted &&
          source.votedFor !== d.id) ||
        (a.message.term === source.term &&
          a.message.kind === 'appended' &&
          a.message.success &&
          a.message.matched > quorumLastIndex(source)) ||
        (a.message.kind === 'snapshotted' && a.message.installed && a.message.index > source.commit)
      )
        throw new Error('Mensagem de quorum incompatível com a origem.');
    }
  }
}
