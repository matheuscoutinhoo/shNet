import { multiSpanningTreeConfigSchema } from '../model';
import {
  stpScope,
  stpSchedule,
  isStpAction,
  withStpInstance,
  stpInstances,
  mstRegion,
  instancePort,
  portCarriesVlan,
} from './stp-scope';
import { switchingPorts } from './lacp-members';
import { interfaceOperational } from './layer3';
import { STP, type Action, type Bpdu, type Device, type Frame, type NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import {
  bridgeId,
  bridgeLabel,
  compareBridge,
  compareVector,
  portCost,
  type PriorityVector,
} from './stp-election';

function operational(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  return instancePort(device, port) && interfaceOperational(engine.state, device, port);
}

function cancelTransition(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'stp-transition' ||
      action.device !== device.id ||
      action.port !== port.id ||
      (action.instance ?? 0) !== stpScope(device)
  );
  if (port.spanningTree) delete port.spanningTree.transitionAt;
}
function forgetInfo(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      action.kind !== 'stp-info-expire' ||
      action.device !== device.id ||
      action.port !== port.id ||
      (action.instance ?? 0) !== stpScope(device)
  );
  if (port.spanningTree) delete port.spanningTree.received;
}

function topologyChange(engine: SimulationEngine, device: Device, receivedId?: string) {
  const tree = device.spanningTree!;
  const changeId = receivedId ?? engine.id('stp-change');
  if (tree.seenChanges.includes(changeId)) return false;
  tree.seenChanges.push(changeId);
  if (tree.seenChanges.length > 64) tree.seenChanges.shift();
  tree.changeId = changeId;
  tree.changeUntil = engine.state.clock + STP.hello * 2;
  tree.changes++;
  const boundaryChange =
    device.multiSpanningTree?.mode === 'mstp' &&
    stpScope(device) === 0 &&
    device.interfaces.some((port) => port.mstBoundary);
  device.macTable = boundaryChange
    ? []
    : device.macTable.filter(
        (m) =>
          stpScope(device) !==
          (device.multiSpanningTree?.mode === 'pvst'
            ? m.vlan
            : (device.multiSpanningTree?.mappings.find((x) => x.vlan === m.vlan)?.instance ?? 0))
      );
  engine.emit(
    'STP_TOPOLOGY_CHANGED',
    device.id,
    'Mudança de topologia: tabela MAC limpa para reaprender o caminho.'
  );
  return true;
}

function setState(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  state: 'discarding' | 'learning' | 'forwarding'
) {
  const current = port.spanningTree!;
  if (current.state === state) return;
  const wasForwarding = current.state === 'forwarding';
  current.state = state;
  engine.emit('STP_PORT_CHANGED', device.id, port.name + ': ' + current.role + ' / ' + state + '.', {
    port: port.id,
  });
  if (!port.stpEdge && (wasForwarding || state === 'forwarding')) topologyChange(engine, device);
}

function beginTransition(engine: SimulationEngine, device: Device, port: NetworkInterface) {
  cancelTransition(engine, device, port);
  const current = port.spanningTree!;
  current.token = engine.id('stp-port');
  current.agreed = false;
  current.proposed = device.spanningTree!.mode === 'rstp';
  setState(engine, device, port, 'discarding');
  if (!current.operational || current.role === 'alternate' || current.role === 'disabled') return;
  if (port.stpEdge && !current.received) {
    setState(engine, device, port, 'forwarding');
    return;
  }
  current.transitionAt = engine.state.clock + STP.forwardDelay;
  stpSchedule(engine, STP.forwardDelay, {
    kind: 'stp-transition',
    device: device.id,
    port: port.id,
    token: current.token,
    state: 'learning',
  });
}

function message(engine: SimulationEngine, device: Device, port: NetworkInterface, agreement = false): Bpdu {
  const tree = device.spanningTree!;
  const rootPort = device.interfaces.find((entry) => entry.id === tree.rootPort)?.spanningTree?.received;
  const age = rootPort ? rootPort.bpdu.age + engine.state.clock - rootPort.at + 1000 : 0;
  return {
    mode: tree.mode,
    ...(device.multiSpanningTree
      ? { domain: device.multiSpanningTree.mode, instance: stpScope(device), region: mstRegion(device) }
      : {}),
    root: tree.root,
    cost: tree.cost,
    bridge: bridgeId(device),
    portId: device.interfaces.indexOf(port) + 1,
    age: Math.min(STP.maxAge, age),
    proposal:
      !agreement &&
      tree.mode === 'rstp' &&
      port.duplex === 'full' &&
      port.spanningTree!.role === 'designated' &&
      port.spanningTree!.state !== 'forwarding',
    agreement,
    ...(tree.changeId && tree.changeUntil > engine.state.clock ? { changeId: tree.changeId } : {}),
  };
}

function send(engine: SimulationEngine, device: Device, port: NetworkInterface, agreement = false) {
  if (!port.spanningTree?.operational) return;
  const bpdu = message(engine, device, port, agreement);
  if (bpdu.age >= STP.maxAge) return;
  const vlan = bpdu.domain === 'pvst' && bpdu.instance ? bpdu.instance : undefined;
  const frame: Frame = {
    src: port.mac,
    dst: bpdu.domain === 'pvst' && bpdu.instance ? STP.pvstDestination : STP.destination,
    etherType: 'STP',
    bpdu,
    hops: 1,
    ...(vlan && port.mode === 'trunk' && port.nativeVlan !== vlan ? { vlan } : {}),
  };
  engine.emit(
    'BPDU_SENT',
    device.id,
    (agreement ? 'Agreement' : bpdu.proposal ? 'Proposal' : 'Hello') +
      ': root ' +
      bridgeLabel(bpdu.root) +
      ', custo ' +
      bpdu.cost +
      '.',
    { port: port.id, frame }
  );
  engine.sendFrame(device.id, port.id, frame);
}

function advertise(engine: SimulationEngine, device: Device) {
  for (const port of switchingPorts(device))
    if (port.spanningTree?.role === 'designated') send(engine, device, port);
}

function recompute(engine: SimulationEngine, device: Device) {
  const tree = device.spanningTree!;
  const own = bridgeId(device);
  let best: PriorityVector = { root: own, cost: 0, bridge: own, portId: 0, localPort: 0 };
  let rootPort: string | undefined;
  for (const port of switchingPorts(device)) {
    const index = device.interfaces.indexOf(port);
    const received = port.spanningTree?.received;
    if (!port.spanningTree?.operational || !received || received.expiresAt <= engine.state.clock) continue;
    const candidate: PriorityVector = {
      root: received.bpdu.root,
      cost: Math.min(4294967295, received.bpdu.cost + portCost(port)),
      bridge: received.bpdu.bridge,
      portId: received.bpdu.portId,
      localPort: index + 1,
    };
    if (compareVector(candidate, best) < 0) {
      best = candidate;
      rootPort = port.id;
    }
  }
  const changedRoot =
    compareBridge(tree.root, best.root) !== 0 || tree.cost !== best.cost || tree.rootPort !== rootPort;
  tree.root = structuredClone(best.root);
  tree.cost = best.cost;
  if (rootPort) tree.rootPort = rootPort;
  else delete tree.rootPort;
  if (changedRoot) {
    topologyChange(engine, device);
    engine.emit(
      'STP_ROOT_CHANGED',
      device.id,
      'Root ' +
        bridgeLabel(tree.root) +
        '; custo ' +
        tree.cost +
        (rootPort
          ? '; root port ' + device.interfaces.find((port) => port.id === rootPort)!.name
          : '; este switch é a raiz.')
    );
  }
  let changed = changedRoot;
  for (const port of switchingPorts(device)) {
    const index = device.interfaces.indexOf(port);
    const current = port.spanningTree!;
    const previousRole = current.role;
    const received = current.received;
    let role: typeof current.role = !current.operational
      ? 'disabled'
      : port.id === rootPort
        ? 'root'
        : 'designated';
    if (role === 'designated' && received) {
      const local = {
        root: tree.root,
        cost: tree.cost,
        bridge: own,
        portId: index + 1,
        localPort: index + 1,
      };
      const remote = { ...received.bpdu, localPort: index + 1 };
      if (compareVector(local, remote) > 0) role = 'alternate';
    }
    current.role = role;
    if (role !== previousRole || (changedRoot && !port.stpEdge)) {
      changed = true;
      beginTransition(engine, device, port);
      engine.emit('STP_PORT_CHANGED', device.id, port.name + ': papel ' + role + '.', { port: port.id });
      if (
        tree.mode === 'rstp' &&
        port.duplex === 'full' &&
        role === 'root' &&
        previousRole === 'alternate' &&
        received?.bpdu.mode === 'rstp'
      ) {
        cancelTransition(engine, device, port);
        current.agreed = true;
        setState(engine, device, port, 'forwarding');
        send(engine, device, port, true);
      }
    }
  }
  return changed;
}

function refreshDevice(engine: SimulationEngine, device: Device) {
  if (!device.spanningTree?.enabled) return;
  let changed = false;
  for (const port of switchingPorts(device)) {
    const current = port.spanningTree!;
    const up = operational(engine, device, port);
    if (up !== current.operational) {
      changed = true;
      current.operational = up;
      forgetInfo(engine, device, port);
      beginTransition(engine, device, port);
    }
    if (current.received && current.received.expiresAt <= engine.state.clock) {
      forgetInfo(engine, device, port);
      changed = true;
    }
  }
  if (changed) {
    recompute(engine, device);
    advertise(engine, device);
  }
}

function configureClassic(
  engine: SimulationEngine,
  device: Device,
  mode: 'off' | 'stp' | 'rstp',
  priority = device.spanningTree?.priority ?? 32768
) {
  if (device.type !== 'switch') throw new Error('Spanning tree exige um switch.');
  if (
    !['off', 'stp', 'rstp'].includes(mode) ||
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 61440 ||
    priority % 4096
  )
    throw new Error('Modo STP inválido ou prioridade fora dos múltiplos de 4096 (0 a 61440).');
  engine.state.queue = engine.state.queue.filter(
    ({ action }) =>
      !(
        (action.kind === 'stp-hello' ||
          action.kind === 'stp-transition' ||
          action.kind === 'stp-info-expire') &&
        action.device === device.id &&
        (action.instance ?? 0) === stpScope(device)
      )
  );
  for (const port of switchingPorts(device)) delete port.spanningTree;
  device.macTable = [];
  if (mode === 'off') {
    delete device.spanningTree;
    engine.emit('CONFIG_CHANGED', device.id, 'Spanning tree desabilitado.');
    return;
  }
  const token = engine.id('stp');
  device.spanningTree = {
    enabled: true,
    mode,
    ...(stpScope(device) ? { instance: stpScope(device) } : {}),
    priority,
    root: {
      priority,
      mac: device.interfaces[0].mac.toLowerCase(),
      ...(stpScope(device) ? { instance: stpScope(device) } : {}),
    },
    cost: 0,
    token,
    helloAt: engine.state.clock + STP.hello,
    changes: 0,
    changeUntil: 0,
    seenChanges: [],
  };
  for (const port of switchingPorts(device)) {
    const up = operational(engine, device, port);
    port.spanningTree = {
      role: up ? 'designated' : 'disabled',
      state: 'discarding',
      operational: up,
      token: engine.id('stp-port'),
    };
    beginTransition(engine, device, port);
  }
  advertise(engine, device);
  stpSchedule(engine, STP.hello, { kind: 'stp-hello', device: device.id, token });
  engine.emit('CONFIG_CHANGED', device.id, mode.toUpperCase() + ' habilitado; prioridade ' + priority + '.');
}

function receiveClassic(engine: SimulationEngine, device: Device, port: NetworkInterface, frame: Frame) {
  const tree = device.spanningTree;
  const bpdu = frame.bpdu;
  if (
    !tree?.enabled ||
    !bpdu ||
    frame.dst !== (bpdu.domain === 'pvst' && bpdu.instance ? STP.pvstDestination : STP.destination) ||
    bpdu.age >= STP.maxAge
  )
    return;
  const current = port.spanningTree!;
  engine.emit(
    'BPDU_RECEIVED',
    device.id,
    'BPDU recebido: root ' + bridgeLabel(bpdu.root) + ', custo ' + bpdu.cost + '.',
    { port: port.id, frame }
  );
  const wasEdge = port.stpEdge && !current.received;
  forgetInfo(engine, device, port);
  current.received = {
    bpdu: structuredClone(bpdu),
    at: engine.state.clock,
    expiresAt:
      engine.state.clock +
      Math.min(
        STP.maxAge - bpdu.age,
        tree.mode === 'rstp' && bpdu.mode === 'rstp' ? STP.rapidAge : STP.maxAge
      ),
  };
  stpSchedule(engine, current.received.expiresAt - engine.state.clock, {
    kind: 'stp-info-expire',
    device: device.id,
    port: port.id,
    expiresAt: current.received.expiresAt,
  });
  if (wasEdge) beginTransition(engine, device, port);
  let changed = recompute(engine, device);
  if (bpdu.changeId) changed = topologyChange(engine, device, bpdu.changeId) || changed;
  if (tree.mode === 'rstp' && bpdu.mode === 'rstp' && port.duplex === 'full') {
    if (current.role === 'root' && bpdu.proposal) {
      for (const other of switchingPorts(device)) {
        if (other.id !== port.id && other.spanningTree?.role === 'designated' && !other.stpEdge)
          beginTransition(engine, device, other);
      }
      cancelTransition(engine, device, port);
      current.agreed = true;
      setState(engine, device, port, 'forwarding');
      send(engine, device, port, true);
      changed = true;
    } else if (
      current.role === 'designated' &&
      bpdu.agreement &&
      compareBridge(bpdu.root, tree.root) === 0 &&
      bpdu.cost >= tree.cost
    ) {
      cancelTransition(engine, device, port);
      current.agreed = true;
      setState(engine, device, port, 'forwarding');
    }
  }
  if (changed) advertise(engine, device);
}

function handleClassic(
  engine: SimulationEngine,
  action: Extract<Action, { kind: 'stp-hello' | 'stp-transition' | 'stp-info-expire' }>
) {
  const device = engine.device(action.device);
  const tree = device.spanningTree;
  if (!tree?.enabled) return;
  if (action.kind === 'stp-hello') {
    if (action.token !== tree.token) return;
    refreshDevice(engine, device);
    recompute(engine, device);
    advertise(engine, device);
    tree.helloAt = engine.state.clock + STP.hello;
    stpSchedule(engine, STP.hello, { kind: 'stp-hello', device: device.id, token: tree.token });
  } else if (action.kind === 'stp-info-expire') {
    const port = device.interfaces.find((entry) => entry.id === action.port);
    if (port?.spanningTree?.received?.expiresAt !== action.expiresAt) return;
    forgetInfo(engine, device, port);
    recompute(engine, device);
    advertise(engine, device);
  } else {
    const port = device.interfaces.find((entry) => entry.id === action.port);
    const current = port?.spanningTree;
    if (
      !port ||
      !current ||
      current.token !== action.token ||
      !current.operational ||
      !['root', 'designated'].includes(current.role)
    )
      return;
    delete current.transitionAt;
    setState(engine, device, port, action.state);
    if (action.state === 'learning') {
      current.transitionAt = engine.state.clock + STP.forwardDelay;
      stpSchedule(engine, STP.forwardDelay, { ...action, state: 'forwarding' });
    } else advertise(engine, device);
  }
}

export function refreshSpanningTree(e: SimulationEngine) {
  for (const d of e.state.devices)
    for (const id of stpInstances(d)) withStpInstance(d, id, () => refreshDevice(e, d));
}
export function multiStpConfig(d: Device) {
  const c = d.multiSpanningTree;
  return c
    ? {
        mode: c.mode,
        region: c.region,
        revision: c.revision,
        priorities: structuredClone(c.priorities),
        mappings: structuredClone(c.mappings),
      }
    : undefined;
}
export function rebuildSpanningTree(e: SimulationEngine, d: Device) {
  const c = multiStpConfig(d);
  if (c) configureMultiSpanningTree(e, d, c);
  else if (d.spanningTree?.enabled) configureSpanningTree(e, d, d.spanningTree.mode, d.spanningTree.priority);
}
export function configureSpanningTree(
  e: SimulationEngine,
  d: Device,
  mode: 'off' | 'stp' | 'rstp',
  priority?: number
) {
  if (
    !['off', 'stp', 'rstp'].includes(mode) ||
    (priority !== undefined &&
      (!Number.isInteger(priority) || priority < 0 || priority > 61440 || priority % 4096))
  )
    throw new Error('Modo STP inválido ou prioridade fora dos múltiplos de 4096 (0 a 61440).');
  e.state.queue = e.state.queue.filter(({ action }) => !isStpAction(action) || action.device !== d.id);
  delete d.multiSpanningTree;
  for (const p of d.interfaces) {
    delete p.spanningInstances;
    delete p.mstBoundary;
  }
  configureClassic(e, d, mode, priority);
}
export function configureMultiSpanningTree(e: SimulationEngine, d: Device, input: unknown) {
  if (d.type !== 'switch') throw new Error('PVST/MSTP exige switch.');
  const c = multiSpanningTreeConfigSchema.parse(input);
  const ids =
    c.mode === 'pvst'
      ? d.vlans.map((v) => v.id)
      : [...new Set(c.mappings.map((m) => m.instance))].filter(Boolean);
  if (
    ids.length > 64 ||
    new Set(c.priorities.map((p) => p.instance)).size !== c.priorities.length ||
    new Set(c.mappings.map((m) => m.vlan)).size !== c.mappings.length ||
    c.mappings.some((m) => !d.vlans.some((v) => v.id === m.vlan)) ||
    c.priorities.some((p) => p.instance !== 0 && !ids.includes(p.instance)) ||
    (c.mode === 'pvst' && c.mappings.length)
  )
    throw new Error('Instâncias, prioridades ou mapeamento VLAN STP inválidos.');
  configureSpanningTree(e, d, 'off');
  d.multiSpanningTree = { ...c, instances: [] };
  configureClassic(e, d, 'rstp', c.priorities.find((p) => p.instance === 0)?.priority ?? 32768);
  // Allocate independent persisted trees before entering their election scope.
  for (const id of ids) d.multiSpanningTree!.instances.push({ id, tree: structuredClone(d.spanningTree!) });
  for (const id of ids)
    withStpInstance(d, id, () =>
      configureClassic(e, d, 'rstp', c.priorities.find((p) => p.instance === id)?.priority ?? 32768)
    );
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    c.mode.toUpperCase() + ': ' + ids.length + ' instâncias, eleição por BPDUs e encaminhamento por VLAN.'
  );
}
export function receiveBpdu(e: SimulationEngine, d: Device, p: NetworkInterface, f: Frame) {
  const b = f.bpdu;
  if (!b || !d.spanningTree?.enabled) return;
  if (!b.instance) {
    if (d.multiSpanningTree?.mode === 'mstp') {
      const boundary = b.domain !== 'mstp' || b.region !== mstRegion(d);
      if (p.mstBoundary !== boundary) {
        p.mstBoundary = boundary;
        for (const id of stpInstances(d).filter(Boolean)) withStpInstance(d, id, () => refreshDevice(e, d));
      }
    }
    withStpInstance(d, 0, () => receiveClassic(e, d, p, f));
    return;
  }
  if (
    d.multiSpanningTree?.mode !== b.domain ||
    !d.multiSpanningTree?.instances.some((i) => i.id === b.instance)
  )
    return;
  if (b.domain === 'pvst') {
    const vlan = p.mode === 'trunk' ? (f.vlan ?? p.nativeVlan) : p.accessVlan;
    if (vlan !== b.instance || !portCarriesVlan(p, vlan)) return;
  } else if (b.region !== mstRegion(d) || p.mstBoundary) return;
  withStpInstance(d, b.instance, () => {
    if (p.spanningTree?.operational) receiveClassic(e, d, p, f);
  });
}
export function handleSpanningTreeAction(
  e: SimulationEngine,
  a: Extract<Action, { kind: 'stp-hello' | 'stp-transition' | 'stp-info-expire' }>
) {
  const d = e.device(a.device),
    id = a.instance ?? 0;
  if (id && !d.multiSpanningTree?.instances.some((i) => i.id === id)) return;
  withStpInstance(d, id, () => handleClassic(e, a));
}
