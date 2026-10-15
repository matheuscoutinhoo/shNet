import { concat, ip4, need, text, u16, u32, view } from '../wire/binary';
import { BGP, bgpMessageSchema, type BgpMessage, type BgpPath } from './bgp-model';
import { decodeEvpnNlri, encodeEvpnUpdates, type EvpnCodecContext } from './evpn-codec';

const bytes = (...values: number[]) => Uint8Array.from(values);
export const bgpByteString = (value: Uint8Array) => String.fromCharCode(...value);
export const bgpOctets = (value: string) => Uint8Array.from(value, (c) => c.charCodeAt(0));
export const readBgpIp = (value: Uint8Array) => Array.from(value).join('.');
export const bgpAttribute = (flags: number, code: number, value: Uint8Array) =>
  concat(
    bytes(flags | (value.length > 255 ? 16 : 0), code),
    value.length > 255 ? u16(value.length) : bytes(value.length),
    value
  );

export function bgpFrame(type: number, body = new Uint8Array()) {
  const size = 19 + body.length;
  if (size > BGP.maxMessage) throw new Error('Mensagem BGP excede 4096 octetos.');
  return concat(new Uint8Array(16).fill(255), u16(size), bytes(type), body);
}

// Returns undefined only for an incomplete frame. Invalid complete headers fail
// immediately, including a bogus length that would otherwise stall a stream.
export function bgpFrameLength(value: Uint8Array) {
  if (value.subarray(0, Math.min(16, value.length)).some((b) => b !== 255))
    throw new Error('Marker BGP inválido.');
  if (value.length < 19) return undefined;
  const size = view(value).getUint16(16),
    type = value[18];
  if (size < 19 || size > BGP.maxMessage || type < 1 || type > 4 || (type === 4 && size !== 19))
    throw new Error('Cabeçalho BGP inválido.');
  return size;
}

function nlri(prefix: { network: string; prefix: number }) {
  const number = ip4(prefix.network).reduce((n, octet) => n * 256 + octet, 0);
  if (number % 2 ** (32 - prefix.prefix)) throw new Error('Rede BGP não canônica.');
  return concat(bytes(prefix.prefix), ip4(prefix.network).subarray(0, Math.ceil(prefix.prefix / 8)));
}
function readNlri(value: Uint8Array) {
  const result: { network: string; prefix: number }[] = [];
  for (let at = 0; at < value.length;) {
    const prefix = value[at++],
      size = Math.ceil(prefix / 8);
    if (prefix > 32) throw new Error('Prefixo BGP IPv4 inválido.');
    need(value, at, size);
    const address = new Uint8Array(4);
    address.set(value.subarray(at, at + size));
    if (prefix % 8 && address[size - 1] & ((1 << (8 - (prefix % 8))) - 1))
      throw new Error('Bits de host não canônicos no NLRI.');
    result.push({ network: readBgpIp(address), prefix });
    at += size;
  }
  return result;
}
export function bgpPathAttributes(path: Pick<BgpPath, 'asPath'> & Partial<BgpPath>) {
  return concat(
    bgpAttribute(64, 1, bytes(path.origin === 'EGP' ? 1 : path.origin === 'INCOMPLETE' ? 2 : 0)),
    bgpAttribute(
      64,
      2,
      path.asPath.length ? concat(bytes(2, path.asPath.length), ...path.asPath.map(u32)) : new Uint8Array()
    ),
    ...(path.nextHop ? [bgpAttribute(64, 3, ip4(path.nextHop))] : []),
    ...(path.med !== undefined ? [bgpAttribute(128, 4, u32(path.med))] : []),
    ...(path.localPref !== undefined ? [bgpAttribute(64, 5, u32(path.localPref))] : []),
    ...(path.originatorId ? [bgpAttribute(128, 9, ip4(path.originatorId))] : []),
    ...(path.clusterList?.length ? [bgpAttribute(128, 10, concat(...path.clusterList.map(ip4)))] : [])
  );
}
export function bgpUpdate(
  attributes: Uint8Array,
  announced = new Uint8Array(),
  withdrawn = new Uint8Array()
) {
  return bgpFrame(2, concat(u16(withdrawn.length), withdrawn, u16(attributes.length), attributes, announced));
}

// Distinct paths get distinct UPDATEs: an UPDATE has one shared attribute set.
// The caller queues the complete batch atomically before marking it advertised.
export function encodeBgp(
  message: BgpMessage,
  context: EvpnCodecContext & { internal?: boolean } = {}
): Uint8Array[] {
  message = bgpMessageSchema.parse(message);
  switch (message.type) {
    case 'OPEN': {
      const capabilities = concat(
        bytes(65, 4),
        u32(message.asn),
        ...(message.evpn ? [bytes(1, 4, 0, 25, 0, 70)] : [])
      );
      const options = concat(bytes(2, capabilities.length), capabilities);
      return [
        bgpFrame(
          1,
          concat(
            bytes(4),
            u16(message.asn > 65535 ? 23456 : message.asn),
            u16(message.holdMs / 1000),
            ip4(message.routerId),
            bytes(options.length),
            options
          )
        ),
      ];
    }
    case 'KEEPALIVE':
      return [bgpFrame(4)];
    case 'NOTIFICATION':
      return [bgpFrame(3, concat(bytes(message.code, 0), text(message.reason)))];
    case 'UPDATE': {
      const frames: Uint8Array[] = [];
      if (message.withdrawn.length)
        frames.push(bgpUpdate(new Uint8Array(), new Uint8Array(), concat(...message.withdrawn.map(nlri))));
      for (const path of message.announcements)
        frames.push(
          bgpUpdate(
            bgpPathAttributes(context.internal === false ? { ...path, localPref: undefined } : path),
            nlri(path)
          )
        );
      frames.push(...encodeEvpnUpdates(message, context));
      return frames.length ? frames : [bgpUpdate(new Uint8Array())];
    }
  }
}

export function decodeBgp(value: Uint8Array): BgpMessage {
  const size = bgpFrameLength(value);
  if (size !== value.length) throw new Error('Comprimento BGP não corresponde ao frame.');
  const body = value.subarray(19),
    type = value[18];
  if (type === 4) return { type: 'KEEPALIVE' };
  if (type === 3) {
    need(body, 0, 2);
    return bgpMessageSchema.parse({
      type: 'NOTIFICATION',
      code: body[0],
      reason:
        new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(2)).slice(0, 120) ||
        `BGP ${body[0]}/${body[1]}`,
    });
  }
  if (type === 1) {
    need(body, 0, 10);
    if (body[0] !== 4 || body.length !== 10 + body[9]) throw new Error('OPEN BGP inválido.');
    let asn: number | undefined,
      evpn = false;
    for (let at = 10; at < body.length;) {
      need(body, at, 2);
      const kind = body[at++],
        length = body[at++],
        end = at + length;
      need(body, at, length);
      if (kind !== 2) throw new Error('Parâmetro OPEN não suportado.');
      while (at < end) {
        need(body.subarray(0, end), at, 2);
        const code = body[at++],
          len = body[at++];
        need(body.subarray(0, end), at, len);
        if (code === 65) {
          if (len !== 4 || asn !== undefined) throw new Error('Capacidade AS4 inválida.');
          asn = view(body).getUint32(at);
        } else if (code === 1) {
          if (len !== 4 || body[at + 2] !== 0) throw new Error('Capacidade MP inválida.');
          evpn ||= view(body).getUint16(at) === 25 && body[at + 3] === 70;
        }
        at += len;
      }
    }
    if (asn === undefined || view(body).getUint16(1) !== (asn > 65535 ? 23456 : asn))
      throw new Error('A sessão binária exige capacidade AS4 consistente.');
    return bgpMessageSchema.parse({
      type: 'OPEN',
      version: 4,
      asn,
      holdMs: view(body).getUint16(3) * 1000,
      routerId: readBgpIp(body.subarray(5, 9)),
      ...(evpn ? { evpn: true } : {}),
    });
  }
  need(body, 0, 2);
  const withdrawnSize = view(body).getUint16(0),
    attrStart = 4 + withdrawnSize;
  need(body, 2, withdrawnSize + 2);
  const attributesSize = view(body).getUint16(2 + withdrawnSize),
    attrEnd = attrStart + attributesSize;
  need(body, attrStart, attributesSize);
  const attrs = new Map<number, Uint8Array>();
  const expectedFlags: Record<number, number> = {
    1: 64,
    2: 64,
    3: 64,
    4: 128,
    5: 64,
    9: 128,
    10: 128,
    14: 128,
    15: 128,
    16: 192,
    22: 192,
  };
  for (let at = attrStart; at < attrEnd;) {
    need(body.subarray(0, attrEnd), at, 3);
    const flags = body[at++],
      code = body[at++],
      extended = !!(flags & 16);
    need(body.subarray(0, attrEnd), at, extended ? 2 : 1);
    const len = extended ? view(body).getUint16(at) : body[at];
    at += extended ? 2 : 1;
    need(body.subarray(0, attrEnd), at, len);
    if (attrs.has(code) || (expectedFlags[code] !== undefined && (flags & 239) !== expectedFlags[code]))
      throw new Error('Atributo BGP duplicado ou flags inválidas.');
    if (expectedFlags[code] === undefined && !(flags & 128))
      throw new Error('Atributo obrigatório BGP desconhecido.');
    attrs.set(code, body.subarray(at, at + len));
    at += len;
  }
  const prefixes = readNlri(body.subarray(attrEnd)),
    withdrawn = readNlri(body.subarray(2, 2 + withdrawnSize));
  const announced = prefixes.length > 0 || attrs.has(14);
  let path: Omit<BgpPath, 'network' | 'prefix'> | undefined;
  if (announced) {
    const origin = attrs.get(1),
      as = attrs.get(2),
      next = attrs.get(3);
    if (!origin || origin.length !== 1 || origin[0] > 2 || !as || (prefixes.length && next?.length !== 4))
      throw new Error('UPDATE sem atributos obrigatórios válidos.');
    const asPath: number[] = [];
    for (let at = 0; at < as.length;) {
      need(as, at, 2);
      const segment = as[at++],
        count = as[at++];
      if (segment !== 2 || !count) throw new Error('Somente AS_SEQUENCE é suportado.');
      need(as, at, count * 4);
      for (let i = 0; i < count; i++, at += 4) asPath.push(view(as).getUint32(at));
    }
    const number = (code: number, fallback: number) => {
      const attribute = attrs.get(code);
      if (!attribute) return fallback;
      if (attribute.length !== 4) throw new Error('Atributo BGP numérico inválido.');
      return view(attribute).getUint32(0);
    };
    const originator = attrs.get(9),
      clusters = attrs.get(10);
    if ((originator && originator.length !== 4) || (clusters && clusters.length % 4))
      throw new Error('Atributo RR inválido.');
    path = {
      nextHop: next ? readBgpIp(next) : '0.0.0.0',
      asPath,
      origin: (['IGP', 'EGP', 'INCOMPLETE'] as const)[origin[0]],
      localPref: number(5, 100),
      med: number(4, 0),
      ...(originator ? { originatorId: readBgpIp(originator) } : {}),
      ...(clusters
        ? {
            clusterList: Array.from({ length: clusters.length / 4 }, (_, i) =>
              readBgpIp(clusters.subarray(i * 4, i * 4 + 4))
            ),
          }
        : {}),
    };
  }
  return bgpMessageSchema.parse({
    type: 'UPDATE',
    announcements: prefixes.map((prefix) => ({ ...prefix, ...path! })),
    withdrawn,
    ...decodeEvpnNlri(attrs, path?.asPath ?? []),
  });
}
