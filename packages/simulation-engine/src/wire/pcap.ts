import type { Snapshot } from '../model';
import { encodeEthernet, decodeEthernet } from './ethernet-codec';
import { concat, need, view } from './binary';
export function exportPcap(s: Snapshot, link?: string) {
  const frames: { at: number; bytes: Uint8Array }[] = [],
    excluded: { event: string; reason: string }[] = [];
  const connections = new Map(
    s.devices.flatMap((d) => (d.tcpConnections ?? []).map((c) => [c.id, c] as const))
  );
  for (const event of s.events) {
    if (event.type !== 'FRAME_SENT' || !event.frame || (link && event.link !== link)) continue;
    try {
      const tcp =
          event.frame.packet?.protocol === 'TCP'
            ? event.frame.packet
            : event.frame.ipv6?.protocol === 'TCP'
              ? event.frame.ipv6.segment
              : undefined,
        connection = tcp?.traceId ? connections.get(tcp.traceId) : undefined;
      if (tcp?.data && !connection) throw new Error('Aplicação TCP ausente do estado retido.');
      if (
        connection &&
        !['manual', 'echo', 'http', 'database', 'proxy', 'proxy-upstream', 'load-balancer'].includes(
          connection.service
        )
      )
        throw new Error('Aplicação TCP ' + connection.service + ' usa enquadramento didático.');
      frames.push({ at: event.time, bytes: encodeEthernet(event.frame) });
    } catch (error) {
      excluded.push({
        event: event.id,
        reason: error instanceof Error ? error.message : 'Codec indisponível.',
      });
    }
  }
  const header = new Uint8Array(24),
    h = view(header);
  h.setUint32(0, 0xa1b2c3d4, true);
  h.setUint16(4, 2, true);
  h.setUint16(6, 4, true);
  h.setUint32(16, 65600, true);
  h.setUint32(20, 1, true);
  const records = frames.map((f) => {
    const record = new Uint8Array(16),
      v = view(record);
    v.setUint32(0, Math.floor(f.at / 1000), true);
    v.setUint32(4, Math.floor((f.at % 1000) * 1000), true);
    v.setUint32(8, f.bytes.length, true);
    v.setUint32(12, f.bytes.length, true);
    return concat(record, f.bytes);
  });
  return {
    bytes: concat(header, ...records),
    packets: frames.length,
    excluded,
    retainedEvents: s.events.length,
  };
}
export function decodePcap(bytes: Uint8Array) {
  if (bytes.length > 100 * 1024 * 1024) throw new Error('PCAP excede 100 MiB.');
  need(bytes, 0, 24);
  const v = view(bytes),
    magic = v.getUint32(0, true),
    little = magic === 0xa1b2c3d4;
  if (!little && magic !== 0xd4c3b2a1) throw new Error('PCAP requer resolução de microssegundos.');
  if (v.getUint16(4, little) !== 2 || v.getUint16(6, little) !== 4 || v.getUint32(20, little) !== 1)
    throw new Error('PCAP requer versão 2.4 e Ethernet.');
  const snaplen = v.getUint32(16, little);
  if (snaplen < 14 || snaplen > 65600) throw new Error('Snaplen PCAP inválido.');
  const records = [];
  let at = 24;
  while (at < bytes.length) {
    need(bytes, at, 16);
    const sec = v.getUint32(at, little),
      micros = v.getUint32(at + 4, little),
      size = v.getUint32(at + 8, little),
      original = v.getUint32(at + 12, little);
    if (micros >= 1000000 || size > snaplen || size !== original || records.length >= 10000)
      throw new Error('Registro PCAP truncado ou fora dos limites.');
    need(bytes, at + 16, size);
    const raw = bytes.subarray(at + 16, at + 16 + size);
    records.push({ time: sec * 1000 + micros / 1000, frame: decodeEthernet(raw), raw });
    at += 16 + size;
  }
  return records;
}
