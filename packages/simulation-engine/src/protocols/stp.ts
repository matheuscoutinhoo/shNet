import { protocolDevices, invalidateProtocolIndex } from '../core/protocol-index';
import { multiSpanningTreeConfigSchema } from '../model';
import {
  stpScope,
  stpSchedule,
  isStpAction,
  withStpInstance,
  stpInstances,
  mstRegion,
  stpCommonTree,
  stpCommonPort,
  instancePort,
  portCarriesVlan,
  stpVlanInstance,
} from './stp-scope';
import { switchingPorts } from './lacp-members';
import { interfaceOperational } from './layer3';
import {
  STP,
  type Action,
  type Bpdu,
  type Device,
  type Frame,
  type NetworkInterface,
  type Snapshot,
} from '../model';
import type { SimulationEngine } from '../core/engine';
const refreshBounds = new WeakMap<Snapshot, number>();
export function invalidateSpanningRefresh(snapshot: Snapshot) {
  refreshBounds.delete(snapshot);
}
function noteExpiry(snapshot: Snapshot, at: number) {
  const next = refreshBounds.get(snapshot);
  if (next !== undefined && at < next) refreshBounds.set(snapshot, at);
}
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
function expireInfo(engine:SimulationEngine,device:Device,port:NetworkInterface){
  const current=port.spanningTree;
  if(current?.operational&&!port.stpEdge&&(port.stpGuard==='loop'||device.loopGuardDefault)&&['root','alternate'].includes(current.role))current.guardInconsistent='loop';
  forgetInfo(engine,device,port);
}

function topologyChange(
  engine: SimulationEngine,
  device: Device,
  receivedId?: string,
  receivedPort?: string
) {
  const tree = device.spanningTree!;
  const active = tree.changeUntil > engine.state.clock;
  // Coalesce designated advertisements during tcWhile, while retaining the
  // upstream notification for a new local transition on the current path.
  const changeId = receivedId ?? engine.id('stp-change');
  const seen = !!receivedId && tree.seenChanges.includes(changeId);
  if (!seen && !tree.seenChanges.includes(changeId)) {
    tree.seenChanges.push(changeId);
    if (tree.seenChanges.length > 64) tree.seenChanges.shift();
  }
  if (!seen) tree.changeId = changeId;
  if (!active && !seen) {
    tree.changeId = changeId;
    tree.changeUntil = engine.state.clock + STP.hello * 2;
  }
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
  // RSTP propagates TC upstream as well as down designated segments. Without
  // this notification the root retains MACs on the failed access path.
  if (!seen && tree.mode === 'rstp') {
    const root = device.interfaces.find((port) => port.id === tree.rootPort);
    if (root && root.id !== receivedPort) send(engine, device, root, false, changeId);
  }
  return !active && !seen;
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
  // Local FDB entries on a disabled/blocked port cannot remain usable until
  // remote TC propagation completes. Preserve unrelated MST/PVST scopes.
  if (state !== 'forwarding')
    device.macTable = device.macTable.filter(
      (m) =>
        m.port !== port.id ||
        (current.operational && !port.mstBoundary && stpVlanInstance(device, m.vlan) !== stpScope(device))
    );
  engine.emit('STP_PORT_CHANGED', device.id, port.name + ': ' + current.role + ' / ' + state + '.', {
    port: port.id,
  });
  if (!port.stpEdge && (state === 'forwarding' || (device.spanningTree!.mode === 'stp' && wasForwarding)))
    topologyChange(engine, device);
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
    portState:port.spanningTree!.state,
    role: port.spanningTree!.role,
    ...(tree.changeId && tree.changeUntil > engine.state.clock ? { changeId: tree.changeId } : {}),
  };
}
function mstMessage(e:SimulationEngine,d:Device,p:NetworkInterface,b:Bpdu):Bpdu['mst']{
 const c=d.multiSpanningTree;if(c?.mode!=='mstp')return;const tree=stpCommonTree(d)!,state=stpCommonPort(d,p)!,rootPort=d.interfaces.find(p=>p.id===tree.rootPort),received=rootPort&&stpCommonPort(d,rootPort)?.received,sameRegion=received?.bpdu.region===mstRegion(d),prior=sameRegion?received.bpdu.mst?.cist:undefined;
 const flags=(s:NonNullable<NetworkInterface['spanningTree']>,t:NonNullable<Device['spanningTree']>,agree:boolean)=>({proposal:!agree&&s.role==='designated'&&s.state!=='forwarding'&&p.duplex==='full',agreement:agree,role:s.role,portState:s.state,change:!!t.changeId&&t.changeUntil>e.state.clock,...(t.changeId&&t.changeUntil>e.state.clock?{changeId:t.changeId}:{})});
 const external=rootPort?(sameRegion?prior?.cost??0:tree.cost):0;
 return {name:c.region,revision:c.revision,digest:JSON.parse(mstRegion(d)!)[2],cist:{root:tree.root,regionalRoot:prior?.regionalRoot??bridgeId({...d,spanningTree:tree}),cost:external,internalCost:Math.max(0,tree.cost-external),bridge:bridgeId({...d,spanningTree:tree}),portId:d.interfaces.indexOf(p)+1,age:Math.min(STP.maxAge,received?received.bpdu.age+e.state.clock-received.at+1000:0),remainingHops:prior?Math.max(1,prior.remainingHops-1):20,...flags(state,tree,stpScope(d)===0?b.agreement:!!state.agreed)},records:c.instances.flatMap(i=>{const s=stpScope(d)===i.id?p.spanningTree:p.spanningInstances?.find(x=>x.id===i.id)?.state,t=stpScope(d)===i.id?d.spanningTree!:i.tree;if(!s?.operational)return [];const rp=d.interfaces.find(p=>p.id===t.rootPort),previous=rp&&(stpScope(d)===i.id?rp.spanningTree:rp.spanningInstances?.find(x=>x.id===i.id)?.state)?.received?.bpdu.mst?.records.find(r=>r.instance===i.id);return [{instance:i.id,root:t.root,cost:t.cost,bridgePriority:t.priority,portPriority:128,remainingHops:previous?Math.max(1,previous.remainingHops-1):20,...flags(s,t,stpScope(d)===i.id?b.agreement:!!s.agreed)}];})};
}

function send(
  engine: SimulationEngine,
  device: Device,
  port: NetworkInterface,
  agreement = false,
  changeId?: string
) {
  if (!port.spanningTree?.operational) return;
  const bpdu = { ...message(engine, device, port, agreement), ...(changeId ? { changeId } : {}) };
  if(bpdu.domain==='mstp')bpdu.mst=mstMessage(engine,device,port,bpdu);
  if (bpdu.age >= STP.maxAge) return;
  // Six BPDUs per one-second window, per instance/port. Coalesce deferred
  // announcements and construct them from current information at transmission.
  const tx = (port.spanningTree.transmit ??= { count: 0, windowStart: engine.state.clock });
  if (engine.state.clock >= tx.windowStart + 1000) {
    tx.count = 0;
    tx.windowStart = engine.state.clock;
  }
  if (tx.count >= 6) {
    tx.agreement = tx.agreement || agreement;
    if (changeId) tx.pendingChangeId = changeId;
    if (tx.pendingAt === undefined) {
      tx.pendingAt = tx.windowStart + 1000;
      stpSchedule(engine, tx.pendingAt - engine.state.clock, {
        kind: 'stp-transmit',
        device: device.id,
        port: port.id,
        at: tx.pendingAt,
      });
    }
    return;
  }
  tx.count++;
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
    if (port.stpGuard==='root'||port.spanningTree?.guardInconsistent==='loop'||!port.spanningTree?.operational || !received || received.expiresAt <= engine.state.clock) continue;
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
    if (tree.mode === 'stp') topologyChange(engine, device);
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
    if(current.guardInconsistent==='loop'&&port.stpGuard!=='loop'&&!device.loopGuardDefault)delete current.guardInconsistent;
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
      if(port.stpGuard==='root'&&role==='alternate')current.guardInconsistent='root';else if(current.guardInconsistent==='root')delete current.guardInconsistent;
    }
    else if(current.guardInconsistent==='root')delete current.guardInconsistent;
    if(current.guardInconsistent==='loop'&&current.operational)role='alternate';
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
      if(!up)delete current.guardInconsistent;
      expireInfo(engine, device, port);
      beginTransition(engine, device, port);
    }
    if (current.received && current.received.expiresAt <= engine.state.clock) {
      expireInfo(engine, device, port);
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
  invalidateProtocolIndex(engine.state);
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
          action.kind === 'stp-info-expire' ||
          action.kind === 'stp-transmit') &&
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
  if(current.guardInconsistent==='loop')delete current.guardInconsistent;
  engine.emit(
    'BPDU_RECEIVED',
    device.id,
    'BPDU recebido: root ' + bridgeLabel(bpdu.root) + ', custo ' + bpdu.cost + '.',
    { port: port.id, frame }
  );
  const changedTopology = bpdu.changeId ? topologyChange(engine, device, bpdu.changeId, port.id) : false;
  // An agreement acknowledges our designated information. It must not become
  // a new root candidate: the peer's cost may have been learned through us.
  if (bpdu.agreement && tree.mode === 'rstp' && bpdu.mode === 'rstp' && port.duplex === 'full') {
    if (
      current.role === 'designated' &&
      compareBridge(bpdu.root, tree.root) === 0 &&
      bpdu.cost >= tree.cost
    ) {
      cancelTransition(engine, device, port);
      current.agreed = true;
      setState(engine, device, port, 'forwarding');
    } else if (current.role === 'designated') send(engine, device, port);
    if (changedTopology) advertise(engine, device);
    return;
  }
  // Root/alternate role flags carry notifications, not designated information.
  // Recording an upstream TC as a root candidate feeds the dead root back into
  // its former parent and delays recovery until information expires.
  if (bpdu.role && bpdu.role !== 'designated') {
    if (current.role === 'designated') send(engine, device, port);
    if (changedTopology) advertise(engine, device);
    return;
  }
  // Inferior information on our designated segment cannot replace our own
  // designated information. Reply with the superior vector. Inferior updates
  // from the current root/designated neighbor are still accepted below.
  const local = {
    root: tree.root,
    cost: tree.cost,
    bridge: bridgeId(device),
    portId: device.interfaces.indexOf(port) + 1,
    localPort: 0,
  };
  if (current.role === 'designated' && compareVector(local, { ...bpdu, localPort: 0 }) < 0) {
    send(engine, device, port);
    if (changedTopology) advertise(engine, device);
    return;
  }
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
  noteExpiry(engine.state, current.received.expiresAt);
  stpSchedule(engine, current.received.expiresAt - engine.state.clock, {
    kind: 'stp-info-expire',
    device: device.id,
    port: port.id,
    expiresAt: current.received.expiresAt,
  });
  if (wasEdge) beginTransition(engine, device, port);
  let changed = recompute(engine, device) || changedTopology;
  if (tree.mode === 'rstp' && bpdu.mode === 'rstp' && port.duplex === 'full') {
    if (current.role === 'root' && bpdu.proposal) {
      if (!current.agreed)
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
  action: Extract<Action, { kind: 'stp-hello' | 'stp-transition' | 'stp-info-expire' | 'stp-transmit' }>
) {
  const device = engine.device(action.device);
  const tree = device.spanningTree;
  if (!tree?.enabled) return;
  if (action.kind === 'stp-transmit') {
    const port = device.interfaces.find((entry) => entry.id === action.port);
    const tx = port?.spanningTree?.transmit;
    if (!port || tx?.pendingAt !== action.at) return;
    const agreement = tx.agreement && port.spanningTree!.role === 'root';
    const changeId = tx.pendingChangeId;
    delete tx.pendingAt;
    delete tx.agreement;
    delete tx.pendingChangeId;
    if (
      agreement ||
      port.spanningTree!.role === 'designated' ||
      (port.spanningTree!.role === 'root' && tree.changeUntil > engine.state.clock)
    )
      send(engine, device, port, !!agreement, changeId);
  } else if (action.kind === 'stp-hello') {
    if (action.token !== tree.token) return;
    refreshDevice(engine, device);
    recompute(engine, device);
    advertise(engine, device);
    tree.helloAt = engine.state.clock + STP.hello;
    stpSchedule(engine, STP.hello, { kind: 'stp-hello', device: device.id, token: tree.token });
  } else if (action.kind === 'stp-info-expire') {
    const port = device.interfaces.find((entry) => entry.id === action.port);
    if (port?.spanningTree?.received?.expiresAt !== action.expiresAt) return;
    expireInfo(engine, device, port);
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
  if ((refreshBounds.get(e.state) ?? -Infinity) > e.state.clock) return;
  let next = Infinity;
  for (const d of protocolDevices(e.state, 'stp'))
    for (const id of stpInstances(d))
      withStpInstance(d, id, () => {
        refreshDevice(e, d);
        for (const port of switchingPorts(d))
          if (port.spanningTree?.received) next = Math.min(next, port.spanningTree.received.expiresAt);
      });
  refreshBounds.set(e.state, next);
}
export function multiStpConfig(d: Device) {
  const c = d.multiSpanningTree;
  return c
    ? {
        mode: c.mode,
        ...(c.protocol ? { protocol: c.protocol } : {}),
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
/** Catalyst IOS XE boots with Rapid PVST+ on every VLAN unless configured otherwise. */
export function applyDefaultSpanningTree(e: SimulationEngine, d: Device) {
  if (d.type !== 'switch' || d.spanningTree || d.multiSpanningTree) return;
  configureMultiSpanningTree(e, d, { mode: 'pvst', protocol: 'rstp', mappings: [], priorities: [] });
}
/**
 * PVST runs one tree per VLAN. Creating or deleting a VLAN adds or removes only that
 * VLAN's tree, so the remaining VLANs keep their roles, states and timers (as on IOS).
 */
export function syncPvstInstances(e: SimulationEngine, d: Device) {
  const c = d.multiSpanningTree;
  if (c?.mode !== 'pvst' || !d.spanningTree?.enabled || stpScope(d)) return false;
  const wanted = new Set(d.vlans.map((v) => v.id));
  let changed = false;
  for (const stale of c.instances.filter((i) => !wanted.has(i.id))) {
    e.state.queue = e.state.queue.filter(
      ({ action }) => !(isStpAction(action) && action.device === d.id && (action.instance ?? 0) === stale.id)
    );
    c.instances = c.instances.filter((i) => i.id !== stale.id);
    for (const p of d.interfaces)
      if (p.spanningInstances) p.spanningInstances = p.spanningInstances.filter((i) => i.id !== stale.id);
    changed = true;
  }
  const missing = d.vlans.map((v) => v.id).filter((id) => !c.instances.some((i) => i.id === id));
  if (c.instances.length + missing.length > 64)
    throw new Error('Spanning tree instance limit exceeded: this model supports up to 64 PVST VLANs.');
  for (const id of missing) {
    invalidateProtocolIndex(e.state);
    c.instances.push({ id, tree: structuredClone(d.spanningTree) });
    withStpInstance(d, id, () =>
      configureClassic(e, d, c.protocol ?? 'rstp', c.priorities.find((p) => p.instance === id)?.priority ?? 32768)
    );
    changed = true;
  }
  if (changed) invalidateSpanningRefresh(e.state);
  return changed;
}
export function updateSpanningTreePort(
  e: SimulationEngine,
  d: Device,
  p: NetworkInterface,
  edgeChanged = false
) {
  for (const id of stpInstances(d))
    withStpInstance(d, id, () => {
      if (!d.spanningTree?.enabled || !p.spanningTree || !instancePort(d, p)) return;
      refreshDevice(e, d);
      // Election consumes the new cost. Unchanged roles retain their agreements/timers.
      const changed = recompute(e, d);
      if (
        p.spanningTree.operational &&
        !p.spanningTree.received &&
        p.stpEdge &&
        p.spanningTree.state !== 'forwarding'
      )
        beginTransition(e, d, p);
      else if (
        edgeChanged &&
        p.spanningTree.operational &&
        !p.stpEdge &&
        !p.spanningTree.received &&
        p.spanningTree.state === 'forwarding'
      )
        beginTransition(e, d, p);
      if (changed || p.spanningTree.operational) advertise(e, d);
    });
}
export function configureSpanningTree(
  e: SimulationEngine,
  d: Device,
  mode: 'off' | 'stp' | 'rstp',
  priority?: number
) {
  invalidateProtocolIndex(e.state);
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
  invalidateProtocolIndex(e.state);
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
    // PVST keeps per-VLAN priorities for VLANs created later, like IOS running-config order.
    (c.mode !== 'pvst' && c.priorities.some((p) => p.instance !== 0 && !ids.includes(p.instance))) ||
    (c.mode === 'pvst' && c.mappings.length)
  )
    throw new Error('Instâncias, prioridades ou mapeamento VLAN STP inválidos.');
  configureSpanningTree(e, d, 'off');
  d.multiSpanningTree = { ...c, instances: [] };
  configureClassic(e, d, c.protocol ?? 'rstp', c.priorities.find((p) => p.instance === 0)?.priority ?? 32768);
  // Allocate independent persisted trees before entering their election scope.
  for (const id of ids) d.multiSpanningTree!.instances.push({ id, tree: structuredClone(d.spanningTree!) });
  for (const id of ids)
    withStpInstance(d, id, () =>
      configureClassic(
        e,
        d,
        c.protocol ?? 'rstp',
        c.priorities.find((p) => p.instance === id)?.priority ?? 32768
      )
    );
  e.emit(
    'CONFIG_CHANGED',
    d.id,
    c.mode.toUpperCase() + ': ' + ids.length + ' instâncias, eleição por BPDUs e encaminhamento por VLAN.'
  );
}
export function receiveBpdu(e: SimulationEngine, d: Device, p: NetworkInterface, f: Frame) {
  const b = f.bpdu;
  if (b && p.bpduGuard && !p.errDisabled && p.adminUp) {
    p.errDisabled = { reason: 'bpduguard', at: e.state.clock };
    d.macTable = d.macTable.filter((entry) => entry.port !== p.id);
    e.emit(
      'LINK_DOWN',
      d.id,
      `${p.name}: BPDU Guard placed the interface in err-disabled. Use shutdown followed by no shutdown to recover.`,
      { port: p.id, frame: f }
    );
    e.refreshSpanningTree();
    return;
  }
  if (!b || !d.spanningTree?.enabled) return;
  if(b.mst){
    const m=b.mst,region=JSON.stringify([m.name,m.revision,m.digest]),common=m.cist,boundary=d.multiSpanningTree?.mode!=='mstp'||region!==mstRegion(d);
    if(d.multiSpanningTree?.mode==='mstp'&&p.mstBoundary!==boundary){p.mstBoundary=boundary;for(const id of stpInstances(d).filter(Boolean))withStpInstance(d,id,()=>refreshDevice(e,d));}
    if(common.remainingHops>1)withStpInstance(d,0,()=>receiveClassic(e,d,p,{...f,bpdu:{mode:'rstp',root:common.root,cost:common.cost+common.internalCost,bridge:common.bridge,portId:common.portId,age:common.age,proposal:common.proposal,agreement:common.agreement,role:common.role,portState:common.portState,domain:'mstp',region,mst:m,...(common.change?{changeId:common.changeId??b.changeId??'mst-change-'+b.bridge.mac}:{} )}}));
    if(!boundary)for(const record of m.records){if(record.remainingHops<=1||!d.multiSpanningTree?.instances.some(i=>i.id===record.instance))continue;withStpInstance(d,record.instance,()=>{if(p.spanningTree?.operational)receiveClassic(e,d,p,{...f,bpdu:{mode:'rstp',root:record.root,cost:record.cost,bridge:{priority:record.bridgePriority,mac:common.bridge.mac,instance:record.instance},portId:common.portId,age:common.age,proposal:record.proposal,agreement:record.agreement,role:record.role,portState:record.portState,domain:'mstp',region,instance:record.instance,mst:m,...(record.change?{changeId:record.changeId??b.changeId??'mst-change-'+b.bridge.mac}:{} )}});});}return;
  }
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
  a: Extract<Action, { kind: 'stp-hello' | 'stp-transition' | 'stp-info-expire' | 'stp-transmit' }>
) {
  const d = e.device(a.device),
    id = a.instance ?? 0;
  if (id && !d.multiSpanningTree?.instances.some((i) => i.id === id)) return;
  withStpInstance(d, id, () => handleClassic(e, a));
}
