import { describe, it, expect } from 'vitest';
import {
  encodeSyslog,
  decodeSyslog,
  syslogMessageSize,
  encodeEthernet,
  decodeEthernet,
  exportPcap,
  decodePcap,
  validateSnapshot,
  SimulationEngine,
} from '../packages/simulation-engine/src';
import { text, concat, checksum, pseudo, ip4 } from '../packages/simulation-engine/src/wire/binary';
import { legacyManagementBytes } from '../packages/simulation-engine/src/protocols/management-wire';
import { syslogCaptureFixture } from './fixtures/syslog-captures';
import { quotePacket } from '../packages/simulation-engine/src/protocols/icmp';

const message = {
  id: 'syslog-1',
  timestamp: 1234.5,
  hostname: 'PC-01',
  facility: 23,
  severity: 5,
  appName: 'netos',
  text: 'Rede em operação 🌐',
};
const frame = () => ({
  src: '02:00:00:00:00:01',
  dst: '02:00:00:00:00:02',
  etherType: 'IPv4' as const,
  vlan: 100,
  hops: 32,
  packet: {
    protocol: 'UDP' as const,
    src: '192.0.2.1',
    dst: '192.0.2.2',
    ttl: 64,
    sourcePort: 55000,
    destinationPort: 514,
    bytes: 28 + syslogMessageSize(message),
    payload: { protocol: 'SYSLOG' as const, message },
  },
});

describe('Syslog RFC 5424 em UDP/514', () => {
  it('preserva comprimentos originais também nas citações TCP e ICMP após tradução', () => {
    const base = frame();
    const packets = [
      {
        protocol: 'TCP' as const,
        src: '192.0.2.1',
        dst: '192.0.2.2',
        ttl: 64,
        sourcePort: 50000,
        destinationPort: 80,
        sequence: 17,
        acknowledgment: 0,
        flags: ['SYN' as const],
        window: 65535,
        data: '',
        bytes: 40,
      },
      {
        protocol: 'ICMP' as const,
        src: '192.0.2.1',
        dst: '192.0.2.2',
        ttl: 64,
        kind: 'echo-request' as const,
        probeId: 'probe-1',
        bytes: 100,
      },
    ];
    for (const packet of packets) {
      const q = quotePacket(packet)!;
      q.src = '198.51.100.1';
      q.dst = '203.0.113.2';
      q.ttl = 60;
      if (q.protocol === 'TCP') {
        q.sourcePort = 61000;
        q.sequence = 123;
      }
      if (q.protocol === 'ICMP') q.probeId = 'translated-probe';
      const changed =
        q.protocol === 'TCP' && packet.protocol === 'TCP'
          ? { ...packet, src: q.src, dst: q.dst, ttl: q.ttl, sourcePort: q.sourcePort, sequence: q.sequence }
          : {
              ...packets[1],
              src: q.src,
              dst: q.dst,
              ttl: q.ttl,
              probeId: q.protocol === 'ICMP' ? q.probeId : '',
            };
      const expected = encodeEthernet({ ...base, vlan: undefined, packet: changed }).subarray(14, 42);
      const wire = encodeEthernet({
        ...base,
        vlan: undefined,
        packet: {
          protocol: 'ICMP',
          src: q.dst,
          dst: q.src,
          ttl: 64,
          kind: 'unreachable',
          probeId: 'err-1',
          bytes: 56,
          error: { code: 3, quote: q },
        },
      });
      expect(wire.subarray(42)).toEqual(expected);
    }
  });
  it('conserva o cabeçalho UDP citado no ICMP e atualiza checksums quando NAT muda a tupla', () => {
    const f = frame(),
      q = quotePacket(f.packet)!;
    if (q.protocol !== 'UDP') throw new Error('Citação ausente');
    q.src = '198.51.100.1';
    q.dst = '203.0.113.5';
    q.sourcePort = 61000;
    q.destinationPort = 1514;
    q.ttl = 63;
    const quotedPacket = {
      ...f.packet,
      src: q.src,
      dst: q.dst,
      ttl: q.ttl,
      sourcePort: q.sourcePort,
      destinationPort: q.destinationPort,
    };
    // Use a valid syslog port to encode the original payload, then independently
    // calculate the translated UDP header with the generic checksum helper.
    const original = encodeEthernet({ ...f, vlan: undefined }).subarray(14),
      expected = original.slice(0, 28);
    const v = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
    const udp = original.slice(20);
    const u = new DataView(udp.buffer, udp.byteOffset, udp.byteLength);
    u.setUint16(0, quotedPacket.sourcePort);
    u.setUint16(2, quotedPacket.destinationPort);
    u.setUint16(6, 0);
    u.setUint16(6, checksum(concat(pseudo(q.src, q.dst, 17, udp.length), udp)) || 65535);
    expected.set(ip4(q.src), 12);
    expected.set(ip4(q.dst), 16);
    expected[8] = 63;
    expected.set(udp.subarray(0, 8), 20);
    v.setUint16(10, 0);
    v.setUint16(10, checksum(expected.subarray(0, 20)));
    const outer = {
      ...f,
      vlan: undefined,
      packet: {
        protocol: 'ICMP' as const,
        src: '203.0.113.5',
        dst: q.src,
        ttl: 64,
        kind: 'unreachable' as const,
        probeId: 'icmp-1',
        bytes: 56,
        error: { code: 3 as const, quote: q },
      },
    };
    expect(encodeEthernet(outer).subarray(42)).toEqual(expected);
    const old = { ...q };
    delete old.wireHeader;
    expect(() =>
      encodeEthernet({ ...outer, packet: { ...outer.packet, error: { code: 3, quote: old } } })
    ).toThrow('legada');
  });
  it('codifica PRI, hostname, aplicação e BOM UTF-8 sem inventar UTC ou IDs de processo', () => {
    const bytes = encodeSyslog(message),
      decoded = decodeSyslog(bytes);
    expect(new TextDecoder().decode(bytes)).toBe('<189>1 - PC-01 netos - - - \uFEFFRede em operação 🌐');
    expect(decoded).toMatchObject({
      version: 1,
      priority: 189,
      facility: 23,
      severity: 5,
      hostname: 'PC-01',
      appName: 'netos',
      processId: '-',
      messageId: '-',
      timestamp: null,
      structuredData: null,
      unicode: true,
      text: message.text,
    });
    expect(bytes.length).toBe(syslogMessageSize(message));
  });
  it('preserva mensagens começando por BOM, quebras de linha, espaços e limites de severidade', () => {
    for (const value of ['\uFEFFprefixo', ' linhas\nseparadas\t ', '🌐'.repeat(150), 'ç'.repeat(300)])
      expect(decodeSyslog(encodeSyslog({ ...message, text: value })).text).toBe(value);
    for (const facility of [0, 23])
      for (const severity of [0, 7])
        expect(decodeSyslog(encodeSyslog({ ...message, facility, severity }))).toMatchObject({
          facility,
          severity,
        });
  });
  it('não converte Unicode inválido silenciosamente e não interpreta bytes sem BOM como UTF-8 declarado', () => {
    expect(() => encodeSyslog({ ...message, text: '\ud800' })).toThrow('Unicode');
    const raw = text('<0>1 - host app - - - plain');
    expect(decodeSyslog(raw)).toMatchObject({ unicode: false, text: undefined, message: text('plain') });
    expect(decodeSyslog(text('<0>1 - host app - - -')).message).toHaveLength(0);
    expect(() =>
      decodeSyslog(concat(text('<0>1 - host app - - - '), new Uint8Array([239, 187, 191, 192, 175])))
    ).toThrow();
  });
  it('recusa cabeçalhos, PRI, versão, limites e perfis não implementados', () => {
    for (const value of [
      '',
      '<192>1 - host app - - - x',
      '<01>1 - host app - - - x',
      '<1>2 - host app - - - x',
      '<1>1 - host',
      '<1>1 - hóst app - - - x',
      '<1>1 - host ' + 'x'.repeat(49) + ' - - - x',
      '<1>1 2026-10-15T00:00:00Z host app - - - x',
      '<1>1 - host app - - [meta] x',
    ])
      expect(() => decodeSyslog(text(value))).toThrow('Syslog');
    expect(() => decodeSyslog(new Uint8Array(65508))).toThrow('tamanho');
  });
  it('gera Ethernet/VLAN/IP/UDP com comprimentos e checksums coerentes', () => {
    const f = frame(),
      bytes = encodeEthernet(f);
    expect(bytes.length).toBe(18 + f.packet.bytes);
    expect(decodeEthernet(bytes)).toMatchObject({
      vlan: 100,
      transport: { syslog: { text: message.text, priority: 189 } },
    });
    bytes[bytes.length - 1] ^= 1;
    expect(() => decodeEthernet(bytes)).toThrow('Checksum');
    expect(() => encodeEthernet({ ...f, packet: { ...f.packet, destinationPort: 515 } })).toThrow('UDP/514');
    expect(() => encodeEthernet({ ...f, packet: { ...f.packet, bytes: f.packet.bytes + 1 } })).toThrow(
      'padding'
    );
  });
  it('simula PAT, ACL, perda, filtro, coletor fora e retomada determinística com captura legível', () => {
    const { engine, restored, router, collector } = syslogCaptureFixture();
    expect(engine.snapshot()).toEqual(restored.snapshot());
    expect(collector.syslogServer!.entries).toHaveLength(3);
    expect(collector.syslogServer!.entries[0]).toMatchObject({
      source: router.interfaces[1].ip,
      message: { text: 'Rede em operação 🌐 — temperatura 23 °C' },
    });
    expect(collector.syslogServer!.entries.map((e) => e.message.text).join(' ')).not.toMatch(
      /Debug filtrado|Negado pela ACL|Perdido no enlace|Coletor indisponível/
    );
    expect(engine.state.events.some((e) => e.type === 'ACL_DENY')).toBe(true);
    expect(engine.state.events.some((e) => e.type === 'SYSLOG_FILTERED')).toBe(true);
    const capture = exportPcap(engine.snapshot());
    expect(capture.excluded).toEqual([]);
    expect(capture.dropped).toBe(0);
    const records = decodePcap(capture.bytes);
    expect(
      records.some(
        (p) => p.frame.src === router.interfaces[1].ip && p.frame.transport?.syslog?.priority === 189
      )
    ).toBe(true);
  });
  it('aceita snapshots legados, declara sua omissão de captura e rejeita tamanhos adulterados', () => {
    const { engine } = syslogCaptureFixture(),
      snapshot = engine.snapshot(),
      f = frame();
    f.packet.bytes = legacyManagementBytes(f.packet.payload);
    snapshot.capture!.frames[0].frame = f;
    const capture = exportPcap(snapshot);
    expect(capture.excluded).toHaveLength(1);
    expect(capture.excluded[0].reason).toContain('legado');
    const pending = new SimulationEngine(snapshot);
    const client = pending.state.devices.find((d) => d.type === 'pc')!;
    pending.sendSyslog(client.id, 'Compatibilidade', 4);
    for (let i = 0; i < 100; i++) {
      const delivery = pending.state.queue.find(
        (q) =>
          q.action.kind === 'deliver' &&
          q.action.frame.packet?.protocol === 'UDP' &&
          q.action.frame.packet.payload.protocol === 'SYSLOG'
      );
      if (delivery?.action.kind === 'deliver' && delivery.action.frame.packet?.protocol === 'UDP') {
        const p = delivery.action.frame.packet;
        if (p.payload.protocol !== 'SYSLOG') throw new Error('Fixture ausente');
        p.bytes = legacyManagementBytes(p.payload);
        validateSnapshot(pending.snapshot());
        p.bytes++;
        expect(() => validateSnapshot(pending.snapshot())).toThrow('Comprimento');
        break;
      }
      pending.step();
      if (i === 99) throw new Error('Datagrama pendente ausente');
    }
  });
  it('recusa Unicode inválido antes do envio e descarta comprimento adulterado no coletor', () => {
    const { engine, client, collector } = syslogCaptureFixture();
    expect(() => engine.sendSyslog(client.id, '\ud800', 4)).toThrow('Unicode');
    const f = frame();
    f.packet.src = client.interfaces[0].ip!;
    f.packet.dst = collector.interfaces[0].ip!;
    f.packet.payload.message.timestamp = engine.state.clock;
    f.packet.bytes++;
    engine.sendIp(client.id, f.packet);
    engine.advanceTo(1400);
    expect(collector.syslogServer!.entries).toHaveLength(3);
    expect(engine.state.events.some((e) => e.reason.includes('Syslog: datagrama'))).toBe(true);
  });
});
