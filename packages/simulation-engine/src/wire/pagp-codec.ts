import type { LacpPdu } from '../protocols/lacp-model';
import { concat, hex, need, u16, u32, view } from './binary';

/** LLC/SNAP header of Cisco PAgP: DSAP/SSAP AA, UI, OUI 00000C, PID 0x0104. */
const SNAP = new Uint8Array([0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x01, 0x04]);
const zero = '00:00:00:00:00:00';
const mac = (value: string) => hex(value.replaceAll(':', ''));
/**
 * Cisco PAgP Information PDU (802.3 length + SNAP): version 1, flags (auto mode, consistent state),
 * the sender's device ID, port ifIndex and group capability, and the same fields learned from the
 * partner.
 */
export function encodePagp(p: LacpPdu): { type: number; body: Uint8Array } {
  const flags = (p.active ? 0 : 2) | ((p.actor.state ?? 0) & 8 ? 4 : 0);
  const pdu = concat(
    new Uint8Array([1, flags]),
    mac(p.actor.system),
    u32(p.actor.portNumber ?? 0),
    u32(p.actor.key),
    u32(p.actor.key),
    mac(p.partner?.system ?? zero),
    u32(p.partner?.portNumber ?? 0),
    u32(p.partner?.key ?? 0),
    u32(p.partner?.key ?? 0),
    u16(p.partner ? 1 : 0),
    u16(0)
  );
  const body = concat(SNAP, pdu);
  return { type: body.length, body };
}
export const isPagp = (b: Uint8Array) => b.length >= 8 && SNAP.every((x, i) => b[i] === x);
export function decodePagp(b: Uint8Array) {
  need(b, 0, 50);
  if (!isPagp(b) || b[8] !== 1) throw new Error('Invalid PAgP header or version.');
  const v = view(b),
    at = (offset: number) => [...b.subarray(offset, offset + 6)].map((n) => n.toString(16).padStart(2, '0')).join(':');
  return {
    version: 1,
    autoMode: !!(b[9] & 2),
    consistent: !!(b[9] & 4),
    device: at(10),
    ifIndex: v.getUint32(16),
    group: v.getUint32(20),
    partnerDevice: at(28),
    partnerIfIndex: v.getUint32(34),
    partners: v.getUint16(46),
  };
}
