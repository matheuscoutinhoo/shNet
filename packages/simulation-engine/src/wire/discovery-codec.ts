import type { DiscoveryMessage } from '../protocols/discovery-model';
import { checksum, concat, hex, ip4, need, text, u16, u32, view } from './binary';

// CDP uses LLC/SNAP inside IEEE 802.3; LLDP uses Ethernet II 0x88cc.
const snap = new Uint8Array([0xaa, 0xaa, 3, 0, 0, 0x0c, 0x20, 0]);
function cdpChecksum(bytes: Uint8Array) {
  if (!(bytes.length & 1)) return checksum(bytes);
  // CDP's odd-octet checksum differs from the Internet checksum's padding.
  const padded = concat(bytes, new Uint8Array(1)),
    last = bytes[bytes.length - 1];
  padded[bytes.length - 1] = last & 128 ? 255 : 0;
  padded[bytes.length] = last & 128 ? last - 1 : last;
  return checksum(padded);
}
export function encodeDiscovery(m: DiscoveryMessage): { type: number; body: Uint8Array } {
  if (m.protocol === 'CDP') {
    if (m.ttl > 255) throw new Error('CDP TTL exceeds one octet.');
    const tlv = (type: number, value: Uint8Array) => concat(u16(type), u16(value.length + 4), value);
    const capabilities = m.capabilities.reduce(
      (bits, c) => bits | (c === 'Router' ? 1 : c === 'Switch' ? 8 : c === 'Phone' ? 128 : 16),
      0
    );
    const body = concat(
      new Uint8Array([2, m.ttl, 0, 0]),
      tlv(1, text(m.deviceId)),
      tlv(
        2,
        concat(
          u32(m.addresses.length),
          ...m.addresses.map((address) => concat(new Uint8Array([1, 1, 0xcc]), u16(4), ip4(address)))
        )
      ),
      tlv(3, text(m.portId)),
      tlv(4, u32(capabilities)),
      tlv(5, text('shLab behavioral simulator')),
      tlv(6, text(m.platform)),
      ...(m.voiceVlan !== undefined ? [tlv(0x000e, concat(new Uint8Array([1]), u16(m.voiceVlan)))] : []),
      ...(m.voiceVlanQuery ? [tlv(0x000f, new Uint8Array([0, 0, 0]))] : [])
    );
    view(body).setUint16(2, cdpChecksum(body));
    const payload = concat(snap, body);
    if (payload.length > 1500) throw new Error('CDP exceeds IEEE 802.3 length limit.');
    return { type: payload.length, body: payload };
  }
  const tlv = (type: number, value: Uint8Array) => {
    if (value.length > 511) throw new Error('LLDP TLV exceeds length limit.');
    return concat(u16((type << 9) | value.length), value);
  };
  const capabilities = m.capabilities.reduce(
    (bits, c) => bits | (c === 'Router' ? 16 : c === 'Switch' ? 4 : c === 'Phone' ? 32 : 128),
    0
  );
  return {
    type: 0x88cc,
    body: concat(
      tlv(1, concat(new Uint8Array([4]), hex(m.chassisId.replaceAll(':', '')))),
      tlv(2, concat(new Uint8Array([5]), text(m.portId))),
      tlv(3, u16(m.ttl)),
      tlv(5, text(m.deviceId)),
      tlv(6, text(m.platform)),
      tlv(7, concat(u16(capabilities), u16(capabilities))),
      ...m.addresses.map((address) =>
        tlv(8, concat(new Uint8Array([5, 1]), ip4(address), new Uint8Array([2]), u32(0), new Uint8Array([0])))
      ),
      u16(0)
    ),
  };
}
export function decodeDiscovery(bytes: Uint8Array, protocol: 'CDP' | 'LLDP') {
  const decoder = new TextDecoder('utf-8', { fatal: true }),
    fields: { type: number; value: Uint8Array }[] = [];
  let at = 0,
    ttl: number | undefined;
  if (protocol === 'CDP') {
    need(bytes, 0, 12);
    if (
      snap.some((value, i) => bytes[i] !== value) ||
      ![1, 2].includes(bytes[8]) ||
      cdpChecksum(bytes.subarray(8))
    )
      throw new Error('Invalid CDP SNAP/header/checksum.');
    ttl = bytes[9];
    at = 12;
  }
  let ended = false;
  while (at < bytes.length) {
    need(bytes, at, protocol === 'CDP' ? 4 : 2);
    const header = view(bytes).getUint16(at),
      type = protocol === 'CDP' ? header : header >>> 9;
    const size = protocol === 'CDP' ? view(bytes).getUint16(at + 2) : header & 511,
      offset = protocol === 'CDP' ? 4 : 2;
    if (protocol === 'CDP' && size < 4) throw new Error('Invalid CDP TLV length.');
    const length = protocol === 'CDP' ? size - 4 : size;
    need(bytes, at + offset, length);
    if (protocol === 'LLDP' && type === 0) {
      if (length) throw new Error('Invalid LLDP end TLV.');
      ended = true;
      break;
    }
    fields.push({ type, value: bytes.slice(at + offset, at + offset + length) });
    if (fields.length > 128) throw new Error('Too many discovery TLVs.');
    at += offset + length;
  }
  if (protocol === 'LLDP') {
    if (
      !ended ||
      fields[0]?.type !== 1 ||
      fields[1]?.type !== 2 ||
      fields[2]?.type !== 3 ||
      fields[0].value.length < 2 ||
      fields[1].value.length < 2 ||
      fields[2].value.length !== 2
    )
      throw new Error('Invalid mandatory LLDP TLVs.');
    if ([1, 2, 3].some((type) => fields.filter((f) => f.type === type).length !== 1))
      throw new Error('Duplicate mandatory LLDP TLV.');
    ttl = view(fields[2].value).getUint16(0);
  }
  const value = (type: number) => fields.find((f) => f.type === type)?.value;
  const device = value(protocol === 'CDP' ? 1 : 5),
    port = value(protocol === 'CDP' ? 3 : 2);
  const voice = protocol === 'CDP' ? value(0x000e) : undefined,
    query = protocol === 'CDP' ? value(0x000f) : undefined;
  if (
    voice &&
    (voice.length !== 3 || voice[0] !== 1 || view(voice).getUint16(1) < 1 || view(voice).getUint16(1) > 4094)
  )
    throw new Error('Invalid CDP voice VLAN reply.');
  if (query && query.length < 3) throw new Error('Invalid CDP voice VLAN query.');
  if (protocol === 'CDP' && [0x000e, 0x000f].some((t) => fields.filter((f) => f.type === t).length > 1))
    throw new Error('Duplicate CDP voice VLAN TLV.');
  return {
    protocol,
    ttl: ttl!,
    deviceId: device ? decoder.decode(device) : undefined,
    portId: port ? decoder.decode(protocol === 'CDP' ? port : port.subarray(1)) : undefined,
    ...(voice ? { voiceVlan: view(voice).getUint16(1) } : {}),
    ...(query ? { voiceVlanQuery: true } : {}),
    fields,
  };
}
