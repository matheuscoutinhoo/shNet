import type { Snapshot } from '../model';
import { subnet, sameSubnet } from './ipv4';
import { RIP } from './rip-model';
import { ripBytes } from './rip';

export function validateRip(snapshot: Snapshot) {
  const unique = (values: string[]) => {
    if (new Set(values).size !== values.length) throw new Error('Referência RIP duplicada.');
  };
  for (const device of snapshot.devices) {
    const state = device.rip;
    if (!state) continue;
    if (device.type !== 'router') throw new Error('RIP exige roteador.');
    unique(state.interfaces.map((entry) => entry.port));
    unique(state.ports.map((entry) => entry.port));
    unique(state.table.map((entry) => `${entry.network}/${entry.prefix}`));
    if (
      state.ports.length !== state.interfaces.length ||
      state.interfaces.some(
        (config) =>
          !device.interfaces.some((port) => port.id === config.port && port.mode === 'routed') ||
          !state.ports.some((port) => port.port === config.port)
      )
    )
      throw new Error('Interface RIP inexistente.');
    const timers = snapshot.queue.filter(
      ({ action }) => action.kind === 'rip-tick' && action.device === device.id
    );
    if (
      timers.length !== Number(state.enabled) ||
      (state.enabled &&
        (timers[0].at !== state.tickAt ||
          state.tickAt < snapshot.clock ||
          timers[0].action.kind !== 'rip-tick' ||
          timers[0].action.token !== state.token))
    )
      throw new Error('Timer RIP inconsistente.');
    if (!state.enabled && state.table.length) throw new Error('RIP inativo com rotas.');
    for (const route of state.table) {
      const config = state.interfaces.find((entry) => entry.port === route.port);
      if (
        !config ||
        subnet(route.network, route.prefix).network !== route.network ||
        (route.learnedFrom &&
          (config.passive ||
            !sameSubnet(
              route.nextHop,
              device.interfaces.find((p) => p.id === route.port)!.ip!,
              device.interfaces.find((p) => p.id === route.port)!.prefix!
            ) ||
            route.metric < 2 ||
            route.expiresAt === undefined ||
            route.expiresAt > snapshot.clock + RIP.timeoutMs)) ||
        (!route.learnedFrom &&
          (route.expiresAt !== undefined ||
            (route.metric !== 1 &&
              route.metric !== 16 &&
              (!state.redistributeStatic || route.metric !== state.staticMetric)))) ||
        (route.metric === 16) !== (route.garbageAt !== undefined) ||
        (route.garbageAt !== undefined && route.garbageAt > snapshot.clock + RIP.garbageMs)
      )
        throw new Error('Rota RIP inconsistente.');
    }
  }
  for (const { action } of snapshot.queue) {
    if (
      action.kind === 'rip-tick' &&
      !snapshot.devices.some((device) => device.id === action.device && device.rip?.enabled)
    )
      throw new Error('Timer RIP sem processo.');
    const packet = action.kind === 'deliver' ? action.frame.packet : undefined;
    if (
      packet?.protocol === 'UDP' &&
      packet.payload.protocol === 'RIP' &&
      packet.bytes !== ripBytes(packet.payload.message)
    )
      throw new Error('Comprimento RIP inválido.');
  }
}
