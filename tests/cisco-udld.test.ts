import { it, expect } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  makeTemplate,
  type Frame,
} from '../packages/simulation-engine/src';
import { permitDot1x } from '../packages/simulation-engine/src/protocols/dot1x';
const run = (t: TerminalSession, lines: string[]) => {
  for (const c of lines) expect(t.execute(c), c).not.toMatch(/^%/);
};
it.each(['normal', 'aggressive'] as const)(
  'UDLD %s learns echo identities and detects the applicable silent-link failure',
  (mode) => {
    const e = new SimulationEngine(),
      a = e.addProfile('switch-l3'),
      b = e.addProfile('switch-l3');
    e.connect({ device: a.id, port: 'p0' }, { device: b.id, port: 'p0' });
    for (const d of [a, b])
      run(new TerminalSession(e, d.id), [
        'en',
        'conf t',
        'interface Gi0/1',
        'udld port' + (mode === 'aggressive' ? ' aggressive' : ''),
        'end',
      ]);
    e.advanceTo(3000);
    expect(a.interfaces[0].udld?.state).toBe('bidirectional');
    expect(b.interfaces[0].udld?.peers[0].device).toBe(a.id);
    validateSnapshot(e.snapshot());
    const until = e.state.clock + 65000;
    while (e.state.queue[0]?.at <= until) {
      e.state.queue = e.state.queue.filter(
        (q) => !(q.action.kind === 'deliver' && q.action.from === b.id && q.action.frame.udld)
      );
      if (e.state.queue[0]?.at <= until) e.step();
    }
    expect(a.interfaces[0].errDisabled?.reason).toBe(mode === 'aggressive' ? 'udld' : undefined);
    if (mode === 'aggressive') {
      const t = new TerminalSession(e, a.id);
      run(t, ['en', 'udld reset']);
      expect(a.interfaces[0].errDisabled).toBeUndefined();
    }
    validateSnapshot(e.snapshot());
  }
);
it('native UDLD survives startup replay with independent runtime', () => {
  const e = new SimulationEngine(),
    d = e.addProfile('switch-l3'),
    t = new TerminalSession(e, d.id);
  run(t, ['en', 'conf t', 'interface Gi0/1', 'udld port aggressive', 'end', 'write memory', 'reload', '', 'en']);
  expect(e.device(d.id).interfaces[0].udld?.mode).toBe('aggressive');
  expect(e.device(d.id).interfaces[0].udld?.peers).toEqual([]);
  validateSnapshot(e.snapshot());
});
it('native 802.1X controls block and release actual data admission', () => {
  const e = new SimulationEngine(makeTemplate('aaa')),
    sw = e.state.devices.find((d) => d.type === 'switch')!,
    pc = e.state.devices.find((d) => d.type === 'pc')!,
    p = sw.interfaces[0],
    t = new TerminalSession(e, sw.id);
  const f: Frame = {
    src: pc.interfaces[0].mac,
    dst: 'ff:ff:ff:ff:ff:ff',
    etherType: 'ARP',
    hops: 1,
    arp: { kind: 'request', senderMac: pc.interfaces[0].mac, senderIp: '10.10.0.10', targetIp: '10.10.0.1' },
  };
  run(t, ['en', 'conf t', 'dot1x system-auth-control']);
  expect(permitDot1x(e, sw, p, f, 'in')).toBe(false);
  run(t, ['no dot1x system-auth-control']);
  expect(permitDot1x(e, sw, p, f, 'in')).toBe(true);
  run(t, [
    'dot1x system-auth-control',
    'interface ' + p.name,
    'authentication port-control force-unauthorized',
  ]);
  e.advanceTo(3000);
  expect(permitDot1x(e, sw, p, f, 'in')).toBe(false);
  run(t, ['authentication port-control force-authorized']);
  expect(permitDot1x(e, sw, p, f, 'in')).toBe(true);
  validateSnapshot(e.snapshot());
});
