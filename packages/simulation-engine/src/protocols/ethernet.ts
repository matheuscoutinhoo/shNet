import { permitDhcpSnooping } from './dhcp-snooping';
import { evpnPort, observeEvpnFrame } from './evpn';
import { BROADCAST, LIMITS, type Device, type Frame, type NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import { receiveSvi } from './layer3';
import { spanningPortState } from './stp-scope';
export function switchFrame(e: SimulationEngine, d: Device, input: NetworkInterface, frame: Frame) {
  const vlan = input.mode === 'trunk' ? (frame.vlan ?? input.nativeVlan) : input.accessVlan;
  const tree = spanningPortState(d, input, vlan);
  if (tree?.state === 'discarding') {
    e.drop(d, 'STP: porta de entrada em discarding; frame de dados bloqueado.', input.id, frame);
    return;
  }
  if (
    (input.mode === 'access' && frame.vlan !== undefined) ||
    (input.mode === 'trunk' && !input.allowedVlans.includes(vlan)) ||
    !d.vlans.some((v) => v.id === vlan)
  ) {
    e.drop(d, 'Frame rejeitado: VLAN não permitida na porta de entrada.', input.id, frame);
    return;
  }
  if (!permitDhcpSnooping(e, d, input, frame, vlan)) return;
  d.macTable = d.macTable.filter(
    (m) => m.expires > e.state.clock && !(m.mac === frame.src && m.vlan === vlan)
  );
  d.macTable.push({ vlan, mac: frame.src, port: input.id, expires: e.state.clock + LIMITS.macAge });
  observeEvpnFrame(d, input, frame, vlan);
  if (d.macTable.length > 2048) d.macTable.shift();
  e.emit('MAC_LEARNED', d.id, 'MAC ' + frame.src + ' aprendido na VLAN ' + vlan + '.', {
    port: input.id,
    frame,
  });
  if (tree?.state === 'learning') {
    e.drop(d, 'STP: porta aprende MAC, mas ainda não encaminha dados.', input.id, frame);
    return;
  }
  if (receiveSvi(e, d, vlan, frame)) return;
  switchTransmit(e, d, frame, vlan, input.id);
}
export function switchTransmit(e: SimulationEngine, d: Device, frame: Frame, vlan: number, input?: string) {
  const overlay = evpnPort(d, vlan, frame.dst);
  const known = overlay
    ? { port: overlay.id }
    : d.macTable.find((m) => m.vlan === vlan && m.mac === frame.dst);
  const candidates = d.interfaces.filter(
    (p) =>
      (p.id !== input || (p.media === 'wifi' && !p.meshPeer)) &&
      !p.logical &&
      !p.channel &&
      p.mode !== 'routed' &&
      p.adminUp &&
      (!spanningPortState(d, p, vlan) || spanningPortState(d, p, vlan)?.state === 'forwarding') &&
      (p.mode === 'trunk' ? p.allowedVlans.includes(vlan) : p.accessVlan === vlan)
  );
  const ports = known ? candidates.filter((p) => p.id === known.port) : candidates;
  if (!known)
    e.emit(
      'FRAME_FLOODED',
      d.id,
      frame.dst === BROADCAST
        ? 'Broadcast restrito à VLAN ' + vlan + '.'
        : 'MAC destino desconhecido: flooding apenas na VLAN ' + vlan + '.',
      { port: input, frame }
    );
  if (!ports.length) e.drop(d, 'Nenhuma porta de saída encaminha esta VLAN.', input, frame);
  for (const port of ports) {
    const wire = { ...frame, vlan: port.mode === 'trunk' && port.nativeVlan !== vlan ? vlan : undefined };
    e.sendFrame(d.id, port.id, wire);
  }
}
