import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { tlsMessageSchema, type TlsMessage } from './tls-model';
import type { EapPacket } from './radius-codec';
import type { EapFragments } from './enterprise-model';
export const emptyFragments = (): EapFragments => ({ incoming: '', outgoing: '', first: false });
export function queueTls(f: EapFragments, m: TlsMessage) {
  if (f.outgoing) throw new Error('EAP flight pendente.');
  f.outgoing = bytesToHex(new TextEncoder().encode(JSON.stringify(tlsMessageSchema.parse(m))));
  f.outgoingTotal = f.outgoing.length / 2;
  f.first = true;
}
export function nextTls(f: EapFragments, code: 1 | 2, identifier: number, method: 13 | 25): EapPacket {
  if (!f.outgoing) throw new Error('EAP fragmento ausente.');
  const data = f.outgoing.slice(0, 768);
  f.outgoing = f.outgoing.slice(768);
  const p: EapPacket = {
    code,
    identifier,
    method,
    data,
    flags: (f.first ? 128 : 0) | (f.outgoing ? 64 : 0),
    ...(f.first ? { length: f.outgoingTotal } : {}),
  };
  f.first = false;
  if (!f.outgoing) delete f.outgoingTotal;
  return p;
}
export function receiveTls(f: EapFragments, p: EapPacket): TlsMessage | undefined {
  if (!p.data || (p.flags ?? 0) & ~192) throw new Error('EAP-TLS flags/payload inválidos.');
  if ((p.flags ?? 0) & 128) {
    if (f.incoming || !p.length || p.length > 16000) throw new Error('EAP-TLS comprimento inicial inválido.');
    f.total = p.length;
  }
  if (!f.total) throw new Error('EAP-TLS fragmento sem comprimento inicial.');
  f.incoming += p.data;
  if (f.incoming.length / 2 > f.total) throw new Error('EAP-TLS fragmentos excedem comprimento.');
  if ((p.flags ?? 0) & 64) {
    if (f.incoming.length / 2 === f.total) throw new Error('EAP-TLS More inconsistente.');
    return;
  }
  if (f.incoming.length / 2 !== f.total) throw new Error('EAP-TLS flight incompleto.');
  const message = tlsMessageSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(f.incoming)))
  );
  f.incoming = '';
  delete f.total;
  return message;
}
