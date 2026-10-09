import type { BridgeId, Device, NetworkInterface } from '../model';

export function bridgeId(device: Device): BridgeId {
  return {
    priority: device.spanningTree?.priority ?? 32768,
    mac: device.interfaces[0].mac.toLowerCase(),
    ...(device.spanningTree?.instance ? { instance: device.spanningTree.instance } : {}),
  };
}
export function compareBridge(left: BridgeId, right: BridgeId) {
  return (
    left.priority - right.priority ||
    (left.instance ?? 0) - (right.instance ?? 0) ||
    (left.mac.toLowerCase() < right.mac.toLowerCase()
      ? -1
      : left.mac.toLowerCase() > right.mac.toLowerCase()
        ? 1
        : 0)
  );
}
export function bridgeLabel(bridge: BridgeId) {
  return bridge.priority + (bridge.instance ?? 0) + '.' + bridge.mac;
}
export function portCost(port: NetworkInterface) {
  return port.stpCost ?? (port.speed === 100 ? 19 : port.speed === 1000 ? 4 : 2);
}
export interface PriorityVector {
  root: BridgeId;
  cost: number;
  bridge: BridgeId;
  portId: number;
  localPort: number;
}
export function compareVector(left: PriorityVector, right: PriorityVector) {
  return (
    compareBridge(left.root, right.root) ||
    left.cost - right.cost ||
    compareBridge(left.bridge, right.bridge) ||
    left.portId - right.portId ||
    left.localPort - right.localPort
  );
}
