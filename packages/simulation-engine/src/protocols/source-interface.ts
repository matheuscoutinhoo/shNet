import type { Device, Snapshot } from '../model';
import { interfaceOperational } from './layer3';
import { findInterface } from './interface-name';

/**
 * IPv4 address of a configured "... source-interface X" (logging, ntp, snmp-server trap-source,
 * ip tacacs/radius). IOS falls back to the outgoing interface when X is missing, unaddressed or down.
 */
export function sourceInterfaceAddress(state: Snapshot, d: Device, name?: string) {
  const p = findInterface(d, name);
  return p?.ip && interfaceOperational(state, d, p) ? p.ip : undefined;
}
