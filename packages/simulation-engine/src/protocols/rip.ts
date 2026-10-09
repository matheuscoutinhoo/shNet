import { encodeRip, ripAuthentication } from './rip-codec';
import type { SimulationEngine } from '../core/engine';
import type { Action, Device, NetworkInterface, UdpPacket } from '../model';
import { LIMITS } from '../model';
import { random } from '../core/queue';
import { interfaceOperational } from './layer3';
import { subnet, sameSubnet } from './ipv4';
import { isUnicast } from './dhcp-config';
import { RIP, ripConfigSchema, type RipMessage, type RipRoute } from './rip-model';
import type { DynamicRoute } from './ospf-model';

export const ripBytes = (message: RipMessage) => 28 + encodeRip(message).length;
export function ripRoutes(device: Device): DynamicRoute[] {
  return device.rip?.enabled
    ? device.rip.table
        .filter((entry) => entry.learnedFrom && entry.metric < RIP.infinity)
        .map((entry) => ({
          network: entry.network,
          prefix: entry.prefix,
          port: entry.port,
          nextHop: entry.nextHop,
          metric: entry.metric,
          protocol: 'RIP',
          distance: 120,
        }))
    : [];
}
function send(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  message: RipMessage,
  peer?: { ip: string; mac: string }
) {
  if (!device.power || !port.adminUp || !port.ip) return;
  message = structuredClone(message);
  const config = device.rip!.interfaces.find((c) => c.port === port.id)!;
  const key = config.keys
    .filter(
      (k) => k.from <= engine.state.clock && (k.through === undefined || k.through > engine.state.clock)
    )
    .sort((a, b) => b.from - a.from || b.id - a.id)[0];
  if (config.keys.length && !key) {
    engine.drop(device, 'RIP: nenhuma chave válida.', port.id);
    return;
  }
  if (key) {
    message.authentication = {
      keyId: key.id,
      sequence: ++engine.state.sequence >>> 0,
      digest: '00'.repeat(32),
    };
    message.authentication.digest = ripAuthentication(message, key.key);
  }
  const packet: UdpPacket = {
    src: port.ip,
    dst: peer?.ip ?? RIP.destination,
    ttl: 1,
    protocol: 'UDP',
    sourcePort: RIP.port,
    destinationPort: RIP.port,
    payload: { protocol: 'RIP', message },
    bytes: ripBytes(message),
  };
  const frame = {
    src: port.mac,
    dst: peer?.mac ?? RIP.mac,
    etherType: 'IPv4' as const,
    packet,
    hops: LIMITS.l2Hops,
  };
  engine.emit(
    message.type === 'request' ? 'RIP_REQUEST' : 'RIP_UPDATE',
    device.id,
    `RIPv2 ${message.type} em ${port.name}${message.type === 'response' ? ', ' + message.entries.length + ' rotas' : ''}.`,
    { port: port.id, frame }
  );
  engine.sendFrame(device.id, port.id, frame);
}
function sendTable(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  peer?: { ip: string; mac: string },
  withdrawal = false
) {
  const state = device.rip!,
    config = state.interfaces.find((entry) => entry.port === port.id)!;
  const entries = state.table
    .filter(
      (route) =>
        !config.outputPrefixes.length ||
        config.outputPrefixes.some(
          (f) => route.prefix >= f.prefix && sameSubnet(route.network, f.network, f.prefix)
        )
    )
    .filter((route) => config.poisonReverse || !route.learnedFrom || route.port !== port.id)
    .map((route) => ({
      network: route.network,
      prefix: route.prefix,
      metric: withdrawal || (route.learnedFrom && route.port === port.id) ? 16 : route.metric,
      tag: route.tag,
      nextHop:
        route.learnedFrom && sameSubnet(route.nextHop, port.ip!, port.prefix!) && route.nextHop !== port.ip
          ? route.nextHop
          : '0.0.0.0',
    }))
    .sort((a, b) => a.network.localeCompare(b.network) || a.prefix - b.prefix);
  const chunk = config.keys.length ? 24 : 25;
  for (let index = 0; index < Math.max(1, entries.length); index += chunk)
    send(
      engine,
      device,
      port,
      { type: 'response', version: 2, entries: entries.slice(index, index + chunk) },
      peer
    );
}
function changed(engine: SimulationEngine, device: Device, route: RipRoute) {
  const state = device.rip!;
  state.triggerAt ??= engine.state.clock + 1000 + Math.floor(random(engine.state) * 4000);
  engine.emit(
    route.metric === 16 ? 'ROUTE_REMOVED' : 'ROUTE_ADDED',
    device.id,
    `RIP ${route.network}/${route.prefix} ${route.metric === 16 ? 'inalcançável (métrica 16)' : 'via ' + route.nextHop + ', métrica ' + route.metric}.`
  );
}
function poison(engine: SimulationEngine, device: Device, route: RipRoute) {
  if (route.metric === 16) return;
  route.lastMetric = route.metric;
  if (device.rip!.holdDownMs && route.learnedFrom)
    route.holdDownUntil = engine.state.clock + device.rip!.holdDownMs;
  route.metric = 16;
  route.garbageAt = engine.state.clock + RIP.garbageMs;
  changed(engine, device, route);
}
export function configureRip(engine: SimulationEngine, device: Device, input: unknown) {
  const config = ripConfigSchema.parse(input);
  if (device.type !== 'router') throw new Error('RIP exige roteador.');
  if (
    config.interfaces.some(
      (c) =>
        new Set(c.keys.map((k) => k.id)).size !== c.keys.length ||
        c.keys.some((k) => k.through !== undefined && k.through <= k.from) ||
        [...c.inputPrefixes, ...c.outputPrefixes].some(
          (f) => subnet(f.network, f.prefix).network !== f.network
        )
    )
  )
    throw new Error('RIP: chaves/filtros inválidos.');
  if (
    new Set(config.interfaces.map((entry) => entry.port)).size !== config.interfaces.length ||
    config.interfaces.some(
      (entry) => !device.interfaces.some((port) => port.id === entry.port && port.mode === 'routed')
    )
  )
    throw new Error('Interface RIP inválida ou duplicada.');
  if (device.rip?.enabled)
    for (const previous of device.rip.interfaces.filter((entry) => !entry.passive))
      sendTable(
        engine,
        device,
        device.interfaces.find((port) => port.id === previous.port)!,
        undefined,
        true
      );
  engine.state.queue = engine.state.queue.filter(
    ({ action }) => action.kind !== 'rip-tick' || action.device !== device.id
  );
  device.rip = {
    ...config,
    receivedSequences: [],
    token: engine.id('rip'),
    tickAt: engine.state.clock + 0.001,
    updateAt: engine.state.clock,
    table: [],
    ports: config.interfaces.map((entry) => ({ port: entry.port, operational: false, signature: '' })),
  };
  if (config.enabled)
    engine.schedule(0.001, { kind: 'rip-tick', device: device.id, token: device.rip.token });
  engine.emit('CONFIG_CHANGED', device.id, `RIPv2 ${config.enabled ? 'ativado' : 'desativado'}.`);
}
export function handleRipTick(engine: SimulationEngine, action: Extract<Action, { kind: 'rip-tick' }>) {
  const device = engine.device(action.device),
    state = device.rip;
  if (!state?.enabled || state.token !== action.token) return;
  for (const config of state.interfaces) {
    const port = device.interfaces.find((entry) => entry.id === config.port)!;
    const runtime = state.ports.find((entry) => entry.port === port.id)!;
    const operational =
      !!port.ip && port.prefix !== undefined && interfaceOperational(engine.state, device, port);
    const signature = `${port.ip}/${port.prefix}`;
    if (runtime.operational !== operational || runtime.signature !== signature) {
      for (const route of state.table.filter((entry) => entry.port === port.id))
        poison(engine, device, route);
      runtime.operational = operational;
      runtime.signature = signature;
      if (operational && !config.passive) send(engine, device, port, { type: 'request', version: 2 });
    }
  }
  const connected = state.interfaces.flatMap((config) => {
    const port = device.interfaces.find((entry) => entry.id === config.port)!;
    return state.ports.find((entry) => entry.port === port.id)!.operational &&
      port.ip &&
      port.prefix !== undefined
      ? [
          {
            network: subnet(port.ip, port.prefix).network,
            prefix: port.prefix,
            port: port.id,
            nextHop: port.ip,
            metric: 1,
            tag: 0,
          },
        ]
      : [];
  });
  if (state.redistributeStatic)
    for (const r of device.routes.filter((r) => !r.vrf)) {
      const port = state.interfaces
        .map((c) => device.interfaces.find((p) => p.id === c.port)!)
        .find(
          (p) =>
            p.ip &&
            p.prefix !== undefined &&
            sameSubnet(p.ip, r.nextHop, p.prefix) &&
            state.ports.find((t) => t.port === p.id)?.operational
        );
      if (port && !connected.some((c) => c.network === r.network && c.prefix === r.prefix))
        connected.push({
          network: r.network,
          prefix: r.prefix,
          port: port.id,
          nextHop: r.nextHop,
          metric: state.staticMetric,
          tag: state.staticTag,
        });
    }
  state.receivedSequences = state.receivedSequences.filter((r) => engine.state.clock - r.at < RIP.timeoutMs);
  for (const route of state.table) {
    if (
      !route.learnedFrom &&
      !connected.some((entry) => entry.network === route.network && entry.prefix === route.prefix)
    )
      poison(engine, device, route);
    if (route.learnedFrom && route.expiresAt! <= engine.state.clock) poison(engine, device, route);
  }
  for (const route of connected) {
    const index = state.table.findIndex(
      (entry) => entry.network === route.network && entry.prefix === route.prefix
    );
    if (
      index >= 0 &&
      !state.table[index].learnedFrom &&
      ['network', 'prefix', 'port', 'nextHop', 'metric', 'tag'].every(
        (k) => state.table[index][k as keyof RipRoute] === route[k as keyof typeof route]
      )
    )
      continue;
    if (index >= 0) state.table[index] = route;
    else if (state.table.length < 1024) state.table.push(route);
    else {
      engine.drop(device, 'Tabela RIP cheia.');
      continue;
    }
    changed(engine, device, route);
  }
  state.table = state.table.filter(
    (route) => route.garbageAt === undefined || route.garbageAt > engine.state.clock
  );
  const periodic = state.updateAt <= engine.state.clock;
  if (periodic || (state.triggerAt !== undefined && state.triggerAt <= engine.state.clock)) {
    for (const config of state.interfaces.filter(
      (entry) => !entry.passive && state.ports.find((port) => port.port === entry.port)?.operational
    ))
      sendTable(
        engine,
        device,
        device.interfaces.find((port) => port.id === config.port)!
      );
    if (periodic)
      state.updateAt = engine.state.clock + RIP.updateMs + Math.floor((random(engine.state) * 2 - 1) * 5000);
    delete state.triggerAt;
  }
  state.tickAt = engine.state.clock + RIP.tickMs;
  engine.schedule(RIP.tickMs, { kind: 'rip-tick', device: device.id, token: state.token });
}
export function receiveRip(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: UdpPacket,
  mac: string
) {
  if (packet.payload.protocol !== 'RIP') return;
  const state = device.rip,
    config = state?.interfaces.find((entry) => entry.port === port.id);
  if (!state?.enabled || !config || config.passive || !port.ip || port.prefix === undefined) return;
  const message = packet.payload.message;
  if (
    packet.sourcePort !== RIP.port ||
    packet.destinationPort !== RIP.port ||
    packet.ttl !== 1 ||
    packet.bytes !== ripBytes(message) ||
    !isUnicast(packet.src) ||
    !sameSubnet(packet.src, port.ip, port.prefix) ||
    ![RIP.destination, port.ip].includes(packet.dst) ||
    device.interfaces.some((entry) => entry.ip === packet.src)
  ) {
    engine.drop(device, 'RIP: origem, destino, tamanho, TTL ou portas inválidos.', port.id);
    return;
  }
  if (config.keys.length) {
    const a = message.authentication,
      key =
        a &&
        config.keys.find(
          (k) =>
            k.id === a.keyId &&
            k.from <= engine.state.clock &&
            (k.through === undefined || k.through > engine.state.clock)
        ),
      old =
        a &&
        state.receivedSequences.find(
          (r) => r.port === port.id && r.source === packet.src && r.keyId === a.keyId
        );
    if (
      !a ||
      !key ||
      a.digest !== ripAuthentication(message, key.key) ||
      (old && a.sequence < old.sequence)
    ) {
      engine.drop(device, 'RIP: autenticação/anti-replay inválidos.', port.id);
      return;
    }
    if (old) {
      old.sequence = a.sequence;
      old.at = engine.state.clock;
    } else if (state.receivedSequences.length < 256)
      state.receivedSequences.push({
        port: port.id,
        source: packet.src,
        keyId: a.keyId,
        sequence: a.sequence,
        at: engine.state.clock,
      });
    else return;
  } else if (message.authentication) {
    engine.drop(device, 'RIP: autenticação não configurada.', port.id);
    return;
  }
  engine.emit('RIP_RECEIVED', device.id, `RIPv2 ${message.type} de ${packet.src}.`, { port: port.id });
  if (message.type === 'request') {
    sendTable(engine, device, port, { ip: packet.src, mac });
    return;
  }
  for (const entry of message.entries) {
    if (
      subnet(entry.network, entry.prefix).network !== entry.network ||
      (entry.prefix !== 0 && !isUnicast(entry.network))
    ) {
      engine.drop(device, 'RIP: prefixo inválido.', port.id);
      continue;
    }
    if (
      config.inputPrefixes.length &&
      !config.inputPrefixes.some(
        (f) => entry.prefix >= f.prefix && sameSubnet(entry.network, f.network, f.prefix)
      )
    )
      continue;
    const metric = Math.min(16, entry.metric + config.cost);
    const existing = state.table.find(
      (route) => route.network === entry.network && route.prefix === entry.prefix
    );
    if (existing && !existing.learnedFrom && existing.metric < 16) continue;
    const sameSource = existing?.learnedFrom === packet.src && existing.port === port.id;
    if (
      existing?.holdDownUntil &&
      existing.holdDownUntil > engine.state.clock &&
      !sameSource &&
      metric >= (existing.lastMetric ?? 16)
    )
      continue;
    if (existing && !sameSource && existing.metric <= metric) continue;
    if (!existing && metric === 16) continue;
    if (!existing && state.table.length >= 1024) {
      engine.drop(device, 'Tabela RIP cheia.');
      continue;
    }
    if (metric === 16 && existing) {
      poison(engine, device, existing);
      continue;
    }
    const route: RipRoute = {
      ...entry,
      metric,
      port: port.id,
      nextHop:
        entry.nextHop &&
        isUnicast(entry.nextHop) &&
        sameSubnet(entry.nextHop, port.ip, port.prefix) &&
        !device.interfaces.some((p) => p.ip === entry.nextHop)
          ? entry.nextHop
          : packet.src,
      learnedFrom: packet.src,
      expiresAt: engine.state.clock + RIP.timeoutMs,
    };
    const difference =
      !existing ||
      existing.metric !== metric ||
      existing.nextHop !== route.nextHop ||
      existing.port !== route.port ||
      existing.tag !== route.tag;
    if (existing) state.table.splice(state.table.indexOf(existing), 1, route);
    else state.table.push(route);
    if (difference) changed(engine, device, route);
  }
}
