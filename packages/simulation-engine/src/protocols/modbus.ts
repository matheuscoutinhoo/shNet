import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { modbusConfigSchema, modbusRequestSchema, type ModbusRequest } from './modbus-model';
import type { SimulationEngine } from '../core/engine';
import type { Device, Snapshot } from '../model';
import type { TcpConnection } from './tcp-model';
import { tcpBytes } from './tcp-model';
import { configureTcpService, queueTcpText } from './tcp-services';
import { openTcp } from './tcp';
const word = (n: number) => [n >>> 8, n & 255];
function envelope(transaction: number, unit: number, pdu: number[]) {
  return (
    bytesToHex(new Uint8Array([...word(transaction), 0, 0, ...word(pdu.length + 1), unit, ...pdu])) + '\n'
  );
}
export function encodeModbusRequest(input: unknown) {
  const r = modbusRequestSchema.parse(input);
  const pdu =
    r.function === 3
      ? [3, ...word(r.address), ...word(r.quantity)]
      : r.function === 6
        ? [6, ...word(r.address), ...word(r.values[0])]
        : [16, ...word(r.address), ...word(r.quantity), r.values.length * 2, ...r.values.flatMap(word)];
  return envelope(r.transaction, r.unit, pdu);
}
export function decodeModbus(line: string) {
  if (!/^(?:[a-f0-9]{2}){9,260}$/.test(line.trim())) throw new Error('Modbus: octetos inválidos.');
  const b = hexToBytes(line.trim()),
    v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint16(2) !== 0 || v.getUint16(4) !== b.length - 6) throw new Error('Modbus: MBAP inválido.');
  return {
    transaction: v.getUint16(0),
    unit: b[6],
    function: b[7],
    pdu: b.slice(7),
    exception: b[7] & 128 ? b[8] : undefined,
  };
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
export function modbusRequest(e: SimulationEngine, d: Device, target: string, input: unknown, port = 502) {
  const data = encodeModbusRequest(input);
  return openTcp(e, d, target, port, data, true, (c) => {
    c.service = 'modbus';
    c.stream = { readBytes: 0, writtenBytes: 0 };
  });
}
export function receiveModbus(e: SimulationEngine, d: Device, c: TcpConnection) {
  if (c.role === 'client') {
    if (c.received.includes('\n') && c.responseAt === undefined) c.responseAt = e.state.clock;
    return;
  }
  for (let count = 0; c.received.includes('\n') && count < 64; count++) {
    const at = c.received.indexOf('\n'),
      line = c.received.slice(0, at);
    c.received = c.received.slice(at + 1);
    c.bytesReceived = tcpBytes(c.received);
    c.stream!.readBytes += at + 1;
    try {
      const request = decodeModbus(line),
        p = request.pdu,
        view = new DataView(p.buffer, p.byteOffset, p.byteLength),
        config = d.modbus;
      let exception = 0,
        pdu: number[] = [];
      if (!config?.enabled || request.unit !== config.unit) exception = 11;
      else if (![3, 6, 16].includes(request.function)) exception = 1;
      else if (p.length < 5) exception = 3;
      else {
        const address = view.getUint16(1),
          quantity = request.function === 6 ? 1 : view.getUint16(3);
        if (
          !quantity ||
          quantity > (request.function === 16 ? 123 : 125) ||
          (request.function !== 16 && p.length !== 5) ||
          (request.function === 16 && (p.length !== 6 + quantity * 2 || p[5] !== quantity * 2))
        )
          exception = 3;
        else if (address + quantity > config.registers.length) exception = 2;
        else if (request.function === 3)
          pdu = [3, quantity * 2, ...config.registers.slice(address, address + quantity).flatMap(word)];
        else {
          const values =
            request.function === 6
              ? [view.getUint16(3)]
              : Array.from({ length: quantity }, (_, i) => view.getUint16(6 + i * 2));
          config.registers.splice(address, quantity, ...values);
          pdu = [...p.slice(0, 5)];
          e.emit(
            'CONFIG_CHANGED',
            d.id,
            `Modbus: ${quantity} registradores atualizados a partir de ${address}.`
          );
        }
      }
      queueTcpText(
        c,
        envelope(request.transaction, request.unit, exception ? [request.function | 128, exception] : pdu)
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
