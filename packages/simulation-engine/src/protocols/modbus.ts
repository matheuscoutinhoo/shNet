import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { modbusConfigSchema, modbusRequestSchema, type ModbusRequest } from './modbus-model';
import type { SimulationEngine } from '../core/engine';
import type { Device, Snapshot } from '../model';
import type { TcpConnection } from './tcp-model';
import { tcpBytes } from './tcp-model';
import { configureTcpService, queueTcpText } from './tcp-services';
import { openTcp } from './tcp';
export const packBits = (values: boolean[]) =>
  Array.from({ length: Math.ceil(values.length / 8) }, (_, i) =>
    values.slice(i * 8, i * 8 + 8).reduce((n, v, bit) => n | (Number(v) << bit), 0)
  );
const word = (n: number) => [n >>> 8, n & 255];
function envelope(
  transaction: number,
  unit: number,
  pdu: number[],
  encoding: 'binary' | 'legacy-hex' = 'binary'
) {
  const bytes = new Uint8Array([...word(transaction), 0, 0, ...word(pdu.length + 1), unit, ...pdu]);
  return encoding === 'binary' ? String.fromCharCode(...bytes) : bytesToHex(bytes) + '\n';
}
export function encodeModbusRequest(input: unknown, encoding: 'binary' | 'legacy-hex' = 'binary') {
  const r = modbusRequestSchema.parse(input);
  const packed = packBits(r.values.map(Boolean));
  const pdu = [1, 2, 3, 4].includes(r.function)
    ? [r.function, ...word(r.address), ...word(r.quantity)]
    : [5, 6].includes(r.function)
      ? [r.function, ...word(r.address), ...word(r.function === 5 ? (r.values[0] ? 0xff00 : 0) : r.values[0])]
      : [
          r.function,
          ...word(r.address),
          ...word(r.quantity),
          r.function === 15 ? packed.length : r.values.length * 2,
          ...(r.function === 15 ? packed : r.values.flatMap(word)),
        ];
  return envelope(r.transaction, r.unit, pdu, encoding);
}
export function decodeModbus(input: string | Uint8Array) {
  const binary = typeof input !== 'string' || input.includes('\0');
  if (typeof input === 'string' && !binary && !/^(?:[a-f0-9]{2}){9,260}$/.test(input.trim()))
    throw new Error('Modbus: octetos inválidos.');
  if (typeof input === 'string' && binary && Array.from(input).some((c) => c.charCodeAt(0) > 255))
    throw new Error('Modbus: octetos inválidos.');
  const b =
    typeof input !== 'string'
      ? input
      : binary
        ? Uint8Array.from(input, (c) => c.charCodeAt(0))
        : hexToBytes(input.trim());
  if (b.length < 9 || b.length > 260) throw new Error('Modbus: tamanho inválido.');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint16(2) !== 0 || v.getUint16(4) !== b.length - 6) throw new Error('Modbus: MBAP inválido.');
  return {
    transaction: v.getUint16(0),
    unit: b[6],
    function: b[7],
    pdu: b.slice(7),
    exception: b[7] & 128 ? b[8] : undefined,
  };
}
// Return one complete ADU, retaining coalesced/partial frames for the next read.
export function modbusFrameLength(data: string, encoding?: 'binary') {
  if (encoding !== 'binary') {
    const n = data.indexOf('\n');
    return n < 0 ? undefined : n + 1;
  }
  if (data.length < 6) return undefined;
  const protocol = (data.charCodeAt(2) << 8) | data.charCodeAt(3);
  const length = (data.charCodeAt(4) << 8) | data.charCodeAt(5);
  if (protocol !== 0 || length < 3 || length > 254) throw new Error('Modbus: MBAP inválido.');
  return data.length >= 6 + length ? 6 + length : undefined;
}
export function configureModbus(e: SimulationEngine, d: Device, input: unknown) {
  if (d.type !== 'server' && d.type !== 'router')
    throw new Error('Servidor Modbus exige PLC/servidor ou roteador.');
  const config = modbusConfigSchema.parse(input);
  if (d.tcpServices?.some((s) => s.port === config.port && s.kind !== 'modbus' && s.enabled))
    throw new Error('Porta Modbus ocupada por outro serviço.');
  if (d.modbus && d.modbus.port !== config.port)
    d.tcpServices = d.tcpServices?.filter((s) => s.port !== d.modbus!.port);
  configureTcpService(e, d, { port: config.port, kind: 'modbus', enabled: config.enabled });
  d.modbus = config;
}
export function modbusRequest(
  e: SimulationEngine,
  d: Device,
  target: string,
  input: unknown,
  port = 502,
  vrf?: string,
  scope?: string
) {
  const data = encodeModbusRequest(input);
  return openTcp(
    e,
    d,
    target,
    port,
    data,
    true,
    (c) => {
      c.service = 'modbus';
      c.encoding = 'binary';
      c.stream = { readBytes: 0, writtenBytes: 0 };
    },
    vrf,
    scope
  );
}
export function receiveModbus(e: SimulationEngine, d: Device, c: TcpConnection) {
  if (c.role === 'client') {
    try {
      if (modbusFrameLength(c.received, c.encoding) && c.responseAt === undefined)
        c.responseAt = e.state.clock;
    } catch (err) {
      e.drop(d, (err as Error).message);
      c.closeRequested = true;
    }
    return;
  }
  for (let count = 0; count < 64; count++) {
    try {
      const length = modbusFrameLength(c.received, c.encoding);
      if (!length) return;
      const line = c.received.slice(0, length);
      c.received = c.received.slice(length);
      c.bytesReceived = tcpBytes(c.received, c.encoding);
      c.stream!.readBytes += length;
      const request = decodeModbus(line),
        p = request.pdu,
        view = new DataView(p.buffer, p.byteOffset, p.byteLength),
        config = d.modbus;
      let exception = 0,
        pdu: number[] = [];
      if (!config?.enabled || request.unit !== config.unit) exception = 11;
      else if (![1, 2, 3, 4, 5, 6, 15, 16].includes(request.function)) exception = 1;
      else if (p.length < 5) exception = 3;
      else {
        const fn = request.function,
          address = view.getUint16(1),
          single = [5, 6].includes(fn),
          quantity = single ? 1 : view.getUint16(3);
        const bits = [1, 2, 5, 15].includes(fn),
          multiple = [15, 16].includes(fn);
        const limit = bits ? (fn === 15 ? 1968 : 2000) : fn === 16 ? 123 : 125;
        const byteCount = bits ? Math.ceil(quantity / 8) : quantity * 2;
        const bank =
          fn === 2
            ? (config.discreteInputs ?? [])
            : fn === 4
              ? (config.inputRegisters ?? [])
              : bits
                ? (config.coils ?? [])
                : config.registers;
        if (
          !quantity ||
          quantity > limit ||
          (!multiple && p.length !== 5) ||
          (multiple && (p.length !== 6 + byteCount || p[5] !== byteCount)) ||
          (fn === 5 && ![0, 0xff00].includes(view.getUint16(3)))
        )
          exception = 3;
        else if (address + quantity > 65536 || address + quantity > bank.length) exception = 2;
        else if (fn === 1 || fn === 2)
          pdu = [fn, byteCount, ...packBits((bank as boolean[]).slice(address, address + quantity))];
        else if (fn === 3 || fn === 4)
          pdu = [fn, byteCount, ...(bank as number[]).slice(address, address + quantity).flatMap(word)];
        else {
          if (bits) {
            const values = Array.from({ length: quantity }, (_, i) =>
              fn === 5 ? view.getUint16(3) === 0xff00 : !!(p[6 + (i >> 3)] & (1 << (i % 8)))
            );
            config.coils!.splice(address, quantity, ...values);
          } else {
            const values =
              fn === 6
                ? [view.getUint16(3)]
                : Array.from({ length: quantity }, (_, i) => view.getUint16(6 + i * 2));
            config.registers.splice(address, quantity, ...values);
          }
          pdu = [...p.slice(0, 5)];
          e.emit(
            'CONFIG_CHANGED',
            d.id,
            `Modbus: ${quantity} ${bits ? 'coils' : 'registradores'} atualizados a partir de ${address}.`
          );
        }
      }
      queueTcpText(
        c,
        envelope(
          request.transaction,
          request.unit,
          exception ? [request.function | 128, exception] : pdu,
          c.encoding === 'binary' ? 'binary' : 'legacy-hex'
        )
      );
    } catch (err) {
      e.emit('PACKET_DROPPED', d.id, (err as Error).message);
      c.closeRequested = true;
    }
  }
}
export function validateModbus(s: Snapshot) {
  for (const d of s.devices)
    if (
      d.modbus &&
      !d.tcpServices?.some(
        (t) => t.kind === 'modbus' && t.port === d.modbus!.port && t.enabled === d.modbus!.enabled
      )
    )
      throw new Error('Estado Modbus sem serviço TCP correspondente.');
}
export type { ModbusRequest };
