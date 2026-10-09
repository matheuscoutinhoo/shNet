import { frameSchema, type Device, type Frame, type Link, type Snapshot } from '../model';
import { modelOpen, modelSeal } from './model-cipher';
import { hashHex, sealRecord, openRecord } from './security-crypto';
function securityPeer(s: Snapshot, d: Device, l: Link) {
  const w = d.wireless!;
  if (w.role === 'client') return w.association;
  const remote = l.a.device === d.id ? l.b : l.a,
    other = s.devices.find((v) => v.id === remote.device);
  return w.peers.find(
    (p) => p.mac === other?.interfaces.find((p) => p.id === remote.port)?.mac && p.phase === 'associated'
  );
}
export function protectWireless(s: Snapshot, d: Device, l: Link, frame: Frame): Frame {
  const w = d.wireless!;
  if (w.security === 'open' || frame.wifi || frame.secure) return frame;
  const peer = securityPeer(s, d, l);
  if (!peer) throw new Error('Associação de chave wireless ausente.');
  peer.txSequence = (peer.txSequence ?? 0) + 1;
  const nonce = peer.token + '|' + peer.nonce + '|' + peer.txSequence,
    encrypted =
      w.security === 'wpa2-enterprise'
        ? sealRecord(
            hashHex(peer.pmk + '|' + peer.nonce + '|' + peer.token),
            w.role === 'client' ? 0 : 1,
            peer.txSequence,
            JSON.stringify(frameSchema.parse(frame)),
            peer.token
          )
        : undefined,
    sealed = encrypted
      ? { body: encrypted.slice(0, -32), tag: encrypted.slice(-32) }
      : modelSeal(JSON.stringify(frameSchema.parse(frame)), w.key!, nonce),
    remote = l.a.device === d.id ? l.b : l.a;
  const src = d.interfaces.find((p) => p.id === w.port)!.mac,
    dst = s.devices.find((v) => v.id === remote.device)!.interfaces.find((p) => p.id === remote.port)!.mac;
  return {
    src,
    dst,
    etherType: '802.11-secure',
    hops: frame.hops,
    secure: {
      token: peer.token,
      sequence: peer.txSequence,
      cipher:
        w.security === 'wpa2-enterprise'
          ? 'AES-GCM'
          : w.security === 'wpa2-psk'
            ? 'CCMP-model'
            : 'GCMP-model',
      innerBytes: frame.packet?.bytes ?? frame.fragment?.bytes ?? frame.ipv6?.bytes ?? 28,
      ...sealed,
    },
  };
}
export function unprotectWireless(s: Snapshot, d: Device, l: Link, frame: Frame): Frame {
  const w = d.wireless!,
    encrypted = frame.secure;
  if (!encrypted) throw new Error('Ciphertext wireless ausente.');
  const peer = securityPeer(s, d, l),
    source = s.devices
      .find((v) => v.id === (l.a.device === d.id ? l.b.device : l.a.device))
      ?.interfaces.find((p) => p.id === (l.a.device === d.id ? l.b.port : l.a.port))?.mac;
  if (
    w.security === 'open' ||
    !peer ||
    encrypted.token !== peer.token ||
    source !== frame.src ||
    encrypted.cipher !==
      (w.security === 'wpa2-enterprise'
        ? 'AES-GCM'
        : w.security === 'wpa2-psk'
          ? 'CCMP-model'
          : 'GCMP-model') ||
    (w.security === 'wpa2-enterprise' && !peer.pmk)
  )
    throw new Error('Chave/associação wireless incompatíveis.');
  const seen = (peer.receivedSequences ??= []),
    max = Math.max(0, ...seen);
  const plaintext =
      w.security === 'wpa2-enterprise'
        ? openRecord(
            hashHex(peer.pmk + '|' + peer.nonce + '|' + peer.token),
            w.role === 'client' ? 1 : 0,
            encrypted.sequence,
            encrypted.body + encrypted.tag,
            peer.token
          )
        : modelOpen(
            encrypted.body,
            encrypted.tag,
            w.key!,
            peer.token + '|' + peer.nonce + '|' + encrypted.sequence
          ),
    inner = frameSchema.parse(JSON.parse(plaintext));
  if (seen.includes(encrypted.sequence) || encrypted.sequence <= max - 64)
    throw new Error('Replay wireless recusado.');
  if (
    inner.secure ||
    inner.wifi ||
    encrypted.innerBytes !== (inner.packet?.bytes ?? inner.fragment?.bytes ?? inner.ipv6?.bytes ?? 28)
  )
    throw new Error('MSDU wireless incompatível.');
  peer.receivedSequences = [...seen, encrypted.sequence].sort((a, b) => a - b).slice(-64);
  return { ...inner, hops: frame.hops };
}
