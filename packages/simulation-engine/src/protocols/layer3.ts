import { receiveFragment } from './fragment';
import { spanningPortState } from './stp-scope';
import { lacpMembers } from './lacp-members';
import { interfaceSchema, type Device, type Frame, type NetworkInterface, type Snapshot } from '../model';
import type { SimulationEngine } from '../core/engine';
import { linkOperational } from '../links/physical';
import { receiveArp } from './arp';
import { receiveIp } from './ipv4';
import { receiveIp6 } from './ipv6';

export const routingEnabled = (device: Device) =>
  device.type === 'router' || (device.type === 'switch' && device.ipRouting === true);
export const interfaceUp = (device: Device, port: NetworkInterface) =>
  port.adminUp &&
  (!port.tunnel || (port.tunnel.enabled && port.tunnel.status === 'up')) &&
  (!port.vxlan || port.vxlan.enabled) &&
  (!port.logical?.parent || device.interfaces.some((p) => p.id === port.logical!.parent && p.adminUp));
export function requireVrf(device: Device, vrf?: string) {
  if (vrf !== undefined && !device.vrfs?.includes(vrf)) throw new Error('VRF inexistente: ' + vrf);
}
export function createLogicalInterface(
  engine: SimulationEngine,
  device: Device,
  kind: 'subinterface' | 'svi',
  vlan: number,
  parentId?: string
) {
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw new Error('VLAN entre 1 e 4094.');
  const parent = device.interfaces.find((port) => port.id === parentId);
  if (
    kind === 'subinterface'
      ? device.type !== 'router' || !parent || parent.logical || parent.tunnel || parent.mode !== 'routed'
      : device.type !== 'switch' || parentId !== undefined
  )
    throw new Error('Subinterface exige porta física routed de roteador; SVI exige switch.');
  const existing = device.interfaces.find(
    (p) => p.logical?.kind === kind && p.logical.vlan === vlan && p.logical.parent === parentId
  );
  if (existing) return existing;
  if (device.interfaces.length >= 48) throw new Error('Limite de 48 interfaces.');
  if (kind === 'svi' && !device.vlans.some((entry) => entry.id === vlan)) {
    if (device.vlans.length >= 256) throw new Error('Limite de VLANs.');
    device.vlans.push({ id: vlan, name: 'VLAN' + vlan });
  }
  const base = parent ?? device.interfaces[0];
  const macs = new Set(engine.state.devices.flatMap((d) => d.interfaces.map((p) => p.mac)));
  let suffix = 0;
  let mac: string;
  do {
    mac = base.mac.split(':').slice(0, 4).join(':') + ':01:' + (suffix++).toString(16).padStart(2, '0');
  } while (macs.has(mac));
  const port = interfaceSchema.parse({
    ...base,
    id: engine.id('interface'),
    name: kind === 'svi' ? 'Vlan' + vlan : parent!.name + '.' + vlan,
    mac,
    mode: 'routed',
    adminUp: true,
    dot1x: undefined,
    supplicant: undefined,
    logical: { kind, vlan, ...(parentId ? { parent: parentId } : {}) },
    ipv6: undefined,
    ip: undefined,
    prefix: undefined,
    ipv4Mode: undefined,
    gateway: undefined,
    dns: undefined,
    dhcp: undefined,
    dhcpRelay: undefined,
    vrf: undefined,
    spanningTree: undefined,
    stpEdge: undefined,
    stpCost: undefined,
    tunnel: undefined,
    vxlan: undefined,
    qos: undefined,
    aggregate: undefined,
    channel: undefined,
    aclIn: undefined,
    aclOut: undefined,
    natRole: undefined,
    description: '',
    rx: 0,
    tx: 0,
    errors: 0,
  });
  device.interfaces.push(port);
  engine.emit('CONFIG_CHANGED', device.id, 'Interface lógica ' + port.name + ' criada.', { port: port.id });
  return port;
}
export function sviOperational(snapshot: Snapshot, device: Device, port: NetworkInterface) {
  return (
    device.power &&
    port.adminUp &&
    port.logical?.kind === 'svi' &&
    device.vlans.some((v) => v.id === port.logical!.vlan) &&
    device.interfaces.some(
      (p) =>
        !p.logical &&
        !p.channel &&
        p.mode !== 'routed' &&
        p.adminUp &&
        (!spanningPortState(device, p, port.logical!.vlan) ||
          spanningPortState(device, p, port.logical!.vlan)?.state === 'forwarding') &&
        (p.mode === 'trunk'
          ? p.allowedVlans.includes(port.logical!.vlan)
          : p.accessVlan === port.logical!.vlan) &&
        interfaceOperational(snapshot, device, p)
    )
  );
}
export function interfaceOperational(snapshot: Snapshot, device: Device, port: NetworkInterface): boolean {
  if (!device.power || !interfaceUp(device, port)) return false;
  if (port.capwapPeer)
    return (
      !!device.wlc?.enabled &&
      device.wlc.sessions.some(
        (s) => s.wtp === port.capwapPeer && s.phase === 'RUN' && snapshot.clock - s.lastAt <= 5000
      )
    );
  if (port.vxlan) {
    const carrier = device.interfaces.find((p) => p.id === port.vxlan!.underlay);
    return !!carrier && interfaceOperational(snapshot, device, carrier);
  }
  if (port.tunnel) {
    const carrier = device.interfaces.find((p) => p.id === port.tunnel!.underlay);
    return !!carrier && interfaceOperational(snapshot, device, carrier);
  }
  if (port.aggregate) return lacpMembers(snapshot, device, port).length > 0;
  if (port.logical?.kind === 'svi') return sviOperational(snapshot, device, port);
  if (port.logical?.parent) {
    const parent = device.interfaces.find((p) => p.id === port.logical!.parent);
    return !!parent && interfaceOperational(snapshot, device, parent);
  }
  const id = port.logical?.parent ?? port.id;
  return snapshot.links.some(
    (l) =>
      [l.a, l.b].some((end) => end.device === device.id && end.port === id) && linkOperational(snapshot, l)
  );
}
export function receiveSvi(engine: SimulationEngine, device: Device, vlan: number, frame: Frame) {
  const port = device.interfaces.find((p) => p.logical?.kind === 'svi' && p.logical.vlan === vlan);
  if (!port || !sviOperational(engine.state, device, port)) return false;
  const directed = frame.dst === port.mac;
  if (!directed && frame.dst !== 'ff:ff:ff:ff:ff:ff' && !(frame.ipv6 && frame.dst.startsWith('33:33:')))
    return false;
  port.rx++;
  if (frame.ipv6) receiveIp6(engine, device, port, frame);
  else if (frame.etherType === 'ARP') receiveArp(engine, device, port, frame);
  else if (frame.fragment) receiveFragment(engine, device, port, frame);
  else if (frame.packet) receiveIp(engine, device, port, frame.packet, frame.src);
  return directed;
}
export function validateLayer3(snapshot: Snapshot) {
  for (const device of snapshot.devices) {
    const vrfs = device.vrfs ?? [];
    if (new Set(vrfs).size !== vrfs.length || (vrfs.length && !['router', 'switch'].includes(device.type)))
      throw new Error('VRFs duplicadas ou equipamento incompatível.');
    if (device.ipRouting !== undefined && device.type !== 'switch')
      throw new Error('ip routing é opção de switch.');
    const keys = new Set<string>();
    const ips = new Set<string>();
    for (const port of device.interfaces) {
      requireVrf(device, port.vrf);
      if (device.type === 'switch' && port.ip && port.mode !== 'routed')
        throw new Error('IPv4 no switch exige SVI ou porta routed.');
      if (port.ip) {
        const key = JSON.stringify([port.vrf, port.ip]);
        if (ips.has(key)) throw new Error('IPv4 duplicado na mesma VRF.');
        ips.add(key);
      }
      if (
        port.vrf &&
        (port.dhcp ||
          port.dhcpRelay?.length ||
          port.natRole ||
          device.ospf?.interfaces.some((p) => p.port === port.id) ||
          device.rip?.interfaces.some((p) => p.port === port.id) ||
          device.vrrp?.groups.some((g) => g.port === port.id))
      )
        throw new Error('DHCP, NAT e protocolos de controle exigem a tabela padrão nesta versão.');
      const logical = port.logical;
      if (!logical) continue;
      const parent = device.interfaces.find((p) => p.id === logical.parent);
      if (
        logical.kind === 'subinterface'
          ? device.type !== 'router' || !parent || parent.logical || parent.tunnel || parent.mode !== 'routed'
          : device.type !== 'switch' ||
            logical.parent !== undefined ||
            !device.vlans.some((v) => v.id === logical.vlan)
      )
        throw new Error('Referência de interface lógica inválida.');
      if (port.mode !== 'routed' || port.spanningTree || port.ipv4Mode === 'dhcp')
        throw new Error('Interface lógica deve usar modo routed e IPv4 estático.');
      const key = JSON.stringify([logical.kind, logical.parent, logical.vlan]);
      if (keys.has(key)) throw new Error('Interface lógica duplicada na VLAN.');
      keys.add(key);
    }
    for (const route of device.routes) requireVrf(device, route.vrf);
    for (const connection of device.tcpConnections ?? []) requireVrf(device, connection.vrf);
    if (vrfs.length && device.nat?.enabled) throw new Error('NAT com VRF ainda não suportado.');
  }
  for (const link of snapshot.links)
    for (const end of [link.a, link.b])
      if (
        snapshot.devices.find((d) => d.id === end.device)?.interfaces.find((p) => p.id === end.port)?.logical
      )
        throw new Error('Cabo só pode conectar interfaces físicas.');
  for (const probe of snapshot.probes) {
    const device = snapshot.devices.find((d) => d.id === probe.device);
    if (device) requireVrf(device, probe.vrf);
  }
}
