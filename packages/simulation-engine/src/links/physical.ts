import { meshOperational } from '../protocols/mesh';
import { wirelessAssociated } from '../protocols/wireless-radio';
import type { Device, Link, NetworkInterface, Snapshot } from '../model';
import { findDevice, findPort } from '../core/topology-index';
export function endpoint(state: Snapshot, end: Link['a']): { device: Device; port: NetworkInterface } {
  const device = findDevice(state, end.device);
  const port = device && findPort(device, end.port);
  if (!device || !port) throw new Error('Equipamento ou interface inexistente');
  return { device, port };
}
export function validateConnection(state: Snapshot, link: Link, ignoreId?: string) {
  if (link.cable === 'wireless' || link.cable === 'mesh')
    throw new Error('Enlaces de rádio são criados pela configuração wireless.');
  const a = endpoint(state, link.a),
    b = endpoint(state, link.b);
  if (
    a.port.capwapPeer ||
    b.port.capwapPeer ||
    a.port.meshPeer ||
    b.port.meshPeer ||
    a.port.logical ||
    b.port.logical ||
    a.port.aggregate ||
    b.port.aggregate ||
    a.port.tunnel ||
    b.port.tunnel ||
    a.port.vxlan ||
    b.port.vxlan
  )
    throw new Error('Cabo exige interfaces físicas.');
  if (a.device.id === b.device.id) throw new Error('Conecte interfaces de equipamentos diferentes');
  if (
    (!a.device.power && !(a.device.poeDevice?.required && a.device.poeDevice.requested)) ||
    (!b.device.power && !(b.device.poeDevice?.required && b.device.poeDevice.requested))
  )
    throw new Error('Ligue os equipamentos antes de conectar');
  for (const end of [link.a, link.b])
    if (
      state.links.some(
        (l) => l.id !== ignoreId && [l.a, l.b].some((p) => p.device === end.device && p.port === end.port)
      )
    )
      throw new Error('Interface já utilizada por outro cabo');
  validateMedia(link, a.port, b.port);
  if (a.port.speed !== b.port.speed)
    throw new Error('Velocidades incompatíveis: configure ambas as interfaces');
}
export function validateMedia(link: Link, a: NetworkInterface, b: NetworkInterface) {
  if (link.cable === 'serial' || link.cable === 'console') {
    if (a.media !== link.cable || b.media !== link.cable)
      throw new Error('Serial/console exigem sockets correspondentes.');
    if (link.cable === 'serial' && (!a.serial || !b.serial || a.serial.role === b.serial.role))
      throw new Error('Serial exige um DCE e um DTE.');
    if (link.distance > (link.cable === 'console' ? 15 : 50))
      throw new Error('Alcance do cabo serial/console excedido.');
    return;
  }
  const optical = link.cable.startsWith('fiber') || link.cable === 'dac';
  if (
    [a, b].some((p) => (optical ? !['sfp', 'qsfp'].includes(p.media) : p.media !== 'rj45')) ||
    (optical && a.media !== b.media)
  )
    throw new Error('Mídia incompatível: cobre exige RJ45; fibra/DAC exige o mesmo socket SFP ou QSFP.');
  const module = link.cable === 'dac' ? 'dac' : link.cable === 'fiber-sm' ? 'single-mode' : 'multi-mode';
  if (optical && [a, b].some((p) => p.transceiver !== module))
    throw new Error('Transceiver incompatível com o cabo.');
  if (
    [a, b].some(
      (p) =>
        (p.media === 'sfp' && p.speed > 10000) ||
        (p.media === 'rj45' && p.speed > 10000) ||
        (p.media === 'qsfp' && p.speed < 40000)
    )
  )
    throw new Error('Velocidade incompatível com o socket.');
  const reach =
    link.cable === 'dac'
      ? 7
      : link.cable === 'fiber-sm'
        ? 10000
        : link.cable === 'fiber-mm'
          ? Math.max(a.speed, b.speed) >= 40000
            ? 150
            : 550
          : 100;
  if (link.distance > reach) throw new Error('Distância excede o alcance da mídia (' + reach + ' m).');
}
export function linkOperational(state: Snapshot, link: Link) {
  if (link.cable === 'mesh') return meshOperational(state, link);
  if (link.cable === 'wireless') return wirelessAssociated(state, link);
  const a = endpoint(state, link.a),
    b = endpoint(state, link.b);
  try {
    validateMedia(link, a.port, b.port);
  } catch {
    return false;
  }
  return (
    link.up &&
    a.device.power &&
    b.device.power &&
    a.port.adminUp &&
    b.port.adminUp &&
    a.port.speed === b.port.speed &&
    (link.cable !== 'console' || a.port.console?.baud === b.port.console?.baud)
  );
}
