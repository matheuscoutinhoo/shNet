import { describe, expect, it } from 'vitest';
import {
  SimulationEngine,
  TerminalSession,
  validateSnapshot,
  configurationDiff,
} from '../packages/simulation-engine/src';
import { hsrpMac } from '../packages/simulation-engine/src/protocols/hsrp-model';
import { cloneTopology } from '../apps/web/src/workspace/cloneTopology';
function commands(cli: TerminalSession, lines: string[]) {
  for (const line of lines) expect(cli.execute(line), line).not.toMatch(/^%/);
}
function topology(version: 1 | 2 = 1, third = false) {
  const e = new SimulationEngine(),
    sw = e.addDevice('switch'),
    a = e.addProfile('router'),
    b = e.addProfile('router'),
    pc = e.addDevice('pc');
  e.configureSpanningTree(sw.id, 'off');
  Object.assign(pc.interfaces[0], { ip: '192.0.2.10', prefix: 24 });
  pc.gateway = '192.0.2.254';
  const routers = [a, b, ...(third ? [e.addProfile('router')] : [])],
    terminals = routers.map((d) => new TerminalSession(e, d.id));
  routers.forEach((d, i) => {
    e.connect({ device: sw.id, port: 'p' + i }, { device: d.id, port: 'p0' });
    commands(terminals[i], [
      'en',
      'conf t',
      'interface Gi0/1',
      'standby version ' + version,
      `standby ${version === 1 ? 1 : 4095} ip 192.0.2.254`,
      `ip address 192.0.2.${i + 1} 255.255.255.0`,
      `standby ${version === 1 ? 1 : 4095} priority ${120 - i * 10}`,
      'end',
    ]);
  });
  e.connect({ device: sw.id, port: 'p' + routers.length }, { device: pc.id, port: 'p0' });
  return { e, a, b, pc, routers, terminals, group: version === 1 ? 1 : 4095 };
}
describe('HSRP over simulated UDP', () => {
  it('does not report discovery advertisements or gateway elections as configuration edits', () => {
    const { e, terminals } = topology();
    for (const cli of terminals) commands(cli, ['conf t', 'cdp run', 'lldp run', 'end']);
    const before = e.snapshot();
    e.advanceTo(11000);
    expect(configurationDiff(before, e.snapshot())).toEqual([]);
  });
  it('clones virtual gateways into a new address domain with fresh elections and empty startup', () => {
    const {
      e,
      a,
      pc,
      terminals: [cli],
    } = topology();
    commands(cli, ['conf t', 'enable secret cloned-secret', 'cdp run', 'lldp run', 'end', 'write memory']);
    e.advanceTo(11000);
    const source = e.snapshot(),
      cloned = cloneTopology(
        source,
        source.devices.map((d) => d.id)
      );
    expect(e.snapshot()).toEqual(source);
    const copies = cloned.snapshot.devices.slice(source.devices.length),
      router = copies.find((d) => d.hostname === a.hostname + '-copy')!,
      client = copies.find((d) => d.hostname === pc.hostname + '-copy')!;
    expect(router.enableSecret).toBe(a.enableSecret);
    expect(router.startupConfig).toBeUndefined();
    expect(router.hsrp!.groups[0].vip).not.toBe('192.0.2.254');
    expect(router.discovery!.neighbors).toEqual([]);
    expect(cloned.warnings.join(' ')).toContain('startup-config');
    const restored = new SimulationEngine(cloned.snapshot);
    restored.advanceTo(23000);
    const probe = restored.ping(client.id, router.hsrp!.groups[0].vip!);
    restored.advanceTo(24000);
    expect(restored.state.probes.find((p) => p.id === probe)?.status).toBe('success');
    validateSnapshot(restored.snapshot());
  });
  it.each([1, 2] as const)(
    'elects version %s active/standby and accepts virtual IP/MAC traffic after failure',
    (version) => {
      const { e, a, b, pc, group } = topology(version);
      const outside = e.addDevice('pc');
      Object.assign(outside.interfaces[0], { ip: '198.51.100.10', prefix: 24 });
      outside.gateway = '198.51.100.1';
      Object.assign(b.interfaces[1], { ip: '198.51.100.1', prefix: 24 });
      a.routes.push({ network: '198.51.100.0', prefix: 24, nextHop: '192.0.2.2', metric: 1 });
      e.connect({ device: b.id, port: 'p1' }, { device: outside.id, port: 'p0' });
      e.advanceTo(11000);
      expect(a.hsrp!.groups[0].state).toBe('ACTIVE');
      expect(b.hsrp!.groups[0].state).toBe('STANDBY');
      const before = e.ping(pc.id, '192.0.2.254');
      e.advanceTo(12000);
      expect(e.state.probes.find((p) => p.id === before)?.status).toBe('success');
      expect(pc.arpTable.find((entry) => entry.ip === '192.0.2.254')?.mac).toBe(hsrpMac({ version, group }));
      const transit = e.ping(pc.id, '198.51.100.10');
      e.advanceTo(12500);
      expect(e.state.probes.find((p) => p.id === transit)?.status).toBe('success');
      e.setPort(a.id, 'p0', false);
      e.advanceTo(23000);
      expect(b.hsrp!.groups[0].state).toBe('ACTIVE');
      const after = e.ping(pc.id, '192.0.2.254');
      e.advanceTo(24000);
      expect(e.state.probes.find((p) => p.id === after)?.status).toBe('success');
      const resumed = e.ping(pc.id, '198.51.100.10');
      e.advanceTo(24500);
      expect(e.state.probes.find((p) => p.id === resumed)?.status).toBe('success');
      expect(
        e.state.events.some(
          (event) =>
            event.type === 'FRAME_SENT' &&
            event.frame?.packet?.protocol === 'UDP' &&
            event.frame.packet.payload.protocol === 'HSRP'
        )
      ).toBe(true);
      validateSnapshot(e.snapshot());
    }
  );
  it('keeps the existing active on return unless preemption is enabled', () => {
    const {
      e,
      a,
      b,
      terminals: [cli],
    } = topology();
    e.advanceTo(11000);
    e.setPort(a.id, 'p0', false);
    e.advanceTo(22000);
    expect(b.hsrp!.groups[0].state).toBe('ACTIVE');
    e.setPort(a.id, 'p0', true);
    e.advanceTo(34000);
    expect(b.hsrp!.groups[0].state).toBe('ACTIVE');
    expect(a.hsrp!.groups[0].state).toBe('STANDBY');
    commands(cli, ['conf t', 'interface Gi0/1', 'standby 1 preempt', 'end']);
    e.advanceTo(35000);
    expect(a.hsrp!.groups[0].state).toBe('ACTIVE');
    expect(b.hsrp!.groups[0].state).toBe('STANDBY');
    validateSnapshot(e.snapshot());
  });
  it('elects a replacement standby among three routers and fails over by interface tracking', () => {
    const {
      e,
      a,
      b,
      routers,
      terminals: [acli, bcli],
    } = topology(1, true);
    const peer = e.addDevice('pc');
    e.connect({ device: a.id, port: 'p1' }, { device: peer.id, port: 'p0' });
    commands(acli, ['conf t', 'interface Gi0/1', 'standby 1 track Gi0/2 30', 'end']);
    commands(bcli, ['conf t', 'interface Gi0/1', 'standby 1 preempt', 'end']);
    e.advanceTo(11000);
    expect(routers.map((d) => d.hsrp!.groups[0].state)).toEqual(['ACTIVE', 'STANDBY', 'LISTEN']);
    e.setPort(a.id, 'p1', false);
    e.advanceTo(15000);
    expect(a.hsrp!.groups[0].effectivePriority).toBe(90);
    expect(b.hsrp!.groups[0].state).toBe('ACTIVE');
    e.setPort(a.id, 'p0', false);
    e.advanceTo(27000);
    expect(routers[2].hsrp!.groups[0].state).toBe('STANDBY');
    validateSnapshot(e.snapshot());
  });
  it('saves native configuration, resets election on reload and rejects malformed state', () => {
    const {
      e,
      a,
      terminals: [cli],
    } = topology(2);
    e.advanceTo(11000);
    commands(cli, ['write memory']);
    const restored = new SimulationEngine(e.snapshot()),
      rcli = new TerminalSession(restored, a.id);
    commands(rcli, ['en', 'reload', '', 'en']);
    expect(rcli.execute('show standby')).toContain('Group 4095 (version 2)');
    expect(restored.device(a.id).hsrp!.groups[0].state).toBe('SPEAK');
    validateSnapshot(restored.snapshot());
    const invalid = restored.snapshot();
    invalid.queue = invalid.queue.filter((q) => q.action.kind !== 'hsrp-tick');
    expect(() => validateSnapshot(invalid)).toThrow(/HSRP timer/);
    commands(rcli, ['conf t', 'interface Gi0/1']);
    const before = restored.snapshot();
    expect(rcli.execute('standby 4095 ip 203.0.113.254')).toMatch(/^%/);
    expect(restored.snapshot()).toEqual(before);
  });
});
