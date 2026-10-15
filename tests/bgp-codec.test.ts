import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  SimulationEngine,
  makeTemplate,
  validateSnapshot,
  bgpConfig,
  exportPcap,
  decodePcap,
} from '../packages/simulation-engine/src';
import {
  bgpByteString,
  bgpFrameLength,
  decodeBgp,
  encodeBgp,
  bgpOctets,
} from '../packages/simulation-engine/src/protocols/bgp-codec';
import type { BgpMessage, BgpPath } from '../packages/simulation-engine/src/protocols/bgp-model';
import { vxlanConfigSchema } from '../packages/simulation-engine/src/protocols/vxlan-model';
import { concat, hex, view } from '../packages/simulation-engine/src/wire/binary';

const path: BgpPath = {
  network: '203.0.113.0',
  prefix: 24,
  nextHop: '192.0.2.1',
  asPath: [4200000001, 65001],
  origin: 'IGP',
  localPref: 250,
  med: 20,
  originatorId: '10.0.0.1',
  clusterList: ['10.0.0.2'],
};
const mac = {
  vni: 16777215,
  mac: '02:aa:bb:cc:dd:ff',
  ip: '10.10.0.1',
  sequence: 0x80000001,
  routeTarget: '4200000001:65535',
  nextHop: '192.0.2.1',
  asPath: [4200000001],
};
const imet = { vni: mac.vni, routeTarget: mac.routeTarget, nextHop: mac.nextHop, asPath: mac.asPath };
const update = (
  fields: Partial<Extract<BgpMessage, { type: 'UPDATE' }>> = {}
): Extract<BgpMessage, { type: 'UPDATE' }> => ({
  type: 'UPDATE',
  announcements: [],
  withdrawn: [],
  ...fields,
});

describe('BGP/EVPN binário', () => {
  it('usa vetores fixos para KEEPALIVE e OPEN AS4/MP, sem JSON no transporte', () => {
    expect(encodeBgp({ type: 'KEEPALIVE' })[0]).toEqual(hex('ffffffffffffffffffffffffffffffff001304'));
    const open = {
      type: 'OPEN' as const,
      version: 4 as const,
      asn: 4200000001,
      holdMs: 90000,
      routerId: '192.0.2.1',
      evpn: true,
    };
    const wire = hex(
      'ffffffffffffffffffffffffffffffff002b01045ba0005ac00002010e020c4104fa56ea01010400190046'
    );
    expect(encodeBgp(open)[0]).toEqual(wire);
    expect(decodeBgp(wire)).toEqual(open);
    for (const end of [0, 1, 15, 16, 18]) expect(bgpFrameLength(wire.subarray(0, end))).toBeUndefined();
    expect(bgpFrameLength(wire.subarray(0, 19))).toBe(43);
    expect(() => decodeBgp(wire.subarray(0, 42))).toThrow();
  });
  it('separa atributos de rotas distintas e preserva AS32, RR, default e /25', () => {
    const second = { ...path, network: '198.51.100.128', prefix: 25, nextHop: '192.0.2.2', asPath: [] };
    const frames = encodeBgp(
      update({ announcements: [path, second], withdrawn: [{ network: '0.0.0.0', prefix: 0 }] })
    );
    expect(frames).toHaveLength(3);
    expect(decodeBgp(frames[0])).toEqual(update({ withdrawn: [{ network: '0.0.0.0', prefix: 0 }] }));
    expect(decodeBgp(frames[1])).toEqual(update({ announcements: [path] }));
    expect(decodeBgp(frames[2])).toEqual(update({ announcements: [second] }));
    expect(decodeBgp(encodeBgp(update({ announcements: [path] }), { internal: false })[0])).toEqual(
      update({ announcements: [{ ...path, localPref: 100 }] })
    );
    expect(decodeBgp(encodeBgp({ type: 'NOTIFICATION', code: 2, reason: 'ASN inválido' })[0])).toEqual({
      type: 'NOTIFICATION',
      code: 2,
      reason: 'ASN inválido',
    });
  });
  it('codifica MAC/IP, mobilidade, RT32 e IMET/PMSI no VNI máximo', () => {
    const frames = encodeBgp(update({ evpnAnnouncements: [mac], evpnImet: [imet] }));
    expect(frames.map(decodeBgp)).toEqual([
      update({ evpnAnnouncements: [mac] }),
      update({ evpnImet: [imet] }),
    ]);
    const smallRt = { ...mac, routeTarget: '65000:4294967295' };
    expect(decodeBgp(encodeBgp(update({ evpnAnnouncements: [smallRt] }))[0])).toEqual(
      update({ evpnAnnouncements: [smallRt] })
    );
    const { ip: _, ...macOnly } = mac;
    expect(decodeBgp(encodeBgp(update({ evpnAnnouncements: [macOnly] }))[0])).toEqual(
      update({ evpnAnnouncements: [macOnly] })
    );
  });
  it('retira o NLRI anterior completo e retira IMET sem inventar atributos ausentes', () => {
    const frames = encodeBgp(
      update({ evpnWithdrawn: [{ vni: mac.vni, mac: mac.mac }], evpnImetWithdrawn: [imet] }),
      { withdrawnEvpn: [mac] }
    );
    expect(decodeBgp(frames[0])).toEqual(
      update({
        evpnWithdrawn: [{ vni: mac.vni, mac: mac.mac }],
        evpnImetWithdrawn: [{ vni: imet.vni, nextHop: imet.nextHop }],
      })
    );
    // The old IP participates in the wire key and must be withdrawn before
    // advertising another IP for the same modeled MAC.
    expect(frames[0].some((_, i) => Array.from(frames[0].subarray(i, i + 4)).join('.') === mac.ip)).toBe(
      true
    );
    const changed = { ...mac, ip: '10.10.0.2' };
    expect(
      encodeBgp(update({ evpnAnnouncements: [changed] }), { withdrawnEvpn: [mac] }).map(decodeBgp)
    ).toEqual([
      update({ evpnWithdrawn: [{ vni: mac.vni, mac: mac.mac }] }),
      update({ evpnAnnouncements: [changed] }),
    ]);
    expect(() => encodeBgp(update({ evpnWithdrawn: [{ vni: 10, mac: mac.mac }] }))).toThrow('anteriormente');
  });
  it('recusa marker, tamanho, flags, NLRI, capacidades e atributos truncados', () => {
    const keep = encodeBgp({ type: 'KEEPALIVE' })[0];
    const marker = keep.slice();
    marker[0] = 0;
    expect(() => bgpFrameLength(marker.subarray(0, 1))).toThrow('Marker');
    for (const size of [18, 20, 4097]) {
      const bad = keep.slice();
      view(bad).setUint16(16, size);
      expect(() => bgpFrameLength(bad)).toThrow();
    }
    const open = encodeBgp({ type: 'OPEN', version: 4, asn: 65000, holdMs: 3000, routerId: '192.0.2.1' })[0];
    open[32] = 3;
    expect(() => decodeBgp(open)).toThrow();
    const wire = encodeBgp(update({ announcements: [path] }))[0];
    for (let end = 19; end < wire.length; end++) expect(() => decodeBgp(wire.subarray(0, end))).toThrow();
    const flags = wire.slice();
    flags[23] = 128;
    expect(() => decodeBgp(flags)).toThrow('flags');
    const prefix = encodeBgp(
      update({ announcements: [{ ...path, network: '198.51.100.128', prefix: 25 }] })
    )[0];
    prefix[prefix.length - 1] |= 1;
    expect(() => decodeBgp(prefix)).toThrow('canônicos');
    const config = {
      vni: 10,
      vlan: 10,
      enabled: true,
      underlay: 'p0',
      peers: [],
      evpn: true,
      routeTarget: '4294967295:4294967295',
      mtu: 1450,
    };
    expect(vxlanConfigSchema.safeParse(config).success).toBe(false);
    expect(vxlanConfigSchema.parse({ ...config, routeTarget: '0065000:00010' }).routeTarget).toBe('65000:10');
    expect(() => encodeBgp(update({ announcements: [{ ...path, network: '203.0.113.1' }] }))).toThrow(
      'canônica'
    );
  });
  it('recusa EVPN truncado e VNI/ESI/next-hop incompatíveis', () => {
    const wire = encodeBgp(update({ evpnAnnouncements: [mac] }))[0];
    const esi = wire.slice();
    esi[esi.length - 37 + 8] = 1;
    expect(() => decodeBgp(esi)).toThrow();
    const vni = wire.slice();
    vni[vni.length - 1] ^= 1;
    expect(() => decodeBgp(vni)).toThrow('VNI');
    const pmsi = encodeBgp(update({ evpnImet: [imet] }))[0];
    pmsi[pmsi.length - 1] ^= 1;
    expect(() => decodeBgp(pmsi)).toThrow();
  });
  it('negocia AS32 e preserva TCP binário parcial, timers e RIB ao restaurar', () => {
    const e = new SimulationEngine(makeTemplate('bgp'));
    for (const d of e.state.devices.filter((d) => d.bgp)) {
      const c = bgpConfig(d)!;
      c.asn += 4200000000 - 65000;
      for (const n of c.neighbors) n.remoteAs += 4200000000 - 65000;
      e.configureBgp(d.id, c);
      e.configureTcpSettings(d.id, { sack: true, ecn: false, timestamps: true, pmtud: false, mss: 64 });
    }
    e.advanceTo(1005);
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(16000);
    restored.advanceTo(16000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    for (const d of e.state.devices.filter((d) => d.bgp)) {
      expect(d.bgp!.peers.every((p) => p.state === 'Established')).toBe(true);
      expect(d.tcpConnections?.filter((c) => c.service === 'bgp').every((c) => c.encoding === 'binary')).toBe(
        true
      );
    }
    validateSnapshot(e.snapshot());
  });
  it('exporta sessões reais BGP/EVPN com sequência TCP e checksums, incluindo retiradas IMET', async () => {
    await mkdir('.data/captures', { recursive: true });
    for (const template of ['bgp', 'evpn'] as const) {
      const e = new SimulationEngine(makeTemplate(template));
      if (template === 'bgp') {
        for (const d of e.state.devices.filter((d) => d.bgp)) {
          const c = bgpConfig(d)!;
          c.asn += 4200000000 - 65000;
          for (const n of c.neighbors) n.remoteAs += 4200000000 - 65000;
          e.configureBgp(d.id, c);
        }
      }
      e.advanceTo(15000);
      if (template === 'evpn') {
        const pc = e.state.devices.find((d) => d.hostname === 'VM-A')!;
        e.ping(pc.id, '10.50.0.20');
        e.advanceTo(18000);
        const vtep = e.state.devices.find((d) => d.hostname === 'VTEP-A')!;
        const session = vtep.bgp!.peers[0];
        const member = session.evpnImetAdvertised![0];
        const learned = session.evpnAdvertised![0];
        // Exercise real MP_UNREACH without resetting TCP/BGP via configureVxlan.
        e.writeTcp(
          vtep.id,
          session.connection!,
          encodeBgp(
            update({
              evpnImetWithdrawn: [member],
              evpnWithdrawn: [{ vni: learned.vni, mac: learned.mac }],
            }),
            { withdrawnEvpn: session.evpnAdvertised }
          )
            .map(bgpByteString)
            .join('')
        );
        e.advanceTo(21000);
        const peer = e.state.devices.find((d) => d.hostname === 'VTEP-B')!;
        expect(peer.interfaces.find((p) => p.vxlan)!.vxlan?.members ?? []).toEqual([]);
        expect(peer.bgp!.peers[0].state).toBe('Established');
      } else {
        const router = e.state.devices.find((d) => d.bgp?.asn === 4200000003)!;
        e.setPort(router.id, 'p2', false);
        e.advanceTo(20000);
      }
      const capture = exportPcap(e.snapshot());
      expect(capture.excluded).toEqual([]);
      const decoded = decodePcap(capture.bytes);
      expect(decoded).toHaveLength(capture.packets);
      expect(decoded.some((r) => r.frame.transport?.payload?.[0] === 255)).toBe(true);
      await writeFile(`.data/captures/${template}-binary.pcap`, capture.bytes);
      await writeFile(
        `.data/captures/${template}-binary.json`,
        JSON.stringify({ packets: capture.packets, excluded: capture.excluded, dropped: capture.dropped })
      );
      validateSnapshot(e.snapshot());
    }
  });
  it('preserva sessões legadas sem reescrever sequência TCP ou inventar PCAP binário', () => {
    const e = new SimulationEngine(makeTemplate('bgp'));
    e.advanceTo(15500);
    // A quiescent legacy snapshot has text encoding and empty stream buffers.
    // Cumulative TCP sequence/counters remain untouched across restoration.
    for (const d of e.state.devices)
      for (const c of d.tcpConnections ?? []) {
        if (c.service !== 'bgp') continue;
        expect(c.sendBuffer).toBe('');
        expect(c.received).toBe('');
        delete c.encoding;
      }
    const restored = new SimulationEngine(e.snapshot());
    e.advanceTo(60000);
    restored.advanceTo(60000);
    expect(restored.snapshot()).toEqual(e.snapshot());
    expect(
      e.state.devices.filter((d) => d.bgp).every((d) => d.bgp!.peers.every((p) => p.state === 'Established'))
    ).toBe(true);
    expect(exportPcap(e.snapshot()).excluded.some((entry) => entry.reason.includes('BGP legado'))).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('encerra sessão com framing binário inválido e retira rotas do peer', () => {
    const e = new SimulationEngine(makeTemplate('bgp'));
    e.advanceTo(15500);
    const c = e.state.devices.find((d) => d.bgp?.asn === 65003)!;
    const a = e.state.devices.find((d) => d.bgp?.asn === 65001)!;
    const peer = c.bgp!.peers.find((p) => p.ip === '10.0.13.1')!;
    e.writeTcp(c.id, peer.connection!, '\0');
    e.advanceTo(15600);
    expect(a.bgp!.peers.find((p) => p.ip === '10.0.13.3')?.state).not.toBe('Established');
    expect(a.bgp!.rib.some((p) => p.peer === '10.0.13.3')).toBe(false);
    expect(e.state.events.some((event) => event.reason.includes('Framing ou mensagem BGP'))).toBe(true);
    validateSnapshot(e.snapshot());
  });
  it('mantém delimitadores binários mesmo quando TCP divide ou concatena mensagens', () => {
    const frames = encodeBgp(update({ announcements: [path, { ...path, nextHop: '192.0.2.2' }] }));
    const stream = bgpByteString(concat(...frames));
    let pending = '',
      offset = 0;
    const decoded: BgpMessage[] = [];
    for (const chunk of [stream.slice(0, 7), stream.slice(7, 39), stream.slice(39)]) {
      pending += chunk;
      while (pending.length) {
        const length = bgpFrameLength(bgpOctets(pending));
        if (!length || pending.length < length) break;
        decoded.push(decodeBgp(bgpOctets(pending.slice(0, length))));
        offset += length;
        pending = pending.slice(length);
      }
    }
    expect(decoded).toHaveLength(2);
    expect(offset).toBe(stream.length);
    expect(pending).toBe('');
  });
});
