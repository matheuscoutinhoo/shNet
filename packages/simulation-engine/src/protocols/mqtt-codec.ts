import type { z } from 'zod';
import { mqttMessageSchema } from './applications-model';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
type Message = z.infer<typeof mqttMessageSchema>;
const str = (s: string) => {
  const b = new TextEncoder().encode(s);
  return [b.length >>> 8, b.length & 255, ...b];
};
export function encodeMqtt(input: Message) {
  const m = mqttMessageSchema.parse(input);
  let header: number,
    body: number[] = [];
  if (m.type === 'CONNECT') {
    header = 0x10;
    body = [...str('MQTT'), 4, 2, m.keepAlive >>> 8, m.keepAlive & 255, ...str(m.clientId)];
  } else if (m.type === 'CONNACK') {
    header = 0x20;
    body = [0, m.code];
  } else if (m.type === 'SUBSCRIBE') {
    header = 0x82;
    body = [m.id >>> 8, m.id & 255, ...str(m.topic), 0];
  } else if (m.type === 'SUBACK') {
    header = 0x90;
    body = [m.id >>> 8, m.id & 255, 0];
  } else if (m.type === 'PUBLISH') {
    header = 0x30 + Number(m.retain);
    body = [...str(m.topic), ...new TextEncoder().encode(m.payload)];
  } else header = m.type === 'PINGREQ' ? 0xc0 : m.type === 'PINGRESP' ? 0xd0 : 0xe0;
  const remaining: number[] = [];
  let n = body.length;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    remaining.push(b);
  } while (n);
  // TCP payloads in this simulator are UTF-8 strings; hex preserves every MQTT octet.
  return bytesToHex(new Uint8Array([header, ...remaining, ...body])) + '\n';
}
export function decodeMqtt(line: string): Message {
  if (line.length > 4096 || !/^([a-f0-9]{2})+$/.test(line)) throw new Error('MQTT: octetos inválidos.');
  const b = hexToBytes(line);
  let i = 1,
    n = 0,
    mult = 1,
    count = 0;
  let continuation: boolean;
  do {
    if (i >= b.length || ++count > 4) throw new Error('MQTT Remaining Length inválido.');
    const v = b[i++];
    n += (v & 127) * mult;
    mult *= 128;
    continuation = !!(v & 128);
  } while (continuation);
  if (i + n !== b.length) throw new Error('MQTT: tamanho incompatível.');
  const u16 = () => {
    if (i + 2 > b.length) throw new Error('MQTT truncado.');
    return b[i++] * 256 + b[i++];
  };
  const text = () => {
    const len = u16();
    if (i + len > b.length) throw new Error('MQTT string truncada.');
    const s = new TextDecoder('utf-8', { fatal: true }).decode(b.slice(i, i + len));
    i += len;
    return s;
  };
  let message: Message;
  if (b[0] === 0x10) {
    if (text() !== 'MQTT' || b[i++] !== 4 || b[i++] !== 2)
      throw new Error('MQTT requer 3.1.1 clean session.');
    const keepAlive = u16();
    message = { type: 'CONNECT', keepAlive, clientId: text() };
  } else if (b[0] === 0x20 && n === 2) {
    if (b[i++] !== 0) throw new Error('MQTT Session Present inesperado.');
    message = { type: 'CONNACK', code: b[i++] };
  } else if (b[0] === 0x82) {
    const id = u16(),
      topic = text();
    if (b[i++] !== 0) throw new Error('MQTT somente QoS 0.');
    message = { type: 'SUBSCRIBE', id, topic };
  } else if (b[0] === 0x90 && n === 3) {
    const id = u16();
    if (b[i++] !== 0) throw new Error('MQTT SUBACK QoS inválido.');
    message = { type: 'SUBACK', id };
  } else if (b[0] === 0x30 || b[0] === 0x31) {
    const topic = text(),
      payload = new TextDecoder('utf-8', { fatal: true }).decode(b.slice(i));
    i = b.length;
    message = { type: 'PUBLISH', topic, payload, retain: b[0] === 0x31 };
  } else if (n === 0 && [0xc0, 0xd0, 0xe0].includes(b[0]))
    message = { type: b[0] === 0xc0 ? 'PINGREQ' : b[0] === 0xd0 ? 'PINGRESP' : 'DISCONNECT' };
  else throw new Error('MQTT pacote ou flags não suportados.');
  if (i !== b.length) throw new Error('MQTT dados adicionais.');
  return mqttMessageSchema.parse(message);
}
export function mqttMatches(filter: string, topic: string) {
  const f = filter.split('/'),
    t = topic.split('/');
  return (
    f.every((v, i) => (v === '#' && i === f.length - 1) || (v === '+' && i < t.length) || v === t[i]) &&
    (f.at(-1) === '#' || f.length === t.length)
  );
}
export function validMqttFilter(filter: string) {
  return (
    !filter.includes('\0') &&
    filter
      .split('/')
      .every(
        (v, i, a) => (!v.includes('#') && !v.includes('+')) || v === '+' || (v === '#' && i === a.length - 1)
      )
  );
}
