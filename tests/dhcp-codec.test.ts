import { describe, it, expect } from 'vitest';
import {
  encodeDhcp4,
  decodeDhcp4,
  dhcp4MessageSize,
  dhcp4TransactionNumber,
  encodeEthernet,
  decodeEthernet,
  exportPcap,
  decodePcap,
  validateSnapshot,
  type DhcpMessage,
} from '../packages/simulation-engine/src';
import { concat } from '../packages/simulation-engine/src/wire/binary';
import { dhcpCaptureFixtures } from './fixtures/dhcp-captures';

const identity = { transactionId: 'dhcp-305419896', clientMac: '02:00:00:00:00:01', clientIp: '0.0.0.0' };
const ack: DhcpMessage = {
  ...identity,
  type: 'ack',
  server: '192.0.2.1',
  address: '192.0.2.100',
  prefix: 24,
  dns: ['192.0.2.53'],
  gateway: '192.0.2.1',
  leaseMs: 16000,
};
const raw = (...options: number[][]) =>
  concat(encodeDhcp4(ack).subarray(0, 240), ...options.map((b) => new Uint8Array(b)), new Uint8Array([255]));

describe('DHCPv4 binário e capturas interoperáveis', () => {
  it('integra VLAN/IPv4/UDP com checksums e recusa direção de portas incoerente', () => {
    const packet = {
      protocol: 'UDP' as const,
      src: '192.0.2.1',
      dst: '255.255.255.255',
      ttl: 64,
      sourcePort: 67,
      destinationPort: 68,
      bytes: 28 + dhcp4MessageSize(ack),
      payload: { protocol: 'DHCP' as const, message: ack },
    };
    const frame = {
      src: '02:00:00:00:00:02',
      dst: 'ff:ff:ff:ff:ff:ff',
      vlan: 100,
      etherType: 'IPv4' as const,
      hops: 32,
      packet,
    };
    const wire = encodeEthernet(frame);
    expect(decodeEthernet(wire)).toMatchObject({
      vlan: 100,
      transport: { dhcp4: { type: 'ack', leaseSeconds: 16 } },
    });
    expect(wire.length).toBe(18 + packet.bytes);
    wire[wire.length - 1] ^= 1;
    expect(() => decodeEthernet(wire)).toThrow('Checksum');
    expect(() => encodeEthernet({ ...frame, packet: { ...packet, sourcePort: 68 } })).toThrow('portas');
  });
  it('declara exclusões por xid opaco e lease fracionário, sem excluir os demais registros', () => {
    const { local } = dhcpCaptureFixtures(),
      snapshot = local.snapshot();
    const frame = snapshot.capture!.frames.find((v) => v.frame?.packet?.protocol === 'UDP')!.frame!;
    if (frame.packet?.protocol !== 'UDP' || frame.packet.payload.protocol !== 'DHCP')
      throw new Error('Fixture DHCP ausente.');
    frame.packet.payload.message.transactionId = 'opaque-legacy';
    const opaque = exportPcap(snapshot);
    expect(opaque.excluded).toHaveLength(1);
    expect(opaque.excluded[0].reason).toContain('opaca');
    expect(opaque.packets).toBe(snapshot.capture!.frames.length - 1);
    const other = local.snapshot();
    const message = other.capture!.frames.find(
      (v) =>
        v.frame?.packet?.protocol === 'UDP' &&
        v.frame.packet.payload.protocol === 'DHCP' &&
        v.frame.packet.payload.message.type === 'ack'
    )!.frame!.packet!;
    if (
      message.protocol !== 'UDP' ||
      message.payload.protocol !== 'DHCP' ||
      message.payload.message.type !== 'ack'
    )
      throw new Error('ACK ausente.');
    message.payload.message.leaseMs = 8001;
    expect(exportPcap(other).excluded).toHaveLength(1);
    expect(exportPcap(other).excluded[0].reason).toContain('fracionário');
  });
  it('representa BOOTP, xid, chaddr, cookie, máscara, gateway, DNS e timers em bytes conhecidos', () => {
    const bytes = encodeDhcp4(ack),
      d = decodeDhcp4(bytes);
    expect([...bytes.subarray(0, 8)]).toEqual([2, 1, 6, 0, 0x12, 0x34, 0x56, 0x78]);
    expect([...bytes.subarray(236, 240)]).toEqual([99, 130, 83, 99]);
    expect(d).toMatchObject({
      type: 'ack',
      op: 2,
      transactionId: 0x12345678,
      clientMac: identity.clientMac,
      offeredIp: '192.0.2.100',
      clientIp: '0.0.0.0',
      nextServer: '0.0.0.0',
      giaddr: '0.0.0.0',
      broadcast: true,
      prefix: 24,
      routers: ['192.0.2.1'],
      dns: ['192.0.2.53'],
      leaseSeconds: 16,
      renewSeconds: 8,
      rebindSeconds: 14,
    });
    expect(bytes.length).toBe(300);
    expect(d.options.find((v) => v.code === 1)?.data).toEqual([255, 255, 255, 0]);
  });
  it('codifica os sete tipos nativos sem usar siaddr como identificador de servidor', () => {
    const messages: DhcpMessage[] = [
      { ...identity, type: 'discover' },
      { ...ack, type: 'offer' },
      { ...identity, type: 'request', requestedIp: '192.0.2.100', server: '192.0.2.1' },
      { ...identity, type: 'decline', requestedIp: '192.0.2.100', server: '192.0.2.1' },
      ack,
      { ...identity, type: 'nak', clientIp: '192.0.2.100', server: '192.0.2.1' },
      { ...identity, type: 'release', clientIp: '192.0.2.100', server: '192.0.2.1' },
    ];
    for (const [i, m] of messages.entries()) {
      const d = decodeDhcp4(encodeDhcp4(m));
      expect(d.type).toBe(m.type);
      expect(d.options.find((v) => v.code === 53)?.data).toEqual([i + 1]);
      expect(d.nextServer).toBe('0.0.0.0');
      if (m.type === 'nak') {
        expect(d.clientIp).toBe('0.0.0.0');
        expect(d.broadcast).toBe(true);
      }
    }
  });
  it('renovação/rebinding usam ciaddr sem opção 50/54 e relay conserva giaddr/hops/chaddr', () => {
    const request = {
      ...identity,
      type: 'request' as const,
      clientIp: '192.0.2.100',
      requestedIp: '192.0.2.100',
    };
    const renew = decodeDhcp4(encodeDhcp4(request));
    expect(renew).toMatchObject({ clientIp: request.clientIp, broadcast: false });
    expect(renew.requestedIp).toBeUndefined();
    expect(renew.server).toBeUndefined();
    expect(() => encodeDhcp4({ ...request, server: '192.0.2.1' })).toThrow('Server Identifier');
    expect(() => encodeDhcp4({ ...request, requestedIp: '192.0.2.101' })).toThrow('diferentes');
    expect(decodeDhcp4(encodeDhcp4({ ...request, giaddr: '192.0.2.1', hops: 1 }))).toMatchObject({
      giaddr: '192.0.2.1',
      hops: 1,
      clientMac: identity.clientMac,
    });
  });
  it('usa defaults T1/T2 para segundos ímpares e omite leases não representáveis sem quebrar o cálculo de tamanho', () => {
    const d = decodeDhcp4(encodeDhcp4({ ...ack, leaseMs: 9000 }));
    expect(d.leaseSeconds).toBe(9);
    expect(d.renewSeconds).toBeUndefined();
    expect(d.rebindSeconds).toBeUndefined();
    expect(() => encodeDhcp4({ ...ack, leaseMs: 8001 })).toThrow('fracionário');
    expect(dhcp4MessageSize({ ...ack, leaseMs: 8001, transactionId: 'legacy' })).toBe(300);
  });
  it('não transforma identidades opacas ou maiores que uint32 em xids colidentes', () => {
    expect(dhcp4TransactionNumber('dhcp-4294967295')).toBe(0xffffffff);
    for (const id of ['opaque', 'dhcp-01', 'dhcp-1.0', 'dhcp-4294967296', 'dhcp--1'])
      expect(() => encodeDhcp4({ ...ack, transactionId: id })).toThrow('transação');
  });
  it('dimensiona oito DNS, permite padding legado e recusa truncar opções para caber num tamanho falso', () => {
    const m = { ...ack, dns: Array.from({ length: 8 }, (_, i) => '198.51.100.' + (i + 1)) };
    const size = dhcp4MessageSize(m);
    expect(size).toBeGreaterThan(300);
    expect(encodeDhcp4(m)).toHaveLength(size);
    expect(decodeDhcp4(encodeDhcp4(m, size + 20)).dns).toEqual(m.dns);
    expect(() => encodeDhcp4(m, size - 1)).toThrow('tamanho');
    expect(() => encodeDhcp4(m, 65508)).toThrow('tamanho');
  });
  it('reagrupa opções RFC 3396 inclusive nas áreas file/sname de option overload', () => {
    const bytes = raw([53, 1, 5], [52, 1, 3], [6, 2, 192, 0]);
    bytes.set([6, 2, 2, 53, 255], 108);
    bytes.set([3, 4, 192, 0, 2, 1, 255], 44);
    expect(decodeDhcp4(bytes)).toMatchObject({ dns: ['192.0.2.53'], routers: ['192.0.2.1'] });
    expect(decodeDhcp4(raw([53, 1, 5], [222, 3, 1, 2, 3])).type).toBe('ack');
  });
  it('recusa cabeçalhos, TLVs, seletores duplicados, listas e máscaras inválidas', () => {
    expect(() => decodeDhcp4(new Uint8Array(239))).toThrow('truncado');
    const cookie = encodeDhcp4(ack);
    cookie[236] = 0;
    expect(() => decodeDhcp4(cookie)).toThrow('cookie');
    const op = encodeDhcp4(ack);
    op[0] = 1;
    expect(() => decodeDhcp4(op)).toThrow('op BOOTP');
    expect(() => decodeDhcp4(raw([53, 1, 5], [6, 4, 1]))).toThrow('truncado');
    expect(() => decodeDhcp4(raw([53, 1, 5], [53, 1, 5]))).toThrow('comprimento');
    expect(() => decodeDhcp4(raw([53, 1, 5], [6, 1, 1]))).toThrow('lista');
    expect(() => decodeDhcp4(raw([53, 1, 5], [1, 4, 255, 0, 255, 0]))).toThrow('contígua');
    expect(() => decodeDhcp4(encodeDhcp4(ack).subarray(0, 240))).toThrow('END');
    expect(() => decodeDhcp4(raw([53, 1, 5], [52, 1, 4]))).toThrow('overload');
    expect(() => decodeDhcp4(raw([53, 1, 5], [51, 3, 1, 2, 3]))).toThrow('comprimento');
  });
  it('exporta DORA, DECLINE, NAK, RELEASE, T1/T2 e relay reais sem omissões e com tamanhos coerentes', () => {
    const { local, failover, relay } = dhcpCaptureFixtures();
    for (const e of [local, failover, relay]) {
      validateSnapshot(e.snapshot());
      const pcap = exportPcap(e.snapshot());
      expect(pcap.excluded).toEqual([]);
      expect(pcap.dropped).toBe(0);
      const packets = decodePcap(pcap.bytes);
      for (const event of e.state.capture!.frames) {
        const p = event.frame?.packet;
        if (p?.protocol !== 'UDP' || p.payload.protocol !== 'DHCP') continue;
        const wire = encodeEthernet(event.frame!),
          d = decodeEthernet(wire);
        expect(d.transport!.payload.length + 28).toBe(p.bytes);
        expect(d.transport!.dhcp4!.transactionId).toBe(
          dhcp4TransactionNumber(p.payload.message.transactionId)
        );
      }
      expect(packets.length).toBe(pcap.packets);
    }
    const types = new Set(
      decodePcap(exportPcap(local.snapshot()).bytes).flatMap((p) => p.frame.transport?.dhcp4?.type ?? [])
    );
    expect(types).toEqual(new Set(['discover', 'offer', 'request', 'decline', 'ack', 'nak', 'release']));
    const relayed = decodePcap(exportPcap(relay.snapshot()).bytes).filter(
      (p) => p.frame.transport?.dhcp4?.giaddr === '10.0.0.1'
    );
    expect(
      relayed.some((p) => p.frame.transport?.sourcePort === 67 && p.frame.transport.destinationPort === 67)
    ).toBe(true);
    expect(relayed.some((p) => p.frame.src === '192.0.2.3' && p.frame.transport?.dhcp4?.type === 'ack')).toBe(
      true
    );
  });
});
