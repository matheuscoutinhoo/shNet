import type { SimulationEngine } from '../core/engine';
import type { Device } from '../model';
import { OSPF, type OspfNeighbor } from './ospf-model';
import { sendOspfDatabase } from './ospf-wire';
import { ipNumber } from './ipv4';

export function ospfNeighborState(
  engine: SimulationEngine,
  device: Device,
  neighbor: OspfNeighbor,
  state: OspfNeighbor['state']
) {
  if (neighbor.state === state) return;
  engine.emit(
    'OSPF_NEIGHBOR_CHANGED',
    device.id,
    `${neighbor.routerId} em ${neighbor.port}: ${neighbor.state} → ${state}.`,
    { port: neighbor.port }
  );
  neighbor.state = state;
}
export function resetOspfExchange(engine: SimulationEngine, neighbor: OspfNeighbor) {
  neighbor.exchange = engine.id('ospf-exchange');
  delete neighbor.remoteExchange;
  delete neighbor.pages;
  delete neighbor.description;
  neighbor.receivedPages = [];
  neighbor.requests = [];
  neighbor.pending = [];
  neighbor.retryAt = engine.state.clock + OSPF.retryMs;
}
export function electOspfNeighbors(engine: SimulationEngine, device: Device) {
  const state = device.ospf!;
  for (const config of state.interfaces) {
    const runtime = state.ports.find((entry) => entry.port === config.port)!;
    const neighbors = state.neighbors.filter((entry) => entry.port === config.port && entry.state !== 'Init');
    if (
      config.networkType === 'broadcast' &&
      runtime.operational &&
      !config.passive &&
      engine.state.clock >= runtime.waitUntil
    ) {
      const own = { routerId: state.routerId, priority: config.priority, dr: runtime.dr, bdr: runtime.bdr };
      const candidates = [own, ...neighbors]
        .filter((entry) => entry.priority > 0)
        .sort((a, b) => b.priority - a.priority || ipNumber(b.routerId) - ipNumber(a.routerId));
      const dr =
        candidates.find((entry) => entry.dr === entry.routerId) ??
        candidates.find((entry) => entry.bdr === entry.routerId) ??
        candidates[0];
      const other = candidates.filter((entry) => entry.routerId !== dr?.routerId);
      const bdr = other.find((entry) => entry.bdr === entry.routerId) ?? other[0];
      if (runtime.dr !== (dr?.routerId ?? '0.0.0.0') || runtime.bdr !== (bdr?.routerId ?? '0.0.0.0')) {
        runtime.dr = dr?.routerId ?? '0.0.0.0';
        runtime.bdr = bdr?.routerId ?? '0.0.0.0';
        runtime.helloAt = engine.state.clock;
        engine.emit('OSPF_DR_CHANGED', device.id, `${config.port}: DR ${runtime.dr}, BDR ${runtime.bdr}.`, {
          port: config.port,
        });
      }
    }
    for (const neighbor of neighbors) {
      const adjacent =
        config.networkType === 'point-to-point' ||
        (engine.state.clock >= runtime.waitUntil &&
          [state.routerId, neighbor.routerId].some((id) => id === runtime.dr || id === runtime.bdr));
      if (adjacent && neighbor.state === '2-Way') {
        resetOspfExchange(engine, neighbor);
        ospfNeighborState(engine, device, neighbor, 'ExStart');
        sendOspfDatabase(engine, device, neighbor);
        ospfNeighborState(engine, device, neighbor, 'Exchange');
      } else if (!adjacent && neighbor.state !== '2-Way') {
        resetOspfExchange(engine, neighbor);
        ospfNeighborState(engine, device, neighbor, '2-Way');
      }
    }
  }
}
export function finishOspfExchange(engine: SimulationEngine, device: Device, neighbor: OspfNeighbor) {
  if (neighbor.pages !== undefined && neighbor.receivedPages.length === neighbor.pages) {
    ospfNeighborState(engine, device, neighbor, neighbor.requests.length ? 'Loading' : 'Full');
  }
}
