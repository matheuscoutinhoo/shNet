import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  exportPcap,
  decodePcap,
} from '../packages/simulation-engine/src';
import {
  encodeOspf,
  verifyOspfMd5,
  decodeOspf,
  ospfMd5Digest,
} from '../packages/simulation-engine/src/wire/ospf-codec';
import type { OspfPacket } from '../packages/simulation-engine/src/protocols/ospf-model';
it('uses RFC 2328 keyed MD5 with a 16-byte trailer outside Packet Length', () => {
  const p: OspfPacket = {
    protocol: 'OSPF',
    src: '192.0.2.1',
    dst: '224.0.0.5',
    ttl: 1,
    routerId: '1.1.1.1',
    area: 0,
    bytes: 80,
    sentAt: 0,
    authentication: { algorithm: 'md5', keyId: 7, sequence: 123, digest: '00'.repeat(16) },
    message: {
      type: 'hello',
      prefix: 30,
      helloMs: 10000,
      deadMs: 40000,
      priority: 1,
      dr: '0.0.0.0',
      bdr: '0.0.0.0',
      neighbors: [],
      networkType: 'point-to-point',
    },
  };
  p.authentication!.digest = ospfMd5Digest(p, 'secret');
  const b = encodeOspf(p),
    length = (b[2] << 8) | b[3],
    key = Buffer.alloc(16);
  key.write('secret');
  expect(Buffer.from(b.subarray(length)).toString('hex')).toBe(
    createHash('md5').update(b.subarray(0, length)).update(key).digest('hex')
  );
  expect(b.length).toBe(length + 16);
  expect(decodeOspf(b).authentication).toEqual({ type: 2, keyId: 7, sequence: 123 });
  expect(verifyOspfMd5(b, 'secret')).toBe(true);
  expect(verifyOspfMd5(b, 'wrong')).toBe(false);
  b[31] ^= 1;
  expect(verifyOspfMd5(b, 'secret')).toBe(false);
});
it('forms only matching native MD5 adjacencies, exports capture and reloads keys', () => {
  const e = new SimulationEngine(),
    a = e.addProfile('router'),
    b = e.addProfile('router');
  e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
  const configure = (id: string, ip: string, key?: string, keyId = 1) => {
    const t = new TerminalSession(e, id);
    for (const c of [
      'en',
      'conf t',
      'interface Gi0/1',
      `ip address ${ip} 255.255.255.252`,
      'ip ospf authentication message-digest',
      ...(key ? [`ip ospf message-digest-key ${keyId} md5 ${key}`] : []),
      'ip ospf 1 area 0',
      'ip ospf network point-to-point',
      'end',
    ])
      expect(t.execute(c), c).not.toMatch(/^%/);
    return t;
  };
  const at = configure(a.id, '192.0.2.1', 'matching'),
    bt = configure(b.id, '192.0.2.2', 'wrong');
  e.advanceTo(15000);
  expect(a.ospf!.neighbors.filter((n) => n.state === 'Full')).toHaveLength(0);
  for (const c of ['conf t', 'interface Gi0/1', 'ip ospf message-digest-key 1 md5 matching', 'end'])
    expect(bt.execute(c), c).not.toMatch(/^%/);
  e.state.capture = { frames: [], dropped: 0, includeControl: true, startedAt: e.state.clock };
  e.advanceTo(40000);
  expect(a.ospf!.neighbors.some((n) => n.state === 'Full')).toBe(true);
  const capture = exportPcap(e.snapshot());
  expect(capture.excluded).toEqual([]);
  expect(decodePcap(capture.bytes).some((p) => p.frame.ospf?.authentication?.keyId === 1)).toBe(true);
  expect(at.history.join('\n')).not.toContain('md5 matching');
  expect(at.execute('write memory')).toContain('[OK]');
  expect(at.execute('reload')).not.toMatch(/^%/);
  expect(at.execute('')).toBe('Reload complete.');
  expect(e.device(a.id).interfaces[0].ospfAuthentication?.key).toBe('matching');
  validateSnapshot(e.snapshot());
});
