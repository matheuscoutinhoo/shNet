import type { SimulationEngine } from '../core/engine';
import { BROADCAST, type Device, type Frame, type NetworkInterface } from '../model';
import { evpnMac } from './evpn';
import { interfaceOperational } from './layer3';
import { resolveUnderlay } from './underlay';
import { isUnicast } from './dhcp-config';

export function replyEvpnArp(
  engine: SimulationEngine,
  device: Device,
  input: NetworkInterface,
  frame: Frame,
  vlan: number
) {
  const arp = frame.arp;
  // Never certify a remote host's liveness by answering its monitor/DAD,
  // unicast refresh or gratuitous ARP locally. Overlay ingress is not local CE.
  if (
    input.vxlan ||
    frame.dst !== BROADCAST ||
    !arp ||
    arp.kind !== 'request' ||
    !isUnicast(arp.senderIp) ||
    !isUnicast(arp.targetIp) ||
    arp.senderIp === arp.targetIp ||
    arp.senderMac !== frame.src ||
    parseInt(frame.src.slice(0, 2), 16) & 1
  )
    return false;
  const port = device.interfaces.find(
    (p) =>
      p.vxlan?.enabled &&
      p.vxlan.proxyArp &&
      p.vxlan.evpn &&
      p.vxlan.peerPolicy === 'evpn' &&
      p.vxlan.vlan === vlan
  );
  const v = port?.vxlan;
  if (!port || !v || !interfaceOperational(engine.state, device, port)) return false;
  const underlay = device.interfaces.find((p) => p.id === v.underlay);
  if (!underlay) return false;
  const local = v.local.some(
    (binding) =>
      binding.ip === arp.targetIp &&
      device.macTable.some(
        (entry) =>
          entry.mac === binding.mac &&
          entry.port === binding.port &&
          entry.vlan === vlan &&
          entry.expires > engine.state.clock &&
          device.interfaces.some((p) => p.id === entry.port && interfaceOperational(engine.state, device, p))
      )
  );
  if (local) return false;
  const macs = [...new Set(v.routes.filter((r) => r.ip === arp.targetIp).map((r) => r.mac))];
  const candidates = macs.flatMap((mac) => {
    const route = evpnMac(device, port, mac);
    return route?.ip === arp.targetIp &&
      v.members?.some(
        (member) =>
          member.peer === route.peer &&
          member.vni === v.vni &&
          member.routeTarget === v.routeTarget &&
          member.nextHop === route.nextHop
      ) &&
      resolveUnderlay(device, underlay, route.nextHop, engine.state)
      ? [route]
      : [];
  });
  // Duplicate IPs with different MACs must remain visible to normal ARP.
  if (candidates.length !== 1) return false;
  const route = candidates[0];
  const reply: Frame = {
    src: route.mac,
    dst: arp.senderMac,
    etherType: 'ARP',
    hops: 64,
    ...(input.mode === 'trunk' && input.nativeVlan !== vlan ? { vlan } : {}),
    arp: {
      kind: 'reply',
      senderIp: arp.targetIp,
      senderMac: route.mac,
      targetIp: arp.senderIp,
    },
  };
  engine.emit(
    'EVPN_ARP_REPLIED',
    device.id,
    `ARP ${arp.targetIp} → ${route.mac}: binding EVPN VNI ${v.vni}, RT ${v.routeTarget}, VTEP ${route.nextHop}.`,
    { port: input.id, frame: reply }
  );
  engine.sendFrame(device.id, input.id, reply);
  return true;
}
