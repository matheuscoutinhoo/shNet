import { lsaChecksum } from './ospf-security';
import type { Snapshot } from '../model';
import { ipNumber, subnet } from './ipv4';
import { lsaKey, type OspfLsa } from './ospf-model';
import { bestOspfRoutes, ospfSpf } from './ospf-spf';
import { ospfBytes } from './ospf-wire';

function unique(values: (string | number)[]) {
  if (new Set(values).size !== values.length) throw new Error('Referência OSPF duplicada.');
}
export function validateOspfLsa(lsa: OspfLsa, clock: number) {
  if (
    lsa.originatedAt > clock ||
    !ipNumber(lsa.advertisingRouter) ||
    ipNumber(lsa.advertisingRouter) >= 0xe0000000
  )
    throw new Error('Origem ou relógio de LSA OSPF inválido.');
  if (lsa.checksum !== undefined && lsa.checksum !== lsaChecksum(lsa))
    throw new Error('Checksum de LSA inválido.');
  const prefixes = lsa.type === 'router' ? lsa.prefixes : lsa.type === 'asbr-summary' ? [] : [lsa];
  if (prefixes.some((entry) => subnet(entry.network, entry.prefix).network !== entry.network))
    throw new Error('Prefixo OSPF desalinhado.');
  if (lsa.type === 'router') {
    if (lsa.id !== lsa.advertisingRouter) throw new Error('Router LSA com ID inconsistente.');
    unique(lsa.links.map((link) => `${link.kind}:${link.id}`));
    unique(lsa.prefixes.map((entry) => `${entry.network}/${entry.prefix}`));
  } else if (lsa.type === 'network') {
    if (subnet(lsa.id, lsa.prefix).network !== lsa.network || !lsa.routers.includes(lsa.advertisingRouter))
      throw new Error('Network LSA inconsistente.');
    unique(lsa.routers);
  } else if (lsa.type === 'asbr-summary') {
    if (lsa.id !== lsa.routerId) throw new Error('ASBR summary inconsistente.');
  } else if (lsa.id !== `${lsa.network}/${lsa.prefix}`) throw new Error('Summary LSA inconsistente.');
}
export function validateOspf(snapshot: Snapshot) {
  for (const device of snapshot.devices) {
    const state = device.ospf;
    if (!state) continue;
    if (device.type !== 'router' || !ipNumber(state.routerId) || ipNumber(state.routerId) >= 0xe0000000)
      throw new Error('Processo OSPF inválido.');
    unique(state.interfaces.map((entry) => entry.port));
    unique(state.ports.map((entry) => entry.port));
    if (
      state.ports.length !== state.interfaces.length ||
      state.interfaces.some(
        (config) =>
          !device.interfaces.some((port) => port.id === config.port && port.mode === 'routed') ||
          !state.ports.some((port) => port.port === config.port)
      )
    )
      throw new Error('Interface OSPF inexistente.');
    const timers = snapshot.queue.filter(
      ({ action }) => action.kind === 'ospf-tick' && action.device === device.id
    );
    if (
      timers.length !== Number(state.enabled) ||
      (state.enabled &&
        (timers[0].at !== state.tickAt ||
          state.tickAt < snapshot.clock ||
          timers[0].action.kind !== 'ospf-tick' ||
          timers[0].action.token !== state.token))
    )
      throw new Error('Timer OSPF inconsistente.');
    unique(state.neighbors.map((entry) => `${entry.port}:${entry.routerId}`));
    if (!state.enabled && (state.routes.length || state.neighbors.length))
      throw new Error('OSPF inativo com rotas ou vizinhos.');
    for (const neighbor of state.neighbors) {
      const config = state.interfaces.find((entry) => entry.port === neighbor.port);
      if (
        !config ||
        config.passive ||
        config.area !== neighbor.area ||
        neighbor.routerId === state.routerId ||
        neighbor.lastSeen > snapshot.clock ||
        neighbor.deadAt !== neighbor.lastSeen + config.deadMs
      )
        throw new Error('Vizinho OSPF inconsistente.');
      unique(neighbor.receivedPages);
      unique(neighbor.requests.map((entry) => entry.key));
      unique(neighbor.pending.map((entry) => entry.key));
      if (
        neighbor.receivedPages.some((page) => neighbor.pages === undefined || page >= neighbor.pages) ||
        (neighbor.state === 'Full' &&
          (!neighbor.remoteExchange ||
            neighbor.requests.length ||
            neighbor.receivedPages.length !== neighbor.pages))
      )
        throw new Error('Exchange OSPF incompleto.');
    }
    unique(state.lsdb.map(lsaKey));
    for (const lsa of state.lsdb) validateOspfLsa(lsa, snapshot.clock);
    const areas = [...new Set(state.interfaces.map((entry) => entry.area))].sort((a, b) => a - b);
    const abr = areas.includes(0) && areas.length > 1;
    const expected = bestOspfRoutes(
      areas
        .flatMap((area) => ospfSpf(device, area))
        .filter((route) => !abr || route.area === 0 || route.pathType !== 'inter')
    );
    if (JSON.stringify(state.routes) !== JSON.stringify(expected))
      throw new Error('Rotas OSPF não correspondem à LSDB local.');
  }
  for (const { action } of snapshot.queue) {
    if (
      action.kind === 'ospf-tick' &&
      !snapshot.devices.some((device) => device.id === action.device && device.ospf?.enabled)
    )
      throw new Error('Timer OSPF sem processo.');
    const packet = action.kind === 'deliver' ? action.frame.packet : undefined;
    if (packet?.protocol === 'OSPF') {
      if (packet.bytes !== ospfBytes(packet.message) + (packet.authentication ? 40 : 0))
        throw new Error('Comprimento OSPF inválido.');
      if (packet.message.type === 'update') validateOspfLsa(packet.message.lsa, snapshot.clock);
    }
  }
}
