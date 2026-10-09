import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  SimulationEngine,
  decodePcap,
  exportPcap,
  encodeEthernet,
  decodeEthernet,
  encodeDhcp6,
  decodeDhcp6,
  encodeDns,
  type Frame,
} from '../packages/simulation-engine/src';
import { checksum, hex, view } from '../packages/simulation-engine/src/wire/binary';
const frame = (ipv6: Frame['ipv6']): Frame => ({
  src: '02:00:00:00:00:01',
  dst: '33:33:00:01:00:02',
  etherType: 'IPv6',
  hops: 64,
  ipv6,
});
describe('Codecs binários e PCAP', () => {
  it('exporta tráfego real ARP/TCP/HTTP com opções e checksums e preserva tempos virtuais', async () => {
    const e = new SimulationEngine(),
      pc = e.addDevice('pc'),
      server = e.addDevice('server');
    Object.assign(pc.interfaces[0], { ip: '10.0.0.1', prefix: 24 });
    Object.assign(server.interfaces[0], { ip: '10.0.0.2', prefix: 24 });
    e.connect({ device: pc.id, port: 'p0' }, { device: server.id, port: 'p0' });
    for (const d of [pc, server])
      e.configureTcpSettings(d.id, { sack: true, ecn: true, timestamps: true, pmtud: true, mss: 1460 });
    e.configureTcpService(server.id, { kind: 'http', port: 80, enabled: true, body: 'HTTP binário 🌐' });
    e.httpGet(pc.id, '10.0.0.2');
    e.advanceTo(6000);
    const result = exportPcap(e.snapshot()),
      decoded = decodePcap(result.bytes);
    expect(result.excluded).toEqual([]);
    expect(decoded).toHaveLength(result.packets);
    expect(decoded.some((r) => r.frame.arp?.operation === 1)).toBe(true);
    expect(
      decoded.some(
        (r) =>
          r.frame.transport?.flags?.includes('SYN') && r.frame.transport.options?.some((o) => o.kind === 8)
      )
    ).toBe(true);
    expect(
      decoded.some((r) => new TextDecoder().decode(r.frame.transport?.payload).includes('HTTP binário 🌐'))
    ).toBe(true);
    expect(decoded.map((r) => r.time)).toEqual(
      e.state.events.filter((v) => v.type === 'FRAME_SENT').map((v) => Math.floor(v.time * 1000) / 1000)
    );
    await mkdir('.data/captures', { recursive: true });
    await writeFile('.data/captures/http.pcap', result.bytes);
    const corrupt = decoded.find((r) => r.frame.protocol === 6)!.raw.slice();
    corrupt[corrupt.length - 1] ^= 1;
    expect(() => decodeEthernet(corrupt)).toThrow('Checksum');
    expect(() => decodePcap(result.bytes.subarray(0, result.bytes.length - 1))).toThrow('truncado');
    const vlan = e.state.events.find((v) => v.frame?.arp)!.frame!;
    const tagged = decodeEthernet(encodeEthernet({ ...vlan, vlan: 100 }));
    expect(tagged.vlan).toBe(100);
    expect(tagged.arp?.targetIp).toBe(vlan.arp!.targetIp);
  });
  it('codifica IA_NA/IA_PD, DNS, lifetimes e dois headers de relay DHCPv6 e rejeita opções truncadas', async () => {
    const message = {
        type: 'REPLY' as const,
        transactionId: 0x123456,
        clientId: '00030001020000000001',
        serverId: '00030001020000000002',
        iaid: 7,
        requestAddress: true,
        requestPrefix: true,
        address: '2001:db8:1::100',
        delegatedPrefix: '2001:db8:100::',
        prefixLength: 64,
        preferredMs: 45000,
        validMs: 60000,
        t1Ms: 20000,
        t2Ms: 40000,
        dns: ['2001:db8:2::53'],
        status: 'Success' as const,
      },
      relay = {
        type: 'RELAY-REPL' as const,
        hops: [
          { hopCount: 1, linkAddress: '2001:db8:2::1', peerAddress: '2001:db8:2::2', interfaceId: 'p0' },
          { hopCount: 0, linkAddress: '2001:db8:1::1', peerAddress: 'fe80::1', interfaceId: 'p1' },
        ],
        message,
      };
    const bytes = encodeDhcp6(relay);
    expect(bytes[0]).toBe(13);
    expect(decodeDhcp6(bytes)).toEqual(relay);
    expect(() => decodeDhcp6(bytes.subarray(0, bytes.length - 1))).toThrow('truncado');
    const circular = bytes.slice();
    view(circular).setUint16(36, 65535);
    expect(() => decodeDhcp6(circular)).toThrow('truncado');
    const wire = encodeEthernet(
      frame({
        src: '2001:db8:2::53',
        dst: '2001:db8:2::1',
        protocol: 'UDP',
        kind: 'udp',
        hopLimit: 64,
        bytes: 48 + bytes.length,
        datagram: { sourcePort: 547, destinationPort: 547, payload: { protocol: 'DHCPv6-RELAY', relay } },
      })
    );
    expect(decodeEthernet(wire).transport?.dhcp6).toEqual(relay);
    await mkdir('.data/captures', { recursive: true });
    await writeFile('.data/captures/relay.ethernet', wire);
  });
  it('gera DNS conforme fixture independente e ND/ICMPv6 com checksum; omite envelopes sem codec', async () => {
    const query = {
      type: 'query' as const,
      transactionId: 0x1234,
      question: { name: 'www.example.com', type: 'A' as const },
      recursionDesired: true,
    };
    expect(Buffer.from(encodeDns(query)).toString('hex')).toBe(
      '12340100000100000000000003777777076578616d706c6503636f6d0000010001'
    );
    expect(checksum(hex('0001f203f4f5f6f7'))).toBe(0x220d);
    const nd = encodeEthernet(
      frame({
        src: 'fe80::1',
        dst: 'ff02::1:ff00:2',
        protocol: 'ICMPv6',
        kind: 'ns',
        hopLimit: 255,
        bytes: 72,
        target: '2001:db8::2',
        mac: '02:00:00:00:00:01',
      })
    );
    expect(decodeEthernet(nd)).toMatchObject({ family: 6, protocol: 58, ttl: 255 });
    expect(decodeEthernet(nd).transport!.payload[0]).toBe(135);
    const dns = encodeEthernet({
      src: '02:00:00:00:00:01',
      dst: '02:00:00:00:00:02',
      etherType: 'IPv4',
      hops: 64,
      packet: {
        src: '192.0.2.1',
        dst: '192.0.2.53',
        ttl: 64,
        protocol: 'UDP',
        sourcePort: 50000,
        destinationPort: 53,
        bytes: 28 + encodeDns(query).length,
        payload: { protocol: 'DNS', message: query },
      },
    });
    expect(decodeEthernet(dns).transport?.destinationPort).toBe(53);
    await mkdir('.data/captures', { recursive: true });
    await writeFile('.data/captures/dns.ethernet', dns);
    await writeFile('.data/captures/nd.ethernet', nd);
    const e = new SimulationEngine();
    e.state.events.push({
      id: 'excluded',
      time: 0,
      type: 'FRAME_SENT',
      device: 'test',
      reason: 'fixture',
      frame: {
        src: '02:00:00:00:00:01',
        dst: '02:00:00:00:00:02',
        etherType: 'IPv4',
        hops: 64,
        fragment: {
          src: '192.0.2.1',
          dst: '192.0.2.2',
          ttl: 64,
          protocol: 'TCP',
          identification: 1,
          offset: 0,
          more: false,
          data: [0],
          bytes: 21,
        },
      },
    });
    expect(exportPcap(e.snapshot()).excluded).toHaveLength(1);
    expect(exportPcap(e.snapshot()).packets).toBe(0);
  });
});
