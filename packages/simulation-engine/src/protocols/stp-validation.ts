import { withStpInstance, stpInstances, stpScope, isStpAction } from './stp-scope';
import type { Snapshot } from '../model';
import { bridgeId, compareBridge } from './stp-election';

export function validateSpanningTree(snapshot: Snapshot) {
  const timers = new Map<string, number>();
  for (const { at, action } of snapshot.queue) {
    if (isStpAction(action)) {
      const d = snapshot.devices.find((d) => d.id === action.device);
      if (!d || !stpInstances(d).includes(action.instance ?? 0))
        throw new Error('Timer de instância STP inexistente.');
    }
    let key: string | undefined;
    if (action.kind === 'stp-hello')
      key = JSON.stringify([action.device, action.instance ?? 0, 'hello', action.token]);
    if (action.kind === 'stp-transition')
      key = JSON.stringify([action.device, action.instance ?? 0, action.port, action.token, action.state]);
    if (action.kind === 'stp-info-expire')
      key = JSON.stringify([action.device, action.instance ?? 0, action.port, 'info', action.expiresAt]);
    if (key) {
      if (timers.has(key)) throw new Error('Timer STP duplicado.');
      timers.set(key, at);
    }
  }
  for (const device of snapshot.devices) {
    const c = device.multiSpanningTree;
    if (c) {
      const expected =
        c.mode === 'pvst'
          ? device.vlans.map((v) => v.id)
          : [...new Set(c.mappings.map((m) => m.instance))].filter(Boolean);
      if (
        !device.spanningTree?.enabled ||
        expected.length !== c.instances.length ||
        new Set(c.instances.map((i) => i.id)).size !== c.instances.length ||
        c.instances.some((i) => !expected.includes(i.id) || i.tree.instance !== i.id) ||
        new Set(c.mappings.map((m) => m.vlan)).size !== c.mappings.length ||
        c.mappings.some((m) => !device.vlans.some((v) => v.id === m.vlan)) ||
        new Set(c.priorities.map((m) => m.instance)).size !== c.priorities.length ||
        c.priorities.some((m) => m.instance !== 0 && !expected.includes(m.instance))
      )
        throw new Error('Configuração de instâncias STP inconsistente.');
    }
    for (const p of device.interfaces) {
      const ids = p.spanningInstances?.map((i) => i.id) ?? [];
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !c?.instances.some((i) => i.id === id)) ||
        (!p.logical &&
          !p.channel &&
          !p.vxlan &&
          p.mode !== 'routed' &&
          c &&
          ids.length !== c.instances.length)
      )
        throw new Error('Portas das instâncias STP inconsistentes.');
    }
    for (const instance of stpInstances(device))
      withStpInstance(device, instance, () => {
        const tree = device.spanningTree;
        if (!tree?.enabled) {
          if (device.interfaces.some((port) => port.spanningTree))
            throw new Error('Estado de porta STP sem protocolo ativo.');
          return;
        }
        if (device.type !== 'switch') throw new Error('STP pertence a switches.');
        if (
          timers.get(JSON.stringify([device.id, stpScope(device), 'hello', tree.token])) !== tree.helloAt ||
          tree.helloAt < snapshot.clock
        )
          throw new Error('STP sem timer Hello válido.');
        if (!tree.rootPort && (tree.cost !== 0 || compareBridge(tree.root, bridgeId(device)) !== 0))
          throw new Error('Root bridge STP inconsistente.');
        if (
          tree.rootPort &&
          !device.interfaces.some((port) => port.id === tree.rootPort && port.spanningTree?.role === 'root')
        )
          throw new Error('Root port STP inexistente.');
        for (const port of device.interfaces) {
          if (port.logical || port.channel || port.vxlan || port.mode === 'routed') {
            if (port.spanningTree) throw new Error('Interface routed não participa de STP.');
            continue;
          }
          const state = port.spanningTree;
          if (!state?.token || state.operational === undefined)
            throw new Error('Estado de porta STP incompleto.');
          if (['alternate', 'disabled'].includes(state.role) && state.state !== 'discarding')
            throw new Error('Porta STP bloqueada não pode encaminhar.');
          if (state.role === 'root' && port.id !== tree.rootPort)
            throw new Error('Mais de uma root port STP.');
          if (
            state.transitionAt !== undefined &&
            timers.get(
              JSON.stringify([
                device.id,
                stpScope(device),
                port.id,
                state.token,
                state.state === 'learning' ? 'forwarding' : 'learning',
              ])
            ) !== state.transitionAt
          )
            throw new Error('Transição STP sem timer.');
          if (state.state === 'learning' && state.transitionAt === undefined)
            throw new Error('Learning STP sem transição.');
          if (state.received) {
            const info = state.received;
            if (
              info.at > snapshot.clock ||
              info.expiresAt < snapshot.clock ||
              timers.get(JSON.stringify([device.id, stpScope(device), port.id, 'info', info.expiresAt])) !==
                info.expiresAt
            )
              throw new Error('Informação BPDU sem expiração válida.');
          }
        }
      });
  }
}
