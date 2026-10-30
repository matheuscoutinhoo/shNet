import { lsaChecksum, ospfAuthenticator, ospfAreaType } from './ospf-security';
import type { SimulationEngine } from '../core/engine';
import type { Action, Device, NetworkInterface } from '../model';
import { interfaceOperational } from './layer3';
import { OSPF, ospfConfigSchema, lsaKey, type OspfPacket, type OspfNeighbor } from './ospf-model';
import { ipNumber, sameSubnet, subnet } from './ipv4';
import { synchronizeOspf } from './ospf-database';
import { validateOspfLsa } from './ospf-validation';
import { ospfHeaderWire } from '../wire/ospf-codec';
import {
  electOspfNeighbors,
  finishOspfExchange,
  ospfNeighborState,
  resetOspfExchange,
} from './ospf-neighbors';
import {
  floodOspf,
  ospfBytes,
  sendOspf,
  sendOspfDatabase,
  sendOspfHello,
  sendOspfRequests,
  sendOspfUpdate,
} from './ospf-wire';

export function configureOspf(engine: SimulationEngine, device: Device, input: unknown) {
  const config = ospfConfigSchema.parse(input);
  for (const p of config.interfaces) {
    const authentication = device.interfaces.find((i) => i.id === p.port)?.ospfAuthentication;
    if (authentication) {
      p.authenticationMode = authentication.enabled ? 'md5' : undefined;
      p.authenticationKey = authentication.enabled ? authentication.key : undefined;
      p.authenticationKeyId = authentication.enabled ? authentication.keyId : undefined;
    }
    const override = config.passiveOverrides.find((o) => o.port === p.port);
    if (override) p.passive = override.passive;
    else if (config.passiveDefault) p.passive = true;
    if (p.autoCost) {
      const physical = device.interfaces.find((i) => i.id === p.port);
      if (physical)
        p.cost = Math.max(1, Math.min(65535, Math.floor(config.referenceBandwidth / physical.speed)));
    }
  }
  if (device.type !== 'router' && !(device.type === 'switch' && device.ipRouting))
    throw new Error('OSPF exige roteamento L3.');
  if (
    (!ipNumber(config.routerId) && !(config.autoRouterId && !config.enabled)) ||
    ipNumber(config.routerId) >= 0xe0000000
  )
    throw new Error('Router ID OSPF deve ser IPv4 unicast não nulo.');
  if (
    new Set(config.interfaces.map((entry) => entry.port)).size !== config.interfaces.length ||
    config.interfaces.some(
      (entry) => !device.interfaces.some((port) => port.id === entry.port && port.mode === 'routed')
    )
  )
    throw new Error('Interface OSPF inválida ou duplicada.');
  if (
    new Set(config.areas.map((a) => a.id)).size !== config.areas.length ||
    config.areas.some((a) => a.id === 0 && a.type !== 'normal') ||
    config.externalRoutes.some((r) => subnet(r.network, r.prefix).network !== r.network) ||
    config.summaryRanges.some((r) => subnet(r.network, r.prefix).network !== r.network) ||
    new Set(config.passiveOverrides.map((o) => o.port)).size !== config.passiveOverrides.length ||
    config.passiveOverrides.some((o) => !device.interfaces.some((p) => p.id === o.port))
  )
    throw new Error('OSPF: áreas/rotas externas inválidas.');
  const previous = device.ospf;
  const withdrawals =
    previous?.lsdb
      .filter((lsa) => lsa.advertisingRouter === previous.routerId)
      .map((lsa) => ({
        ...lsa,
        withdrawn: true,
        sequence: ++engine.state.sequence,
        originatedAt: engine.state.clock,
      })) ?? [];
  for (const lsa of withdrawals) lsa.checksum = lsaChecksum(lsa);
  if (previous?.enabled) for (const lsa of withdrawals) floodOspf(engine, device, lsa);
  engine.state.queue = engine.state.queue.filter(
    ({ action }) => action.kind !== 'ospf-tick' || action.device !== device.id
  );
  device.ospf = {
    ...config,
    receivedSequences: [],
    token: engine.id('ospf'),
    tickAt: engine.state.clock + 0.001,
    ports: config.interfaces.map((entry) => ({
      port: entry.port,
      dr: '0.0.0.0',
      bdr: '0.0.0.0',
      waitUntil: engine.state.clock + (entry.networkType === 'broadcast' ? entry.deadMs : 0),
      helloAt: engine.state.clock,
      operational: false,
      signature: '',
    })),
    neighbors: [],
    lsdb: config.routerId === previous?.routerId ? withdrawals : [],
    routes: [],
    spfRuns: 0,
  };
  if (config.enabled)
    engine.schedule(0.001, { kind: 'ospf-tick', device: device.id, token: device.ospf.token });
  engine.emit(
    'CONFIG_CHANGED',
    device.id,
    `OSPF ${config.enabled ? 'ativado' : 'desativado'}, router ID ${config.routerId}.`
  );
}

/** IOS default OSPF network type: broadcast on Ethernet segments, point-to-point on serial/tunnel/loopback. */
export function defaultOspfNetworkType(port: NetworkInterface): 'point-to-point' | 'broadcast' {
  return port.loopback || port.tunnel || port.media === 'serial' ? 'point-to-point' : 'broadcast';
}
/** Interface OSPF settings for an interface that is newly enabled for OSPF. */
export function newOspfInterfaceSettings(port: NetworkInterface) {
  const s = port.ospfSettings ?? {};
  return {
    networkType: s.networkType ?? defaultOspfNetworkType(port),
    ...(s.cost !== undefined ? { cost: s.cost, autoCost: false } : {}),
    ...(s.priority !== undefined ? { priority: s.priority } : {}),
    ...(s.helloMs !== undefined ? { helloMs: s.helloMs } : {}),
    // IOS derives the dead interval from the hello interval unless it was configured.
    ...(s.deadMs !== undefined ? { deadMs: s.deadMs } : s.helloMs !== undefined ? { deadMs: s.helloMs * 4 } : {}),
  };
}

/** Re-evaluate IOS network statements after CLI or form edits without resetting unchanged adjacencies. */
export function refreshOspfConfiguration(e: SimulationEngine, d: Device) {
  const s = d.ospf;
  if (!s || (!s.networks && !(s.autoRouterId && s.routerId === '0.0.0.0'))) return;
  const id = s.autoRouterId && s.routerId === '0.0.0.0' ? selectOspfRouterId(d) : s.routerId;
  const manual = s.interfaces.filter((p) => !p.networkManaged);
  const interfaces = [...manual];
  for (const p of d.interfaces.filter(
    (p) => p.mode === 'routed' && p.ip && !manual.some((entry) => entry.port === p.id)
  )) {
    const network = s.networks?.find(
      (n) => ((ipNumber(p.ip!) ^ ipNumber(n.address)) & ~ipNumber(n.wildcard)) === 0
    );
    const existing = s.interfaces.find((entry) => entry.port === p.id);
    if (network)
      interfaces.push(
        (existing
          ? {
              ...existing,
              port: p.id,
              area: network.area,
              networkManaged: true,
              autoCost: existing.autoCost ?? true,
            }
          : {
              autoCost: true,
              ...newOspfInterfaceSettings(p),
              port: p.id,
              area: network.area,
              networkManaged: true,
            }) as (typeof s.interfaces)[number]
      );
  }
  if (id !== s.routerId || JSON.stringify(interfaces) !== JSON.stringify(s.interfaces)) {
    const {
      enabled,
      routerId,
      processId,
      autoRouterId,
      networks,
      areas,
      externalRoutes,
      maximumPaths,
      referenceBandwidth,
      passiveDefault,
      passiveOverrides,
      summaryRanges,
      defaultOriginate,
    } = s;
    configureOspf(e, d, {
      enabled: id !== '0.0.0.0' && (enabled || routerId === '0.0.0.0'),
      routerId: id,
      processId,
      autoRouterId,
      maximumPaths,
      referenceBandwidth,
      passiveDefault,
      passiveOverrides,
      summaryRanges,
      defaultOriginate,
      networks,
      areas,
      externalRoutes,
      interfaces,
    });
  }
}
export function selectOspfRouterId(d: Device) {
  const loopbacks = d.interfaces.filter((p) => p.loopback && p.ip && p.adminUp);
  return (
    (loopbacks.length ? loopbacks : d.interfaces.filter((p) => p.ip && p.adminUp))
      .map((p) => p.ip!)
      .sort((a, b) => ipNumber(b) - ipNumber(a))[0] ?? '0.0.0.0'
  );
}
function removeNeighbor(engine: SimulationEngine, device: Device, neighbor: OspfNeighbor, why: string) {
  device.ospf!.neighbors = device.ospf!.neighbors.filter((entry) => entry !== neighbor);
  engine.emit('OSPF_NEIGHBOR_CHANGED', device.id, `${neighbor.routerId}: ${neighbor.state} → Down; ${why}.`, {
    port: neighbor.port,
  });
}
export function ospfBfdDown(e: SimulationEngine, d: Device, port: string, ip: string) {
  for (const n of [...(d.ospf?.neighbors ?? [])])
    if (n.port === port && n.ip === ip) removeNeighbor(e, d, n, 'BFD Down');
  if (d.ospf?.enabled) {
    electOspfNeighbors(e, d);
    synchronizeOspf(e, d);
  }
}
export function handleOspfTick(engine: SimulationEngine, action: Extract<Action, { kind: 'ospf-tick' }>) {
  const device = engine.device(action.device),
    state = device.ospf;
  if (!state?.enabled || state.token !== action.token) return;
  for (const config of state.interfaces) {
    const port = device.interfaces.find((entry) => entry.id === config.port)!;
    const runtime = state.ports.find((entry) => entry.port === port.id)!;
    const operational =
      !!port.ip && port.prefix !== undefined && interfaceOperational(engine.state, device, port);
    const signature = `${port.ip}/${port.prefix}/${port.mtu}`;
    if (runtime.operational !== operational || runtime.signature !== signature) {
      for (const neighbor of [...state.neighbors].filter((entry) => entry.port === port.id))
        removeNeighbor(engine, device, neighbor, 'interface mudou');
      runtime.operational = operational;
      runtime.signature = signature;
      runtime.dr = runtime.bdr = '0.0.0.0';
      runtime.helloAt = engine.state.clock;
      runtime.waitUntil = engine.state.clock + (config.networkType === 'broadcast' ? config.deadMs : 0);
    }
  }
  for (const neighbor of [...state.neighbors])
    if (neighbor.deadAt <= engine.state.clock)
      removeNeighbor(engine, device, neighbor, 'Dead interval expirou');
  state.lsdb = state.lsdb.filter((lsa) => lsa.originatedAt + OSPF.maxAgeMs > engine.state.clock);
  electOspfNeighbors(engine, device);
  synchronizeOspf(engine, device);
  for (const runtime of state.ports) {
    const config = state.interfaces.find((entry) => entry.port === runtime.port)!;
    if (runtime.operational && !config.passive && runtime.helloAt <= engine.state.clock)
      sendOspfHello(
        engine,
        device,
        device.interfaces.find((entry) => entry.id === runtime.port)!
      );
  }
  for (const neighbor of state.neighbors) {
    if (neighbor.retryAt > engine.state.clock || ['Init', '2-Way'].includes(neighbor.state)) continue;
    if (neighbor.state !== 'Full') sendOspfDatabase(engine, device, neighbor);
    sendOspfRequests(engine, device, neighbor);
    for (const header of [...neighbor.pending]) {
      const lsa = state.lsdb.find(
        (entry) => lsaKey(entry) === header.key && entry.sequence >= header.sequence
      );
      if (lsa) sendOspfUpdate(engine, device, neighbor, lsa);
      else neighbor.pending = neighbor.pending.filter((entry) => entry.key !== header.key);
    }
    neighbor.retryAt = engine.state.clock + OSPF.retryMs;
  }
  state.tickAt = engine.state.clock + OSPF.tickMs;
  engine.schedule(OSPF.tickMs, { kind: 'ospf-tick', device: device.id, token: state.token });
}
export function receiveOspf(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  packet: OspfPacket,
  mac: string
) {
  const state = device.ospf,
    config = state?.interfaces.find((entry) => entry.port === port.id);
  if (!state?.enabled || !config || config.passive || !port.ip || port.prefix === undefined) return;
  if (port.bfd?.ospf && port.bfd.sessions.some((s) => s.ip === packet.src && s.hadUp && s.state !== 'Up'))
    return;
  const reject = (reason: string) => engine.drop(device, `OSPF: ${reason}.`, port.id);
  if (
    packet.bytes !==
      ospfBytes(packet.message) +
        (packet.authentication ? (packet.authentication.algorithm === 'md5' ? 16 : 40) : 0) ||
    packet.area !== config.area ||
    packet.routerId === state.routerId ||
    !sameSubnet(packet.src, port.ip, port.prefix) ||
    ![port.ip, OSPF.destination].includes(packet.dst) ||
    !ipNumber(packet.routerId)
  ) {
    reject('área, subnet, tamanho ou router ID incompatível');
    return;
  }
  const auth = packet.authentication,
    old = state.receivedSequences.find((r) => r.port === port.id && r.routerId === packet.routerId);
  if (
    (config.authenticationMode === 'md5' && !config.authenticationKey) ||
    (config.authenticationKey
      ? !auth ||
        (config.authenticationMode === 'md5'
          ? auth.algorithm !== 'md5' || auth.keyId !== (config.authenticationKeyId ?? 1)
          : auth.algorithm === 'md5') ||
        auth.digest !== ospfAuthenticator(packet, config.authenticationKey) ||
        (auth.algorithm === 'md5' && old && auth.sequence < old.sequence) ||
        (old && (old.seen.includes(auth.sequence) || (old.seen.length === 64 && auth.sequence < old.seen[0])))
      : !!auth)
  ) {
    reject('autenticação ou replay inválidos');
    return;
  }
  if (auth) {
    if (old) {
      old.sequence = Math.max(old.sequence, auth.sequence);
      old.seen = [...old.seen, auth.sequence].sort((a, b) => a - b).slice(-64);
      old.at = engine.state.clock;
    } else if (state.receivedSequences.length < 256)
      state.receivedSequences.push({
        port: port.id,
        routerId: packet.routerId,
        sequence: auth.sequence,
        seen: [auth.sequence],
        at: engine.state.clock,
      });
    else {
      reject('limite de origens autenticadas');
      return;
    }
  }
  const runtime = state.ports.find((entry) => entry.port === port.id)!;
  let neighbor = state.neighbors.find(
    (entry) => entry.port === port.id && entry.routerId === packet.routerId
  );
  const message = packet.message;
  engine.emit(
    'OSPF_RECEIVED',
    device.id,
    `OSPF ${message.type} de ${packet.routerId}, área ${packet.area}.`,
    { port: port.id }
  );
  if (message.type === 'hello') {
    if (
      (message.areaType ?? 'normal') !== ospfAreaType(device, config.area) ||
      message.prefix !== port.prefix ||
      message.helloMs !== config.helloMs ||
      message.deadMs !== config.deadMs ||
      message.networkType !== config.networkType
    ) {
      reject('Hello/dead interval, máscara ou tipo de rede incompatível');
      return;
    }
    if (neighbor && (neighbor.ip !== packet.src || neighbor.mac !== mac)) {
      reject('router ID duplicado no segmento');
      return;
    }
    if (!neighbor) {
      if (state.neighbors.length >= 256) {
        reject('limite de vizinhos');
        return;
      }
      neighbor = {
        port: port.id,
        area: packet.area,
        routerId: packet.routerId,
        ip: packet.src,
        mac,
        priority: message.priority,
        dr: message.dr,
        bdr: message.bdr,
        state: 'Init',
        lastSeen: engine.state.clock,
        deadAt: engine.state.clock + config.deadMs,
        exchange: engine.id('ospf-exchange'),
        receivedPages: [],
        requests: [],
        pending: [],
        retryAt: engine.state.clock + OSPF.retryMs,
      };
      state.neighbors.push(neighbor);
      engine.emit('OSPF_NEIGHBOR_CHANGED', device.id, `${neighbor.routerId}: Down → Init.`, {
        port: port.id,
      });
      sendOspfHello(engine, device, port);
    }
    Object.assign(neighbor, {
      lastSeen: engine.state.clock,
      deadAt: engine.state.clock + config.deadMs,
      priority: message.priority,
      dr: message.dr,
      bdr: message.bdr,
    });
    if (message.neighbors.includes(state.routerId)) {
      if (neighbor.state === 'Init') {
        ospfNeighborState(engine, device, neighbor, '2-Way');
        sendOspfHello(engine, device, port);
      }
      if (message.dr === neighbor.routerId || message.bdr === neighbor.routerId)
        runtime.waitUntil = engine.state.clock;
    } else if (neighbor.state !== 'Init') {
      resetOspfExchange(engine, neighbor);
      ospfNeighborState(engine, device, neighbor, 'Init');
    }
    electOspfNeighbors(engine, device);
    synchronizeOspf(engine, device);
    return;
  }
  if (
    !neighbor ||
    neighbor.ip !== packet.src ||
    neighbor.mac !== mac ||
    ['Init', '2-Way'].includes(neighbor.state)
  ) {
    reject('mensagem sem adjacência');
    return;
  }
  if (message.type === 'database') {
    if (message.mtu !== port.mtu || message.page >= message.pages) {
      reject('MTU ou página de descrição incompatível');
      return;
    }
    if (neighbor.remoteExchange !== message.exchange) {
      neighbor.remoteExchange = message.exchange;
      neighbor.receivedPages = [];
      neighbor.requests = [];
      ospfNeighborState(engine, device, neighbor, 'Exchange');
    }
    if (!message.reply && message.page === 0) sendOspfDatabase(engine, device, neighbor, true);
    if (neighbor.receivedPages.length && neighbor.pages !== message.pages) {
      reject('contagem de páginas mudou durante exchange');
      return;
    }
    neighbor.pages = message.pages;
    if (!neighbor.receivedPages.includes(message.page)) neighbor.receivedPages.push(message.page);
    for (const header of message.headers) {
      const local = state.lsdb.find((lsa) => lsaKey(lsa) === header.key);
      if (
        (!local || local.sequence < header.sequence) &&
        !neighbor.requests.some((entry) => entry.key === header.key)
      )
        neighbor.requests.push(header);
    }
    sendOspfRequests(engine, device, neighbor);
    finishOspfExchange(engine, device, neighbor);
  } else if (message.type === 'request') {
    for (const header of message.headers) {
      const lsa = state.lsdb.find(
        (entry) =>
          lsaKey(entry) === header.key && entry.sequence >= header.sequence && entry.area === config.area
      );
      if (lsa) sendOspfUpdate(engine, device, neighbor, lsa);
    }
  } else if (message.type === 'update') {
    const lsa = message.lsa,
      key = lsaKey(lsa);
    try {
      validateOspfLsa(lsa, engine.state.clock);
    } catch {
      reject('conteúdo de LSA inválido');
      return;
    }
    if (
      lsa.area !== config.area ||
      (ospfAreaType(device, config.area) === 'stub' &&
        ['external', 'nssa', 'asbr-summary'].includes(lsa.type)) ||
      (ospfAreaType(device, config.area) === 'nssa' && lsa.type === 'external') ||
      (ospfAreaType(device, config.area) !== 'nssa' && lsa.type === 'nssa') ||
      lsa.originatedAt > engine.state.clock ||
      lsa.originatedAt + OSPF.maxAgeMs <= engine.state.clock ||
      message.flush !== lsa.withdrawn
    ) {
      reject('LSA fora da área ou validade');
      return;
    }
    sendOspf(
      engine,
      device,
      port,
      { type: 'ack', header: { key, sequence: lsa.sequence, wire: ospfHeaderWire(lsa, engine.state.clock) } },
      neighbor
    );
    const local = state.lsdb.find((entry) => lsaKey(entry) === key);
    if (!local || local.sequence < lsa.sequence) {
      if (!local && state.lsdb.length >= 1024) {
        reject('LSDB cheia');
        return;
      }
      state.lsdb = state.lsdb.filter((entry) => lsaKey(entry) !== key);
      state.lsdb.push(structuredClone(lsa));
      floodOspf(engine, device, lsa, neighbor);
      engine.emit(
        'OSPF_LSA',
        device.id,
        `LSDB recebeu ${key}, sequência ${lsa.sequence}${lsa.withdrawn ? ', retirada' : ''}.`
      );
    } else if (local.sequence > lsa.sequence) sendOspfUpdate(engine, device, neighbor, local);
    neighbor.requests = neighbor.requests.filter(
      (entry) => entry.key !== key || entry.sequence > lsa.sequence
    );
    finishOspfExchange(engine, device, neighbor);
  } else
    neighbor.pending = neighbor.pending.filter(
      (entry) => entry.key !== message.header.key || entry.sequence !== message.header.sequence
    );
  synchronizeOspf(engine, device);
}
