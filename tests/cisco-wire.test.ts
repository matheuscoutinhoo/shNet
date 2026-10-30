import { describe, it, expect } from 'vitest';
import { SimulationEngine, makeTemplate, exportPcap, decodePcap } from '../packages/simulation-engine/src';
import {
  encodeOspfLsa,
  decodeOspf,
  encodeOspf,
  ospfHeaderWire,
} from '../packages/simulation-engine/src/wire/ospf-codec';
import { encodeHsrp, decodeHsrp } from '../packages/simulation-engine/src/wire/hsrp-codec';
import type { OspfLsa, OspfMessage } from '../packages/simulation-engine/src/protocols/ospf-model';
describe('Cisco control-plane PCAP', () => {
  it('exports the actual OSPF exchange without codec omissions', () => {
    const e = new SimulationEngine(makeTemplate('ospf'));
    e.state.capture = { frames: [], dropped: 0, includeControl: true, startedAt: 0 };
    e.advanceTo(15000);
    const capture = exportPcap(e.snapshot());
    expect(capture.excluded).toEqual([]);
    const packets = decodePcap(capture.bytes);
    expect(packets.filter((p) => p.frame.ospf).length).toBeGreaterThan(5);
    expect(new Set(packets.flatMap((p) => (p.frame.ospf ? [p.frame.ospf.type] : [])))).toEqual(
      new Set([1, 2, 3, 4, 5])
    );
  });
  it('validates LSA and packet checksums and all packet types', () => {
    const lsa: OspfLsa = {
      type: 'router',
      area: 0,
      id: '1.1.1.1',
      advertisingRouter: '1.1.1.1',
      sequence: 1,
      originatedAt: 0,
      withdrawn: false,
      links: [{ kind: 'router', id: '2.2.2.2', cost: 10 }],
      prefixes: [{ network: '192.0.2.0', prefix: 24, cost: 1 }],
    };
    expect(encodeOspfLsa(lsa).length).toBe(48);
    const h = { key: '0:router:1.1.1.1:1.1.1.1', sequence: 1, wire: ospfHeaderWire(lsa) };
    const messages: OspfMessage[] = [
      {
        type: 'hello',
        prefix: 24,
        helloMs: 10000,
        deadMs: 40000,
        priority: 1,
        dr: '0.0.0.0',
        bdr: '0.0.0.0',
        neighbors: [],
        networkType: 'point-to-point',
      },
      { type: 'database', exchange: 'test', page: 0, pages: 1, reply: false, mtu: 1500, headers: [h] },
      { type: 'request', headers: [h] },
      { type: 'update', lsa, flush: false },
      { type: 'ack', header: h },
    ];
    for (const [i, message] of messages.entries()) {
      const b = encodeOspf({
        protocol: 'OSPF',
        src: '192.0.2.1',
        dst: '224.0.0.5',
        ttl: 1,
        routerId: '1.1.1.1',
        area: 0,
        message,
        bytes: 128,
      });
      expect(decodeOspf(b).type).toBe(i + 1);
      b[b.length - 1] ^= 1;
      expect(() => decodeOspf(b)).toThrow('checksum');
    }
  });
  it.each([1, 2] as const)('encodes HSRPv%s wire headers and rejects truncation', (version) => {
    const m = {
      version,
      group: version === 1 ? 10 : 4095,
      opcode: 'hello' as const,
      state: 'ACTIVE' as const,
      priority: 120,
      helloMs: 3000,
      holdMs: 10000,
      vip: '192.0.2.254',
    };
    const b = encodeHsrp(m, '02:00:00:00:00:01');
    expect(b.length).toBe(version === 1 ? 20 : 42);
    expect(decodeHsrp(b)).toEqual(m);
    expect(() => decodeHsrp(b.subarray(0, 12))).toThrow();
  });
});
