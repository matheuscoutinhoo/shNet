import type { Device, Snapshot } from '../model';
import { findDevice } from './topology-index';
type Connection = NonNullable<Device['tcpConnections']>[number];
const indices = new WeakMap<
  Snapshot,
  {
    devices: Snapshot['devices'];
    size: number;
    entries: Map<string, { device: Device; connection: Connection }>;
  }
>();
export function invalidateTraceIndex(snapshot: Snapshot) {
  indices.delete(snapshot);
}
export function traceConnection(snapshot: Snapshot, id: string): Connection | undefined {
  const index = indices.get(snapshot),
    entry = index?.entries.get(id);
  if (
    index?.devices === snapshot.devices &&
    index.size === snapshot.devices.length &&
    entry &&
    findDevice(snapshot, entry.device.id) === entry.device &&
    entry.device.tcpConnections?.includes(entry.connection)
  )
    return entry.connection;
  const entries = new Map<string, { device: Device; connection: Connection }>();
  for (const device of snapshot.devices)
    for (const connection of device.tcpConnections ?? [])
      if (!entries.has(connection.id)) entries.set(connection.id, { device, connection });
  indices.set(snapshot, { devices: snapshot.devices, size: snapshot.devices.length, entries });
  return entries.get(id)?.connection;
}
